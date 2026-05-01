import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  DryRunField,
  IdempotencyField,
  PaginationFields,
  entityResult,
  errorResult,
  getIdempotent,
  listResult,
  paginate,
  setIdempotent,
  type ToolDef,
} from "./common.js";

const ButtonActionEnum = z.enum(["next", "help", "skip", "custom", "branch"]);

const ConnectionShape = z
  .object({
    id: z.string(),
    flow_step_id: z.string().optional(),
    to_step_id: z.string().nullable(),
    button_text: z.string(),
    button_action: ButtonActionEnum.optional(),
    button_order: z.number().int().optional(),
  })
  .passthrough();

const ConnectionEnvelope = z.object({
  entity: ConnectionShape,
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
});

const ConnectionListEnvelope = z.object({
  items: z.array(ConnectionShape.partial()),
  total: z.number().int(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  summary: z.string(),
});

export function buildConnectionTools(client: FlowlearnClient): ToolDef[] {
  return [
    {
      name: "flowlearn_connection_list",
      description:
        "List all outgoing connections (button edges) from a flow step.\n\n" +
        "When to use: inspect a step's outgoing edges before editing the flow graph.\n" +
        "When NOT to use: to inspect ALL connections in a lesson — call flowlearn_flow_step_list, which already returns each step's outgoing connections inline.\n\n" +
        'Example call: { "flow_step_id": "stp_abc" }\n\n' +
        "Errors: FLOWLEARN_API_404 if flow_step_id invalid.",
      inputSchema: {
        flow_step_id: z.string().min(1),
        ...PaginationFields,
      },
      outputSchema: ConnectionListEnvelope,
      annotations: {
        title: "List connections",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id, limit, cursor, response_format }) => {
        const data = await client.request<unknown>(
          `/api/flow-steps/${flow_step_id}/connections`,
        );
        const arr = (Array.isArray(data) ? data : (data as { connections?: unknown[] })?.connections ?? []) as Record<string, unknown>[];
        return listResult(
          paginate(arr, {
            limit: limit as number | undefined,
            cursor: cursor as string | undefined,
            format: response_format as "concise" | "detailed" | undefined,
          }),
        );
      },
    },
    {
      name: "flowlearn_connection_add",
      description:
        "Add a single outgoing connection (button edge) from a flow step.\n\n" +
        "When to use: wire one step to another; add a 'help' or 'skip' button. The most common way to build a linear or branching flow.\n" +
        "When NOT to use: to wholesale-replace a step's edges (use flowlearn_connection_replace_all); to delete edges (use flowlearn_connection_clear).\n\n" +
        "to_step_id may be null for terminal buttons (end of flow). Idempotent retry: pass client_request_id.\n\n" +
        'Example call: { "flow_step_id": "stp_a", "to_step_id": "stp_b", "button_text": "Next", "button_action": "next", "button_order": 1 }\n\n' +
        "Errors: FLOWLEARN_API_404 if flow_step_id or to_step_id invalid.",
      inputSchema: {
        flow_step_id: z.string().min(1),
        to_step_id: z
          .string()
          .nullable()
          .describe("Null for terminal buttons (end of flow)"),
        button_text: z.string().min(1),
        button_action: ButtonActionEnum
          .optional()
          .describe("Defaults to 'next' server-side"),
        button_order: z.number().int().min(1),
        ...IdempotencyField,
      },
      outputSchema: ConnectionEnvelope,
      annotations: {
        title: "Add connection",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id, client_request_id, ...body }) => {
        const cached = getIdempotent(client_request_id as string | undefined);
        if (cached) return cached;
        const data = await client.request<{ connection?: Record<string, unknown> }>(
          `/api/flow-steps/${flow_step_id}/connections`,
          { method: "POST", body },
        );
        const entity = (data.connection ?? data) as Record<string, unknown>;
        const result = entityResult({
          entity,
          summary: `Added button '${body.button_text}' from step ${flow_step_id} → ${body.to_step_id ?? "(terminal)"}.`,
        });
        setIdempotent(client_request_id as string | undefined, result);
        return result;
      },
    },
    {
      name: "flowlearn_connection_replace_all",
      description:
        "DESTRUCTIVE: fully replace all outgoing connections from a flow step with the supplied list. Any existing connection not in the new list is deleted.\n\n" +
        "When to use: redraw a step's outgoing edges atomically (e.g., reorder buttons + change targets in one shot).\n" +
        "When NOT to use: to add ONE button (use flowlearn_connection_add); to clear all edges (use flowlearn_connection_clear — passing connections=[] here is rejected so the destructive intent is stated explicitly).\n\n" +
        "Dry-run: pass dry_run=true to preview which connections would be removed/added/changed.\n\n" +
        'Example call: { "flow_step_id": "stp_a", "connections": [{"to_step_id":"stp_b","button_text":"Yes","button_order":1},{"to_step_id":"stp_c","button_text":"No","button_order":2}] }\n\n' +
        "Errors: USE_CONNECTION_CLEAR if connections=[] (call flowlearn_connection_clear instead); FLOWLEARN_API_404 if any to_step_id invalid.",
      inputSchema: {
        flow_step_id: z.string().min(1),
        connections: z
          .array(
            z.object({
              to_step_id: z.string().nullable(),
              button_text: z.string().min(1),
              button_action: ButtonActionEnum.optional(),
              button_order: z.number().int().min(1),
            }),
          )
          .min(0),
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z.unknown(),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Replace all connections",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id, connections, dry_run }) => {
        // Reject empty array: clearing edges is flowlearn_connection_clear's
        // job. Two tools doing the same destructive action is confusing for
        // agents — force the explicit, named tool when intent is "delete all".
        if (Array.isArray(connections) && (connections as unknown[]).length === 0) {
          return errorResult({
            code: "USE_CONNECTION_CLEAR",
            message:
              "Empty connection array — use flowlearn_connection_clear instead, which states the destructive intent explicitly.",
            suggestion: `Call flowlearn_connection_clear with flow_step_id="${flow_step_id}" (and dry_run=true first to preview).`,
            retriable: false,
          });
        }
        if (dry_run) {
          const existing = await client.request<unknown>(
            `/api/flow-steps/${flow_step_id}/connections`,
          );
          const arr = Array.isArray(existing) ? existing : (existing as { connections?: unknown[] })?.connections ?? [];
          return entityResult({
            entity: { dry_run: true, current: arr, proposed: connections },
            summary: `[dry-run] Would replace ${arr.length} existing connection(s) on step ${flow_step_id} with ${(connections as unknown[]).length} new.`,
            next_actions: [`Re-call without dry_run to commit.`],
          });
        }
        const data = await client.request<unknown>(
          `/api/flow-steps/${flow_step_id}/connections`,
          { method: "PUT", body: { connections } },
        );
        return entityResult({
          entity: data as Record<string, unknown>,
          summary: `Replaced connections on step ${flow_step_id} with ${(connections as unknown[]).length} new edge(s).`,
        });
      },
    },
    {
      name: "flowlearn_connection_clear",
      description:
        "DESTRUCTIVE: delete all outgoing connections from a flow step.\n\n" +
        "When to use: detach a step from the flow before re-wiring; remove dead edges.\n" +
        "When NOT to use: to delete the step itself (use flowlearn_flow_step_delete).\n\n" +
        "Dry-run: pass dry_run=true to preview which connections would be removed.\n\n" +
        'Example call: { "flow_step_id": "stp_a", "dry_run": true }\n\n' +
        "Errors: FLOWLEARN_API_404 if flow_step_id invalid.",
      inputSchema: {
        flow_step_id: z.string().min(1),
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z.unknown(),
        summary: z.string(),
      }),
      annotations: {
        title: "Clear connections",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ flow_step_id, dry_run }) => {
        if (dry_run) {
          const existing = await client.request<unknown>(
            `/api/flow-steps/${flow_step_id}/connections`,
          );
          const arr = Array.isArray(existing) ? existing : (existing as { connections?: unknown[] })?.connections ?? [];
          return entityResult({
            entity: { dry_run: true, would_delete: arr },
            summary: `[dry-run] Would delete ${arr.length} connection(s) from step ${flow_step_id}.`,
          });
        }
        const data = await client.request<unknown>(
          `/api/flow-steps/${flow_step_id}/connections`,
          { method: "DELETE" },
        );
        return entityResult({
          entity: data as Record<string, unknown>,
          summary: `Cleared all connections from step ${flow_step_id}.`,
        });
      },
    },
  ];
}
