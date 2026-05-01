import type { FlowlearnClient } from "./client.js";
import { HELP_TOPICS, type HelpTopic } from "./tools/help.js";

/**
 * MCP resource layer for flowlearn-mcp.
 *
 * URI scheme:
 *   flowlearn://docs/{topic}            static reference pages
 *   flowlearn://tenant/current          active tenant info
 *   flowlearn://course/{id}             full course tree (modules array)
 *   flowlearn://lesson/{id}             lesson + flow steps + connections
 *
 * Why resources matter: tools are model-invoked actions; resources are
 * model-or-user-readable context. The same course tree returned by
 * flowlearn_course_get is also exposed as flowlearn://course/{id} so the
 * client can attach it to context, embed in another tool's response, or
 * dereference a resource_link without spending a tool call.
 */

export type ResourceTemplate = {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
};

export type Resource = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type ResourceContent = {
  uri: string;
  mimeType: string;
  text: string;
};

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: "flowlearn://docs/{topic}",
    name: "Reference docs",
    description:
      "Static reference: overview / publishing / enums / troubleshooting. Same content as the flowlearn_help tool, exposed as resources for clients that prefer reading over calling.",
    mimeType: "text/markdown",
  },
  {
    uriTemplate: "flowlearn://course/{id}",
    name: "Course tree",
    description:
      "Full course tree as JSON: course metadata + modules array. Equivalent to flowlearn_course_get but addressable as a resource (no tool-call round trip).",
    mimeType: "application/json",
  },
  {
    uriTemplate: "flowlearn://lesson/{id}",
    name: "Lesson with flow",
    description:
      "Lesson metadata + the lesson's flow steps and connections in one document.",
    mimeType: "application/json",
  },
];

/** Concrete (non-templated) resources surfaced in resources/list. */
export function listConcreteResources(): Resource[] {
  const docs: Resource[] = (Object.keys(HELP_TOPICS) as HelpTopic[]).map(
    (topic) => ({
      uri: `flowlearn://docs/${topic}`,
      name: `flowlearn docs: ${topic}`,
      description: `${topic} reference page (markdown).`,
      mimeType: "text/markdown",
    }),
  );
  return [
    ...docs,
    {
      uri: "flowlearn://tenant/current",
      name: "Active tenant",
      description:
        "Active tenant identity, role, and recent courses. Same payload as flowlearn_setup_status.entity.",
      mimeType: "application/json",
    },
  ];
}

/** Read a resource by URI. Returns one or more text contents. */
export async function readResource(
  client: FlowlearnClient,
  uri: string,
): Promise<ResourceContent[]> {
  const parsed = parseFlowlearnUri(uri);
  if (!parsed) {
    throw new ResourceNotFoundError(`Not a flowlearn:// URI: ${uri}`);
  }

  switch (parsed.kind) {
    case "docs": {
      const topic = parsed.id as HelpTopic;
      const md = HELP_TOPICS[topic];
      if (!md) {
        throw new ResourceNotFoundError(
          `Unknown docs topic '${topic}'. Valid: ${Object.keys(HELP_TOPICS).join(", ")}.`,
        );
      }
      return [{ uri, mimeType: "text/markdown", text: md }];
    }

    case "tenant": {
      if (parsed.id !== "current") {
        throw new ResourceNotFoundError(
          `Only 'current' is supported for flowlearn://tenant/{id}.`,
        );
      }
      const cfg = client.getConfig();
      const memberships = await client
        .request<{ memberships?: unknown[] }>("/api/register/memberships")
        .then((d) => d.memberships ?? []);
      const payload = {
        email: cfg.email,
        active_tenant_slug: cfg.tenantSlug,
        memberships,
      };
      return [
        { uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) },
      ];
    }

    case "course": {
      const data = await client.request<unknown>(`/api/courses/${parsed.id}`);
      return [
        { uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) },
      ];
    }

    case "lesson": {
      const [lesson, steps] = await Promise.all([
        client.request<unknown>(`/api/lessons/${parsed.id}`),
        client.request<unknown>(`/api/lessons/${parsed.id}/flow-steps`),
      ]);
      const payload = { lesson, flow_steps: steps };
      return [
        { uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) },
      ];
    }
  }
}

/** Argument completion for resource templates. */
export async function completeResourceArgument(
  client: FlowlearnClient,
  templateUri: string,
  argName: string,
  partialValue: string,
): Promise<{ values: string[]; total?: number; hasMore?: boolean }> {
  // flowlearn://docs/{topic}
  if (templateUri === "flowlearn://docs/{topic}" && argName === "topic") {
    const all = Object.keys(HELP_TOPICS);
    const matches = all.filter((t) => t.startsWith(partialValue.toLowerCase()));
    return { values: matches, total: matches.length, hasMore: false };
  }

  // flowlearn://course/{id} — list courses, return ids matching prefix
  if (templateUri === "flowlearn://course/{id}" && argName === "id") {
    try {
      const data = await client.request<unknown>("/api/courses");
      const arr = (Array.isArray(data) ? data : (data as { courses?: unknown[] })?.courses ?? []) as Record<string, unknown>[];
      const ids = arr
        .map((c) => String(c.id ?? ""))
        .filter((id) => id && id.startsWith(partialValue))
        .slice(0, 100);
      return { values: ids, total: ids.length, hasMore: false };
    } catch {
      return { values: [], total: 0, hasMore: false };
    }
  }

  // flowlearn://lesson/{id} — no cheap server endpoint to enumerate every
  // lesson; return empty rather than make many requests.
  return { values: [], total: 0, hasMore: false };
}

type ParsedUri =
  | { kind: "docs"; id: string }
  | { kind: "tenant"; id: string }
  | { kind: "course"; id: string }
  | { kind: "lesson"; id: string };

function parseFlowlearnUri(uri: string): ParsedUri | null {
  const m = /^flowlearn:\/\/(docs|tenant|course|lesson)\/(.+)$/.exec(uri);
  if (!m) return null;
  const kind = m[1] as ParsedUri["kind"];
  const id = decodeURIComponent(m[2]);
  return { kind, id };
}

export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}
