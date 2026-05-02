import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  DryRunField,
  IdSchema,
  IdempotencyField,
  PaginationFields,
  editorUrl,
  entityResult,
  errorResult,
  getIdempotentScoped,
  listResult,
  paginate,
  setIdempotentScoped,
  type ToolDef,
} from "./common.js";

const ModuleShape = z
  .object({
    id: z.string(),
    title: z.string(),
    course_id: z.string().optional(),
    order_index: z.number().optional(),
    description: z.string().nullish(),
    content: z.unknown().nullish(),
  })
  .passthrough();

const ModuleEnvelope = z.object({
  entity: ModuleShape,
  summary: z.string(),
  url: z.string().optional(),
  next_actions: z.array(z.string()).optional(),
});

const ModuleListEnvelope = z.object({
  items: z.array(ModuleShape.partial()),
  total: z.number().int(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  summary: z.string(),
});

export function buildModuleTools(client: FlowlearnClient): ToolDef[] {
  const cfg = () => client.getConfig();

  return [
    {
      name: "flowlearn_module_list",
      description:
        "List all modules of a course in display order, with a lesson count for each.\n\n" +
        "When to use: see the structure of a course, find a module id by title, decide where to insert a new module.\n" +
        "When NOT to use: to fetch lessons of one specific module — call flowlearn_lesson_list with module_id directly.\n\n" +
        "Hierarchy: tenant → course → module → lesson → flow_step.\n\n" +
        'Example call: { "course_id": "crs_abc", "response_format": "concise" }\n\n' +
        "Errors: FLOWLEARN_API_404 if course_id is invalid.",
      inputSchema: {
        course_id: IdSchema,
        ...PaginationFields,
      },
      outputSchema: ModuleListEnvelope,
      annotations: {
        title: "List modules",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id, limit, cursor, response_format }) => {
        const data = await client.request<unknown>(
          `/api/courses/${course_id}/modules`,
        );
        const arr = (Array.isArray(data) ? data : (data as { modules?: unknown[] })?.modules ?? []) as Record<string, unknown>[];
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
      name: "flowlearn_module_create",
      description:
        "Create a new module under a course. Appended at the end (highest order_index).\n\n" +
        "When to use: add a new section to an existing course; called repeatedly when scaffolding a course outline.\n" +
        "When NOT to use: to insert a module in a specific position — create at end, then call flowlearn_module_reorder.\n\n" +
        "Content shape: { objectives: string[] } — only `objectives` is read by the rest of the codebase.\n" +
        "Idempotent retry: pass client_request_id.\n\n" +
        'Example call: { "course_id": "crs_abc", "title": "Greetings", "content": { "objectives": ["Say hello", "Say goodbye"] } }\n\n' +
        "Errors: FLOWLEARN_API_404 if course_id invalid; FLOWLEARN_API_400 on missing title.",
      inputSchema: {
        course_id: IdSchema,
        title: z.string().min(1),
        description: z.string().optional(),
        content: z
          .object({ objectives: z.array(z.string()).optional() })
          .strict()
          .optional()
          .describe("Shape: { objectives: string[] }"),
        ...IdempotencyField,
      },
      outputSchema: ModuleEnvelope,
      annotations: {
        title: "Create module",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async ({ course_id, client_request_id, ...body }) => {
        const tenantSlug = cfg().tenantSlug;
        const cached = getIdempotentScoped(tenantSlug, client_request_id as string | undefined);
        if (cached) return cached;
        const data = await client.request<{ module?: Record<string, unknown> }>(
          `/api/courses/${course_id}/modules`,
          { method: "POST", body },
        );
        const entity = (data.module ?? data) as Record<string, unknown>;
        const id = String(entity.id);
        const result = entityResult({
          entity,
          summary: `Created module '${entity.title}' (id=${id}) in course ${course_id}.`,
          url: editorUrl(cfg().baseUrl, tenantSlug, "module", id, { courseId: String(course_id) }),
          next_actions: [
            `flowlearn_lesson_create with module_id="${id}" to add lessons`,
          ],
        });
        setIdempotentScoped(tenantSlug, client_request_id as string | undefined, result);
        return result;
      },
    },
    {
      name: "flowlearn_module_update",
      description:
        "Update a module's title, description, or content JSON.\n\n" +
        "When to use: rename a module, edit its description, or update objectives.\n" +
        "When NOT to use: to add/remove lessons (use flowlearn_lesson_create / flowlearn_lesson_delete); to change module order (use flowlearn_module_reorder).\n\n" +
        "Content shape: same as flowlearn_module_create — { objectives: string[] }.\n\n" +
        'Example call: { "module_id": "mod_x", "title": "Greetings 101", "content": { "objectives": ["..."] } }\n\n' +
        "Errors: FLOWLEARN_API_404 if module_id invalid.",
      inputSchema: {
        module_id: IdSchema,
        title: z.string().optional(),
        description: z.string().optional(),
        content: z
          .object({ objectives: z.array(z.string()).optional() })
          .strict()
          .optional(),
      },
      outputSchema: ModuleEnvelope,
      annotations: {
        title: "Update module",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ module_id, ...body }) => {
        const data = await client.request<{ module?: Record<string, unknown> }>(
          `/api/modules/${module_id}`,
          { method: "PUT", body },
        );
        const entity = (data.module ?? data) as Record<string, unknown>;
        const id = String(entity.id ?? module_id);
        return entityResult({
          entity,
          summary: `Updated module '${entity.title}' (id=${id}).`,
          next_actions: [`flowlearn_module_list with course_id of this course to verify`],
        });
      },
    },
    {
      name: "flowlearn_module_delete",
      description:
        "DESTRUCTIVE: delete a module and cascade-delete all of its lessons, flow steps, and connections. Remaining modules are auto-reordered.\n\n" +
        "When to use: removing an obsolete section at explicit user request.\n" +
        "When NOT to use: to temporarily hide content — there's no archive flag at module level; consider deleting only after user confirmation.\n\n" +
        "Dry-run: pass dry_run=true to preview the cascade.\n\n" +
        'Example call: { "module_id": "mod_x", "dry_run": true }\n\n' +
        "Errors: FLOWLEARN_API_404 if module_id invalid.",
      inputSchema: {
        module_id: IdSchema,
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z.object({ id: z.string(), deleted: z.boolean() }).passthrough(),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Delete module",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ module_id, dry_run }) => {
        if (dry_run) {
          try {
            const lessons = await client.request<unknown>(
              `/api/modules/${module_id}/lessons`,
            );
            const arr = Array.isArray(lessons) ? lessons : (lessons as { lessons?: unknown[] })?.lessons ?? [];
            return entityResult({
              entity: { id: String(module_id), deleted: false, dry_run: true, lesson_count: arr.length },
              summary: `[dry-run] Would delete module ${module_id} and ${arr.length} lessons + all child steps/connections.`,
              next_actions: [`Re-call without dry_run to commit.`],
            });
          } catch {
            return errorResult({
              code: "DRY_RUN_PREVIEW_FAILED",
              message: `Could not fetch lessons of module ${module_id}.`,
              suggestion: "Verify the module_id via flowlearn_module_list.",
              retriable: false,
            });
          }
        }
        await client.request(`/api/modules/${module_id}`, { method: "DELETE" });
        return entityResult({
          entity: { id: String(module_id), deleted: true },
          summary: `Deleted module id=${module_id}.`,
        });
      },
    },
    {
      name: "flowlearn_module_reorder",
      description:
        "Reorder all modules of a course by sending the full ordered list of {id, order_index}.\n\n" +
        "When to use: change the sequence in which modules appear (e.g., move 'Intro' to the front).\n" +
        "When NOT to use: to delete a module (use flowlearn_module_delete); to rename (use flowlearn_module_update).\n\n" +
        "Pass the COMPLETE list — partial submissions may be rejected. Use flowlearn_module_list first to get current ids.\n\n" +
        'Example call: { "course_id": "crs_abc", "modules": [{"id":"mod_x","order_index":0},{"id":"mod_y","order_index":1}] }\n\n' +
        "Errors: FLOWLEARN_API_400 if any id doesn't belong to course_id.",
      inputSchema: {
        course_id: IdSchema,
        modules: z
          .array(z.object({ id: IdSchema, order_index: z.number().int() }).strict())
          .min(1),
      },
      outputSchema: z.object({
        entity: z.record(z.unknown()),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Reorder modules",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id, modules }) => {
        const data = await client.request<unknown>(
          `/api/courses/${course_id}/modules/reorder`,
          { method: "PUT", body: { modules } },
        );
        return entityResult({
          entity: data as Record<string, unknown>,
          summary: `Reordered ${(modules as { id: string }[]).length} modules in course ${course_id}.`,
          next_actions: [`flowlearn_module_list with course_id="${course_id}" to verify`],
        });
      },
    },
  ];
}
