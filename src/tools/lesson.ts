import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  DryRunField,
  IdempotencyField,
  PaginationFields,
  editorUrl,
  entityResult,
  errorResult,
  getIdempotent,
  listResult,
  paginate,
  setIdempotent,
  type ToolDef,
} from "./common.js";

const LessonShape = z
  .object({
    id: z.string(),
    title: z.string(),
    module_id: z.string().optional(),
    order_index: z.number().optional(),
    flow_completed: z.boolean().optional(),
    description: z.string().nullish(),
    content: z.unknown().nullish(),
  })
  .passthrough();

const LessonEnvelope = z.object({
  entity: LessonShape,
  summary: z.string(),
  url: z.string().optional(),
  next_actions: z.array(z.string()).optional(),
});

const LessonListEnvelope = z.object({
  items: z.array(LessonShape.partial()),
  total: z.number().int(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  summary: z.string(),
});

export function buildLessonTools(client: FlowlearnClient): ToolDef[] {
  const cfg = () => client.getConfig();

  return [
    {
      name: "flowlearn_lesson_list",
      description:
        "List all lessons of a module in display order.\n\n" +
        "When to use: see the lessons inside a module, find a lesson id by title, decide where to insert.\n" +
        "When NOT to use: to fetch the flow steps of one lesson — call flowlearn_flow_step_list directly.\n\n" +
        "Hierarchy: tenant → course → module → lesson → flow_step.\n\n" +
        'Example call: { "module_id": "mod_x" }\n\n' +
        "Errors: FLOWLEARN_API_404 if module_id invalid.",
      inputSchema: {
        module_id: z.string().min(1),
        ...PaginationFields,
      },
      outputSchema: LessonListEnvelope,
      annotations: {
        title: "List lessons",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ module_id, limit, cursor, response_format }) => {
        const data = await client.request<unknown>(
          `/api/modules/${module_id}/lessons`,
        );
        const arr = (Array.isArray(data) ? data : (data as { lessons?: unknown[] })?.lessons ?? []) as Record<string, unknown>[];
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
      name: "flowlearn_lesson_get",
      description:
        "Fetch a single lesson by id, including its module context.\n\n" +
        "When to use: inspect current `content` shape before updating; check `flow_completed` status.\n" +
        "When NOT to use: to fetch the flow steps (those are a separate query — call flowlearn_flow_step_list).\n\n" +
        'Example call: { "lesson_id": "lsn_abc" }\n\n' +
        "Errors: FLOWLEARN_API_404 if lesson_id invalid.",
      inputSchema: {
        lesson_id: z.string().min(1),
      },
      outputSchema: LessonEnvelope,
      annotations: {
        title: "Get lesson",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ lesson_id }) => {
        const data = await client.request<{ lesson?: Record<string, unknown> }>(
          `/api/lessons/${lesson_id}`,
        );
        const entity = (data.lesson ?? data) as Record<string, unknown>;
        const id = String(entity.id ?? lesson_id);
        return entityResult({
          entity,
          summary: `Lesson '${entity.title}' (id=${id}), flow_completed=${entity.flow_completed ?? false}.`,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "lesson", id),
          next_actions: [
            `flowlearn_flow_step_list with lesson_id="${id}" to see the flow`,
            `flowlearn_lesson_update with lesson_id="${id}" + flow_completed=true once steps are done`,
          ],
        });
      },
    },
    {
      name: "flowlearn_lesson_create",
      description:
        "Create a new lesson under a module. Appended at the end.\n\n" +
        "When to use: add a lesson during course scaffolding. Flow step creation is a separate step.\n" +
        "When NOT to use: to add flow steps — those are created separately via flowlearn_flow_step_create. The lesson's `content.steps` is a legacy snapshot field; the live flow lives in flow_steps + flow_connections tables.\n\n" +
        "Server defaults `content` to { steps: [] }. Idempotent retry: pass client_request_id.\n\n" +
        'Example call: { "module_id": "mod_x", "title": "Hello" }\n\n' +
        "Errors: FLOWLEARN_API_404 if module_id invalid.",
      inputSchema: {
        module_id: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        content: z
          .object({ steps: z.array(z.unknown()).optional() })
          .passthrough()
          .optional()
          .describe("Usually leave empty and use flowlearn_flow_step_create"),
        ...IdempotencyField,
      },
      outputSchema: LessonEnvelope,
      annotations: {
        title: "Create lesson",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async ({ module_id, client_request_id, ...body }) => {
        const cached = getIdempotent(client_request_id as string | undefined);
        if (cached) return cached;
        const data = await client.request<{ lesson?: Record<string, unknown> }>(
          `/api/modules/${module_id}/lessons`,
          { method: "POST", body },
        );
        const entity = (data.lesson ?? data) as Record<string, unknown>;
        const id = String(entity.id);
        const result = entityResult({
          entity,
          summary: `Created lesson '${entity.title}' (id=${id}) in module ${module_id}.`,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "lesson", id),
          next_actions: [
            `flowlearn_flow_step_create with lesson_id="${id}" + is_starting_step=true to add the entry step`,
          ],
        });
        setIdempotent(client_request_id as string | undefined, result);
        return result;
      },
    },
    {
      name: "flowlearn_lesson_update",
      description:
        "Update a lesson's title, description, content, or `flow_completed` marker.\n\n" +
        "When to use: rename a lesson; mark `flow_completed=true` once flow steps are wired (REQUIRED for course publishing).\n" +
        "When NOT to use: to add/remove flow steps (use flowlearn_flow_step_create / _delete).\n\n" +
        'Example call: { "lesson_id": "lsn_abc", "flow_completed": true }\n\n' +
        "Errors: FLOWLEARN_API_404 if lesson_id invalid.",
      inputSchema: {
        lesson_id: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        content: z
          .object({ steps: z.array(z.unknown()).optional() })
          .passthrough()
          .optional(),
        flow_completed: z.boolean().optional(),
      },
      outputSchema: LessonEnvelope,
      annotations: {
        title: "Update lesson",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ lesson_id, ...body }) => {
        const data = await client.request<{ lesson?: Record<string, unknown> }>(
          `/api/lessons/${lesson_id}`,
          { method: "PUT", body },
        );
        const entity = (data.lesson ?? data) as Record<string, unknown>;
        const id = String(entity.id ?? lesson_id);
        return entityResult({
          entity,
          summary: `Updated lesson '${entity.title}' (id=${id}).`,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "lesson", id),
        });
      },
    },
    {
      name: "flowlearn_lesson_delete",
      description:
        "DESTRUCTIVE: delete a lesson and cascade-delete its flow steps and connections. Remaining lessons in the module are auto-reordered.\n\n" +
        "When to use: removing a discarded lesson at explicit user request.\n" +
        "When NOT to use: to clear the flow but keep the lesson — delete individual flow steps instead with flowlearn_flow_step_delete.\n\n" +
        "Dry-run: pass dry_run=true to preview.\n\n" +
        'Example call: { "lesson_id": "lsn_abc", "dry_run": true }\n\n' +
        "Errors: FLOWLEARN_API_404 if lesson_id invalid.",
      inputSchema: {
        lesson_id: z.string().min(1),
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z.object({ id: z.string(), deleted: z.boolean() }).passthrough(),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Delete lesson",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ lesson_id, dry_run }) => {
        if (dry_run) {
          try {
            const steps = await client.request<unknown>(
              `/api/lessons/${lesson_id}/flow-steps`,
            );
            const arr = Array.isArray(steps) ? steps : (steps as { flow_steps?: unknown[] })?.flow_steps ?? [];
            return entityResult({
              entity: { id: String(lesson_id), deleted: false, dry_run: true, step_count: arr.length },
              summary: `[dry-run] Would delete lesson ${lesson_id} and ${arr.length} flow steps + their connections + uploaded images.`,
              next_actions: [`Re-call without dry_run to commit.`],
            });
          } catch {
            return errorResult({
              code: "DRY_RUN_PREVIEW_FAILED",
              message: `Could not fetch flow steps of lesson ${lesson_id}.`,
              suggestion: "Verify the lesson_id via flowlearn_lesson_list.",
              retriable: false,
            });
          }
        }
        await client.request(`/api/lessons/${lesson_id}`, { method: "DELETE" });
        return entityResult({
          entity: { id: String(lesson_id), deleted: true },
          summary: `Deleted lesson id=${lesson_id}.`,
        });
      },
    },
  ];
}
