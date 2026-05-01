/**
 * flowlearn_course_transaction — run an ordered list of mutations in a single
 * tool call with optional best-effort rollback.
 *
 * WIRING CONTRACT (for the orchestrator that edits src/index.ts):
 *
 *   import { buildTransactionTools } from "./tools/transaction.js";
 *   // ...
 *   const getToolsByName = () => toolsByName;   // lazily bound after build
 *   const tools: ToolDef[] = [
 *     ...,
 *     ...buildTransactionTools(client, getToolsByName),
 *   ];
 *
 * The `getToolsByName` getter MUST return the same Map that the rest of
 * index.ts populates — transaction dispatches through it at call time (lazy),
 * so the Map is fully populated even though it was empty when buildTransactionTools
 * was called. Pass a getter `() => toolsByName`, never the Map reference directly
 * (which would capture the value before tools are added).
 */

import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  entityResult,
  errorResult,
  type ToolDef,
  type ToolResult,
} from "./common.js";

// ---------------------------------------------------------------------------
// Whitelist — only mutating flowlearn_* tools may participate in a transaction.
// Excluded because they have unbounded blast radius or are inherently
// irreversible without a snapshot:
//   - *_delete (deleted entities cannot be recovered — accepting them would
//     make rollback a lie for any transaction that includes a delete)
//   - flowlearn_setup_* (global config changes — not reversible in context)
//   - flowlearn_connection_clear (clears ALL edges from a step — too broad)
//   - flowlearn_connection_replace_all (replaces ALL edges — too broad for safe rollback)
//   - flowlearn_course_outline_apply_diff (composite — has its own error/partial semantics)
//   - flowlearn_course_outline_apply (composite)
//   - flowlearn_course_transaction (nesting not supported)
// ---------------------------------------------------------------------------

const ALLOWED_PREFIX = "flowlearn_";
const DENIED_SUFFIXES = ["_delete"] as const;
const DENIED_EXACT: ReadonlySet<string> = new Set([
  "flowlearn_setup_status",
  "flowlearn_setup_update",
  "flowlearn_setup_switch_tenant",
  "flowlearn_connection_clear",
  "flowlearn_connection_replace_all",
  "flowlearn_course_outline_apply",
  "flowlearn_course_outline_apply_diff",
  "flowlearn_course_transaction",
]);

