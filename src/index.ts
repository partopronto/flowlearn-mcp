#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { loadConfig } from "./config.js";
import { FlowlearnClient, FlowlearnApiError } from "./client.js";
import { errorResult, type ToolDef } from "./tools/common.js";
import { buildCourseTools } from "./tools/course.js";
import { buildModuleTools } from "./tools/module.js";
import { buildLessonTools } from "./tools/lesson.js";
import { buildFlowStepTools } from "./tools/flowStep.js";
import { buildConnectionTools } from "./tools/connection.js";
import { buildSetupTools } from "./tools/setup.js";
import { buildHelpTools } from "./tools/help.js";
import { buildCourseOutlineTools } from "./tools/courseOutline.js";
import { buildCourseLintTools } from "./tools/courseLint.js";
import {
  RESOURCE_TEMPLATES,
  ResourceNotFoundError,
  completeResourceArgument,
  listConcreteResources,
  readResource,
} from "./resources.js";
import { PROMPTS, PromptNotFoundError, getPrompt } from "./prompts.js";

const SERVER_INSTRUCTIONS = `flowlearn-mcp wraps the flowlearn.io course-creation API. Conventions:

- Tools are flowlearn_<resource>_<verb> snake_case. Hierarchy: tenant → course → module → lesson → flow_step (+ connection edges).
- Mutations return { entity, summary, url?, resource_uri?, next_actions? }; lists return { items, total, next_cursor, has_more, summary }.
- Errors are structured: { code, message, suggestion?, retriable, details? }.
- Every *_create accepts client_request_id for idempotent retries; every destructive tool accepts dry_run=true.
- Resources: flowlearn://course/{id}, flowlearn://lesson/{id}, flowlearn://docs/{topic}, flowlearn://tenant/current.
- Prompts (slash commands): scaffold_course, audit_course, import_markdown.
- Start a fresh session with flowlearn_setup_status (or read flowlearn://tenant/current).
- Server-side AI is intentionally NOT exposed — the agent generates content; this server only persists.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new FlowlearnClient(config);

  const tools: ToolDef[] = [
    ...buildHelpTools(),
    ...buildSetupTools(client),
    ...buildCourseTools(client),
    ...buildCourseOutlineTools(client),
    ...buildCourseLintTools(client),
    ...buildModuleTools(client),
    ...buildLessonTools(client),
    ...buildFlowStepTools(client),
    ...buildConnectionTools(client),
  ];

  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "flowlearn-mcp", version: "0.4.2" },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        logging: {},
        completions: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // --- Tools -----------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => {
      const inputSchema = zodToJsonSchema(z.object(t.inputSchema), {
        $refStrategy: "none",
        target: "jsonSchema7",
      }) as Record<string, unknown>;
      const outputSchema = t.outputSchema
        ? (zodToJsonSchema(t.outputSchema, {
            $refStrategy: "none",
            target: "jsonSchema7",
          }) as Record<string, unknown>)
        : undefined;
      return {
        name: t.name,
        description: t.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolsByName.get(req.params.name);
    if (!tool) {
      return errorResult({
        code: "UNKNOWN_TOOL",
        message: `Unknown tool: ${req.params.name}`,
        suggestion:
          "Call ListTools to discover the current tool catalog. Tool names changed in v0.2.0 — old dotted names like 'course.list' are now 'flowlearn_course_list'.",
        retriable: false,
      });
    }

    const parsed = z
      .object(tool.inputSchema)
      .safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return errorResult({
        code: "INVALID_ARGUMENTS",
        message: `Invalid arguments for ${tool.name}`,
        suggestion:
          "Re-read the tool's inputSchema and resubmit. See `details.issues` for each violation.",
        retriable: true,
        details: {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join(".") || "(root)",
            message: i.message,
            code: i.code,
          })),
        },
      });
    }

    try {
      return await tool.handler(parsed.data);
    } catch (err) {
      if (err instanceof FlowlearnApiError) {
        return errorResult({
          code: `FLOWLEARN_API_${err.status}`,
          message: err.message,
          suggestion:
            err.status === 401
              ? "Auth failed despite a refresh attempt. Verify FLOWLEARN_EMAIL/PASSWORD and tenant membership."
              : err.status === 403
                ? "Active tenant likely doesn't grant the required role for this op. Call flowlearn_setup_status."
                : err.status === 404
                  ? "Entity not found. Call the matching list tool to verify the id exists."
                  : err.status >= 500
                    ? "Upstream Flowlearn error. Retrying may help."
                    : undefined,
          retriable: err.status >= 500 || err.status === 401,
          details: { status: err.status, path: err.path, body: err.body },
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return errorResult({
        code: "INTERNAL_ERROR",
        message,
        retriable: false,
      });
    }
  });

  // --- Resources -------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listConcreteResources(),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    try {
      const contents = await readResource(client, req.params.uri);
      return { contents };
    } catch (err) {
      if (err instanceof ResourceNotFoundError) {
        throw new Error(`Resource not found: ${err.message}`);
      }
      throw err;
    }
  });

  // --- Prompts ---------------------------------------------------------

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    try {
      const args = (req.params.arguments ?? {}) as Record<string, string | undefined>;
      return getPrompt(req.params.name, args);
    } catch (err) {
      if (err instanceof PromptNotFoundError) {
        throw new Error(err.message);
      }
      throw err;
    }
  });

  // --- Completion ------------------------------------------------------

  server.setRequestHandler(CompleteRequestSchema, async (req) => {
    const ref = req.params.ref;
    const arg = req.params.argument;
    if (ref.type === "ref/resource") {
      const result = await completeResourceArgument(
        client,
        ref.uri,
        arg.name,
        arg.value ?? "",
      );
      return { completion: { values: result.values, total: result.total, hasMore: result.hasMore } };
    }
    // ref/prompt or unknown — no completion data wired yet.
    return { completion: { values: [], hasMore: false } };
  });

  // --- Logging ---------------------------------------------------------

  // Honor logging/setLevel but don't currently filter — the server itself
  // does not emit verbose logs to the client. Declared for capability
  // completeness; we'll wire actual structured emission as long-running ops
  // arrive in Tier 2.
  server.setRequestHandler(SetLevelRequestSchema, async () => ({}));

  // --- Connect ---------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `flowlearn-mcp v0.4.2 ready: ${tools.length} tools, ${RESOURCE_TEMPLATES.length} resource templates, ${PROMPTS.length} prompts, tenant=${config.tenantSlug}, base=${config.baseUrl}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`flowlearn-mcp failed to start: ${err.message ?? err}\n`);
  process.exit(1);
});
