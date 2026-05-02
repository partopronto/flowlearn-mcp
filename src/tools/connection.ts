import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  DryRunField,
  IdSchema,
  IdempotencyField,
  PaginationFields,
  entityResult,
  errorResult,
  getIdempotentScoped,
  listResult,
  paginate,
  setIdempotentScoped,
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
        flow_step_id: IdSchema,
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
        flow_step_id: IdSchema,
        to_step_id: IdSchema
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
        const tenantSlug = client.getConfig().tenantSlug;
        const cached = getIdempotentScoped(tenantSlug, client_request_id as string | undefined);
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
        setIdempotentScoped(tenantSlug, client_request_id as string | undefined, result);
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
        flow_step_id: IdSchema,
        connections: z
          .array(
            z.object({
              to_step_id: IdSchema.nullable(),
              button_text: z.string().min(1),
              button_action: ButtonActionEnum.optional(),
              button_order: z.number().int().min(1),
            }).strict(),
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
      name: "flowlearn_connection_graph_replace",
      description:
        "DESTRUCTIVE: atomically replace ALL outgoing connections for EVERY flow step in a lesson with a new edge list. The only safe way to rewire a lesson's full flow graph in one call.\n\n" +
        "When to use: you have the complete desired connection graph for a lesson ready and want to replace the existing edges atomically; after flowlearn_course_outline_apply_diff surfaces connection warnings and you need to reconcile them.\n" +
        "When NOT to use: rewiring a single step (use flowlearn_connection_replace_all); inspecting edges before editing (use flowlearn_connection_list); when you only want to ADD edges (use flowlearn_connection_add).\n\n" +
        "Validation BEFORE mutating: every from_flow_step_id and every non-null to_flow_step_id must belong to this lesson. Cross-lesson edges are rejected with INVALID_ARGUMENTS listing the offending step ids.\n\n" +
        "Atomicity: best-effort. Edges are replaced step-by-step (clear then write each step in sequence). On failure mid-way, details.partial reports the last step processed. NO rollback — clearing edges is irreversible without a snapshot.\n\n" +
        "Dry-run: pass dry_run=true to see current edges per step AND the proposed edges, without mutating.\n\n" +
        'Example call: { "lesson_id": "les_abc", "edges": [{"from_flow_step_id":"stp_1","to_flow_step_id":"stp_2","button_text":"Next","button_order":1},{"from_flow_step_id":"stp_2","to_flow_step_id":null,"button_text":"Finish","button_order":1}] }\n\n' +
        "Errors: INVALID_ARGUMENTS if any step id is cross-lesson; FLOWLEARN_API_404 if lesson_id invalid. On partial failure: GRAPH_REPLACE_PARTIAL with details.partial.",
      inputSchema: {
        lesson_id: IdSchema.describe("ID of the lesson whose flow graph to replace"),
        edges: z
          .array(
            z.object({
              from_flow_step_id: IdSchema
                .describe("The step that has this outgoing button (must be in this lesson)"),
              to_flow_step_id: IdSchema
                .nullable()
                .describe("Target step (must be in this lesson), or null for terminal buttons"),
              button_text: z.string().min(1).describe("Button label"),
              button_action: ButtonActionEnum.optional().describe("Defaults to 'next'"),
              button_order: z.number().int().min(1).describe("Display order among buttons on this step"),
            }).strict(),
          )
          .describe("Complete desired edge list for the lesson"),
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z.object({
          lesson_id: z.string(),
          steps_processed: z.number().int(),
          edges_written: z.number().int(),
          dry_run: z.boolean().optional(),
          current_per_step: z.unknown().optional(),
          proposed_per_step: z.unknown().optional(),
          partial: z.unknown().optional(),
        }),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Replace lesson connection graph",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ lesson_id, edges, dry_run }) => {
        const lessonIdStr = lesson_id as string;
        const edgeList = edges as Array<{
          from_flow_step_id: string;
          to_flow_step_id: string | null;
          button_text: string;
          button_action?: string;
          button_order: number;
        }>;

        // --- Fetch lesson's flow steps to validate ownership ---
        const stepsResp = await client.request<unknown>(
          `/api/lessons/${lessonIdStr}/flow-steps`,
        );
        const steps = (
          Array.isArray(stepsResp)
            ? stepsResp
            : (stepsResp as { flow_steps?: unknown[] })?.flow_steps ?? []
        ) as Record<string, unknown>[];
        const stepIds = new Set(steps.map((s) => String(s.id)));

        // Validate that all step ids in the edge list belong to this lesson.
        const offenders: string[] = [];
        for (const edge of edgeList) {
          if (!stepIds.has(edge.from_flow_step_id)) offenders.push(edge.from_flow_step_id);
          if (edge.to_flow_step_id !== null && !stepIds.has(edge.to_flow_step_id)) {
            offenders.push(edge.to_flow_step_id);
          }
        }
        if (offenders.length > 0) {
          return errorResult({
            code: "INVALID_ARGUMENTS",
            message: `The following step ids are not part of lesson ${lessonIdStr}: ${[...new Set(offenders)].join(", ")}`,
            suggestion: "Call flowlearn_flow_step_list with lesson_id to get the valid step ids for this lesson.",
            retriable: false,
            details: { lesson_id: lessonIdStr, offending_step_ids: [...new Set(offenders)] },
          });
        }

        // Group edges by from_flow_step_id for efficient per-step writes.
        const edgesByStep = new Map<string, typeof edgeList>();
        for (const edge of edgeList) {
          if (!edgesByStep.has(edge.from_flow_step_id)) {
            edgesByStep.set(edge.from_flow_step_id, []);
          }
          edgesByStep.get(edge.from_flow_step_id)!.push(edge);
        }

        // --- Dry-run ---
        if (dry_run) {
          const currentPerStep: Record<string, unknown[]> = {};
          for (const s of steps) {
            const sid = String(s.id);
            const conns = (s.connections as unknown[] | undefined) ?? [];
            currentPerStep[sid] = conns;
          }
          const proposedPerStep: Record<string, unknown[]> = {};
          for (const [sid, stepEdges] of edgesByStep) {
            proposedPerStep[sid] = stepEdges;
          }
          return entityResult({
            entity: {
              lesson_id: lessonIdStr,
              steps_processed: 0,
              edges_written: 0,
              dry_run: true,
              current_per_step: currentPerStep,
              proposed_per_step: proposedPerStep,
            },
            summary: `[dry-run] Would replace connections on ${stepIds.size} step(s) in lesson ${lessonIdStr} with ${edgeList.length} total edge(s).`,
            next_actions: [`Re-call without dry_run to commit.`],
          });
        }

        // --- Apply: for each step in the lesson, clear then write new edges ---
        let stepsProcessed = 0;
        let edgesWritten = 0;

        for (const step of steps) {
          const sid = String(step.id);
          const newEdges = edgesByStep.get(sid) ?? [];

          try {
            // Clear existing connections for this step.
            await client.request(`/api/flow-steps/${sid}/connections`, { method: "DELETE" });

            // Write new connections.
            for (const edge of newEdges) {
              await client.request(`/api/flow-steps/${sid}/connections`, {
                method: "POST",
                body: {
                  to_step_id: edge.to_flow_step_id,
                  button_text: edge.button_text,
                  button_action: edge.button_action ?? "next",
                  button_order: edge.button_order,
                },
              });
              edgesWritten++;
            }
            stepsProcessed++;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return errorResult({
              code: "GRAPH_REPLACE_PARTIAL",
              message: `Failed at step ${sid} (${stepsProcessed}/${stepIds.size} steps completed): ${message}`,
              suggestion:
                "No rollback attempted — clearing edges is irreversible without a snapshot. Inspect details.partial to see how far the replace got, then manually reconcile the remaining steps.",
              retriable: false,
              details: {
                partial: {
                  lesson_id: lessonIdStr,
                  steps_completed: stepsProcessed,
                  steps_total: stepIds.size,
                  failed_at_step_id: sid,
                  edges_written_so_far: edgesWritten,
                },
              },
            });
          }
        }

        return entityResult({
          entity: {
            lesson_id: lessonIdStr,
            steps_processed: stepsProcessed,
            edges_written: edgesWritten,
          },
          summary: `Replaced connection graph for lesson ${lessonIdStr}: ${stepsProcessed} step(s) processed, ${edgesWritten} edge(s) written.`,
          next_actions: [
            `Use flowlearn_course_lint to verify no orphan steps or dangling connections remain.`,
          ],
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
        flow_step_id: IdSchema,
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