function isAllowedTool(name: string): { allowed: true } | { allowed: false; reason: string } {
  if (!name.startsWith(ALLOWED_PREFIX)) {
    return { allowed: false, reason: `Only flowlearn_* tools may be used in a transaction; got '${name}'.` };
  }
  if (DENIED_EXACT.has(name)) {
    return { allowed: false, reason: `'${name}' is not allowed in transactions (destructive/composite with no safe inverse).` };
  }
  for (const suffix of DENIED_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return { allowed: false, reason: `'*_delete' tools are not allowed in transactions — deleted entities cannot be rolled back.` };
    }
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Inverse table — only a subset of ops have well-defined inverses.
//
// *_create → inverse is *_delete using the returned entity id.
// *_update → no inverse (would require pre-snapshot of old values). Rollback
//             past an update marks rollback as partial.
// *_reorder, *_upload_image, *_delete_image → no inverse. Marks rollback partial.
// ---------------------------------------------------------------------------

type RollbackEntry =
  | { kind: "delete_module"; module_id: string }
  | { kind: "delete_lesson"; lesson_id: string }
  | { kind: "delete_flow_step"; flow_step_id: string }
  | { kind: "delete_connection"; flow_step_id: string } // clear from step (best-effort)
  | { kind: "irreversible"; tool: string };

function buildRollbackEntry(
  toolName: string,
  result: ToolResult,
): RollbackEntry {
  // Extract the entity id from the structured content of the tool result.
  const entity =
    (result.structuredContent as Record<string, unknown> | undefined)?.entity as
      | Record<string, unknown>
      | undefined;
  const id = entity?.id ? String(entity.id) : undefined;

  if (toolName === "flowlearn_module_create" && id) {
    return { kind: "delete_module", module_id: id };
  }
  if (toolName === "flowlearn_lesson_create" && id) {
    return { kind: "delete_lesson", lesson_id: id };
  }
  if (toolName === "flowlearn_flow_step_create" && id) {
    return { kind: "delete_flow_step", flow_step_id: id };
  }
  if (toolName === "flowlearn_connection_add") {
    // The inverse of a connection_add is clearing that step's connections, which
    // is too broad (it would delete ALL connections, not just this one). We mark
    // it irreversible and surface a warning on rollback.
    return { kind: "irreversible", tool: toolName };
  }

  // *_update, *_reorder, *_upload_image, *_delete_image, etc.
  return { kind: "irreversible", tool: toolName };
}

async function applyRollback(
  client: FlowlearnClient,
  entry: RollbackEntry,
): Promise<"ok" | "irreversible" | "failed"> {
  try {
    switch (entry.kind) {
      case "delete_module":
        await client.request(`/api/modules/${entry.module_id}`, { method: "DELETE" });
        return "ok";
      case "delete_lesson":
        await client.request(`/api/lessons/${entry.lesson_id}`, { method: "DELETE" });
        return "ok";
      case "delete_flow_step":
        await client.request(`/api/flow-steps/${entry.flow_step_id}`, { method: "DELETE" });
        return "ok";
      case "delete_connection":
        await client.request(`/api/flow-steps/${entry.flow_step_id}/connections`, {
          method: "DELETE",
        });
        return "ok";
      case "irreversible":
        return "irreversible";
    }
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const TransactionEnvelope = z.object({
  entity: z.object({
    applied: z.array(z.object({ tool: z.string(), result_summary: z.string() })),
    rolled_back: z.boolean(),
    rollback_partial: z.boolean(),
    results: z.array(z.unknown()),
    failed_at: z
      .object({
        index: z.number().int(),
        tool: z.string(),
        error: z.string(),
      })
      .optional(),
  }),
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Builder — takes client + a lazy getter for the tools registry
// ---------------------------------------------------------------------------

export function buildTransactionTools(
  client: FlowlearnClient,
  getToolsByName: () => Map<string, ToolDef>,
): ToolDef[] {
  return [
    {
      name: "flowlearn_course_transaction",
      description:
        "Run an ordered list of flowlearn mutations sequentially, with optional best-effort rollback on failure. Replaces manual N-step sequences that need to stay together.\n\n" +
        "When to use: you need to create a module + several lessons + their steps as an atomic unit; you want rollback insurance on a multi-step creation flow.\n" +
        "When NOT to use: mutations that include deletes (not allowed — deleted entities cannot be rolled back); setup/tenant changes (not allowed); when you only have one mutation (no benefit); when you want a full course tree (use flowlearn_course_outline_apply instead).\n\n" +
        "Rollback semantics: if any mutation fails and rollback_on_error=true (default), the tool walks back through already-successful mutations in reverse order and applies the inverse:\n" +
        "  - module_create → module_delete\n" +
        "  - lesson_create → lesson_delete\n" +
        "  - flow_step_create → flow_step_delete\n" +
        "  - connection_add → NO inverse (too broad to undo safely without snapshot). Rollback stops and is marked partial.\n" +
        "  - *_update / *_reorder → NO inverse (no pre-snapshot). Rollback stops and is marked partial.\n\n" +
        "Allowed tools: all flowlearn_* tools EXCEPT *_delete, flowlearn_setup_*, flowlearn_connection_clear, flowlearn_connection_replace_all, flowlearn_course_outline_apply(_diff), and flowlearn_course_transaction itself.\n\n" +
        'Example call: { "mutations": [{"tool":"flowlearn_module_create","args":{"course_id":"crs_abc","title":"New Module"}},{"tool":"flowlearn_lesson_create","args":{"module_id":"__PREV_0_id__","title":"Lesson 1"}}], "rollback_on_error": true }\n\n' +
        "IMPORTANT: mutations run sequentially. You cannot forward-reference ids from later mutations. If you need to chain create results (e.g., use the module_id returned by step 0 in step 1), pre-create the parent first, then call transaction for the children. OR use flowlearn_course_outline_apply which handles the whole tree.\n\n" +
        "Errors: INVALID_ARGUMENTS if any tool is not in the whitelist or its args fail Zod validation. The failed mutation is identified in details.failed_at. If rollback was attempted, rolled_back=true (or rollback_partial=true if some inverses were not available).",
      inputSchema: {
        mutations: z
          .array(
            z.object({
              tool: z.string().min(1).describe("Name of the flowlearn_* tool to call"),
              args: z.record(z.unknown()).describe("Arguments to pass to the tool"),
            }),
          )
          .min(1)
          .max(50)
          .describe("Ordered list of mutations to apply (max 50 per transaction)"),
        rollback_on_error: z
          .boolean()
          .optional()
          .describe(
            "Default true. If a mutation fails, walk back successful mutations in reverse order using the inverse table. Rollback may be partial if irreversible ops (updates, connection_add) are in the list.",
          ),
      },
      outputSchema: TransactionEnvelope,
      annotations: {
        title: "Run transaction (ordered mutations with rollback)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args) => {
        const {
          mutations,
          rollback_on_error = true,
        } = args as {
          mutations: Array<{ tool: string; args: Record<string, unknown> }>;
          rollback_on_error?: boolean;
        };

        const toolsByName = getToolsByName();

        // Pre-flight: validate all mutations before executing any.
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          const check = isAllowedTool(m.tool);
          if (!check.allowed) {
            return errorResult({
              code: "INVALID_ARGUMENTS",
              message: `Mutation at index ${i} ('${m.tool}') is not allowed in a transaction: ${check.reason}`,
              suggestion: "Remove the disallowed tool or use the tool directly outside the transaction.",
              retriable: false,
              details: { index: i, tool: m.tool },
            });
          }

          const toolDef = toolsByName.get(m.tool);
          if (!toolDef) {
            return errorResult({
              code: "INVALID_ARGUMENTS",
              message: `Mutation at index ${i}: unknown tool '${m.tool}'. Call tools/list to discover available tools.`,
              suggestion: "Verify the tool name and retry.",
              retriable: false,
              details: { index: i, tool: m.tool },
            });
          }

          // Validate args against the tool's Zod schema.
          const parsed = z.object(toolDef.inputSchema).safeParse(m.args);
          if (!parsed.success) {
            return errorResult({
              code: "INVALID_ARGUMENTS",
              message: `Mutation at index ${i} ('${m.tool}'): invalid arguments.`,
              suggestion:
                "Re-read the tool's inputSchema and resubmit. See details.issues for each violation.",
              retriable: true,
              details: {
                index: i,
                tool: m.tool,
                issues: parsed.error.issues.map((issue) => ({
                  path: issue.path.join(".") || "(root)",
                  message: issue.message,
                  code: issue.code,
                })),
              },
            });
          }
        }

        // Execute mutations sequentially.
        const applied: Array<{ tool: string; result_summary: string }> = [];
        const results: unknown[] = [];
        const rollbackStack: RollbackEntry[] = [];

        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          const toolDef = toolsByName.get(m.tool)!;

          // Parse args (already validated above, but re-parse for type safety).
          const parsed = z.object(toolDef.inputSchema).safeParse(m.args);
          if (!parsed.success) {
            // Should not happen after pre-flight, but guard anyway.
            break;
          }

          let toolResult: ToolResult;
          try {
            toolResult = await toolDef.handler(parsed.data);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Tool threw (API error bubbled). Attempt rollback.
            const failedAt = { index: i, tool: m.tool, error: message };
            return await handleRollback(
              client,
              rollbackStack,
              rollback_on_error,
              applied,
              results,
              failedAt,
              `Tool '${m.tool}' at index ${i} threw an error: ${message}`,
            );
          }

          if (toolResult.isError) {
            // Tool returned a structured error.
            const errText =
              toolResult.content[0]?.type === "text" ? toolResult.content[0].text : "tool error";
            const failedAt = { index: i, tool: m.tool, error: errText };
            return await handleRollback(
              client,
              rollbackStack,
              rollback_on_error,
              applied,
              results,
              failedAt,
              `Tool '${m.tool}' at index ${i} returned an error.`,
            );
          }

          // Success — record result and build rollback entry.
          const resultSummary = extractResultSummary(toolResult);
          applied.push({ tool: m.tool, result_summary: resultSummary });
          results.push(toolResult.structuredContent ?? toolResult.content);
          rollbackStack.push(buildRollbackEntry(m.tool, toolResult));
        }

        // All mutations succeeded.
        const summary = `Transaction completed: ${applied.length} mutation(s) applied successfully.`;
        return entityResult({
          entity: {
            applied,
            rolled_back: false,
            rollback_partial: false,
            results,
          },
          summary,
          next_actions: applied.length > 0
            ? [
                `Inspect results[i] for per-mutation output.`,
                `Use flowlearn_course_lint to verify publish-readiness if course content was changed.`,
              ]
            : [],
        });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function handleRollback(
  client: FlowlearnClient,
  rollbackStack: RollbackEntry[],
  rollback_on_error: boolean,
  applied: Array<{ tool: string; result_summary: string }>,
  results: unknown[],
  failedAt: { index: number; tool: string; error: string },
  baseMessage: string,
): Promise<ToolResult> {
  if (!rollback_on_error || rollbackStack.length === 0) {
    return errorResult({
      code: "TRANSACTION_FAILED",
      message: baseMessage,
      suggestion: rollback_on_error
        ? "No successful mutations to roll back. Inspect details.failed_at."
        : "rollback_on_error=false: mutations applied so far were NOT reversed. Inspect details.applied and clean up manually.",
      retriable: false,
      details: {
        applied_so_far: applied.length,
        failed_at: failedAt,
        rolled_back: false,
        rollback_partial: false,
      },
    });
  }

  // Attempt rollback in reverse order.
  let rollbackPartial = false;
  const reversedStack = [...rollbackStack].reverse();
  for (const entry of reversedStack) {
    const outcome = await applyRollback(client, entry);
    if (outcome === "irreversible") {
      rollbackPartial = true;
      // Do not continue rolling back past an irreversible op — the state
      // is now in an undefined intermediate form; further rollback may corrupt it.
      break;
    }
    if (outcome === "failed") {
      rollbackPartial = true;
      // Rollback itself failed. Surface as partial and stop.
      break;
    }
    // "ok" — continue rolling back.
  }

  const rolledBack = !rollbackPartial;
  const rollbackNote = rollbackPartial
    ? "Rollback is PARTIAL: one or more applied mutations have no safe inverse (e.g. *_update, connection_add). Inspect details and reconcile manually."
    : "Rollback completed: all reversible mutations were undone.";

  return errorResult({
    code: "TRANSACTION_FAILED",
    message: `${baseMessage} ${rollbackNote}`,
    suggestion: rollbackPartial
      ? "Inspect details.applied to see what was applied before failure. Undo non-reversible ops manually."
      : "All reversible changes were rolled back. Retry the transaction after fixing the failing mutation.",
    retriable: !rollbackPartial,
    details: {
      applied_so_far: applied.length,
      failed_at: failedAt,
      rolled_back: rolledBack,
      rollback_partial: rollbackPartial,
    },
  });
}

function extractResultSummary(result: ToolResult): string {
  const sc = result.structuredContent as Record<string, unknown> | undefined;
  if (sc?.summary && typeof sc.summary === "string") return sc.summary;
  if (result.content[0]?.type === "text") {
    const text = result.content[0].text;
    // Try to extract "summary" from the JSON text.
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.summary && typeof parsed.summary === "string") return parsed.summary;
    } catch {
      // ignore
    }
    // Fall back to a truncated snippet.
    return text.slice(0, 80).replace(/\n/g, " ") + (text.length > 80 ? "…" : "");
  }
  return "(no summary)";
}
