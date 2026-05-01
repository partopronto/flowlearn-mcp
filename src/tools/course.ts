import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import { FLOWLEARN_BASE_URL } from "../config.js";
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

/** Loose course shape — fields the agent can rely on; rest is passthrough. */
const CourseShape = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    description: z.string().nullish(),
    topic: z.string().nullish(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]).nullish(),
    language: z.string().nullish(),
  })
  .passthrough();

const CourseEnvelope = z.object({
  entity: CourseShape,
  summary: z.string(),
  url: z.string().optional(),
  next_actions: z.array(z.string()).optional(),
});

const CourseListEnvelope = z.object({
  items: z.array(CourseShape.partial()),
  total: z.number().int(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  summary: z.string(),
});

export function buildCourseTools(client: FlowlearnClient): ToolDef[] {
  const cfg = () => client.getConfig();

  return [
    {
      name: "flowlearn_course_list",
      description:
        "List all courses visible to the active tenant admin.\n\n" +
        "When to use: orient yourself at the start of a session, find a course id by title, or paginate through a large catalog.\n" +
        "When NOT to use: to fetch a single course's full module/lesson tree — use flowlearn_course_get instead (cheaper).\n\n" +
        "Hierarchy: tenant → course → module → lesson → flow_step.\n\n" +
        "Returns: { items, total, next_cursor, has_more, summary }. Use response_format=concise for {id, title} only when iterating.\n\n" +
        'Example call: { "limit": 50, "response_format": "concise" }\n\n' +
        "Errors: returns FLOWLEARN_API_* on upstream failures. No NotFound case (empty list returns items=[]).",
      inputSchema: { ...PaginationFields },
      outputSchema: CourseListEnvelope,
      annotations: {
        title: "List courses",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ limit, cursor, response_format }) => {
        const data = await client.request<unknown>("/api/courses");
        const arr = (Array.isArray(data) ? data : (data as { courses?: unknown[] })?.courses ?? []) as Record<string, unknown>[];
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
      name: "flowlearn_course_get",
      description:
        "Fetch a single course by id, including its modules.\n\n" +
        "When to use: explore a course's structure before editing; verify a status change took effect; resolve a course title from an id.\n" +
        "When NOT to use: to enumerate modules of many courses — call flowlearn_module_list per course instead, or use flowlearn_course_list with concise format.\n\n" +
        "Returns: { entity, summary, url, next_actions } where entity is the full course incl. modules array.\n\n" +
        'Example call: { "course_id": "crs_abc123" }\n\n' +
        "Errors: FLOWLEARN_API_404 if id is invalid — call flowlearn_course_list to enumerate valid ids.",
      inputSchema: {
        course_id: z.string().min(1).describe("UUID or slug of the course"),
      },
      outputSchema: CourseEnvelope,
      annotations: {
        title: "Get course",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id }) => {
        const data = await client.request<{ course?: Record<string, unknown> }>(
          `/api/courses/${course_id}`,
        );
        const entity = (data.course ?? data) as Record<string, unknown>;
        const id = String(entity.id ?? course_id);
        return entityResult({
          entity,
          summary: `Course '${entity.title}' (id=${id}), status=${entity.status}.`,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", id),
          resource_uri: `flowlearn://course/${id}`,
          next_actions: [
            `flowlearn_module_list with course_id="${id}" to list modules`,
            `flowlearn_course_update with course_id="${id}" to edit metadata`,
          ],
        });
      },
    },
    {
      name: "flowlearn_course_create",
      description:
        "Create a new draft course with explicit metadata.\n\n" +
        "When to use: starting a new course from scratch with a known title + topic.\n" +
        "When NOT to use: when you want server-side AI to auto-generate modules — that path requires sending a `goal` field on POST, which this tool intentionally omits to keep all content authoring on the agent side. Set `goal` later via flowlearn_course_update if needed.\n\n" +
        "Idempotent retry: pass client_request_id; repeating with the same key returns the cached result.\n\n" +
        'Example call: { "title": "Spanish for Travelers", "topic": "Travel Spanish", "difficulty": "beginner", "language": "en" }\n\n' +
        "Errors: FLOWLEARN_API_400 on missing/invalid fields. Returns CREATED course with status=draft.",
      inputSchema: {
        title: z.string().min(1),
        topic: z.string().min(1).describe("Required by upstream"),
        description: z.string().optional(),
        tone: z.string().optional(),
        difficulty: z
          .enum(["beginner", "intermediate", "advanced"])
          .optional(),
        language: z.string().optional().describe("ISO language code, e.g. 'en'"),
        ...IdempotencyField,
      },
      outputSchema: CourseEnvelope,
      annotations: {
        title: "Create course",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async ({ client_request_id, ...body }) => {
        const cached = getIdempotent(client_request_id as string | undefined);
        if (cached) return cached;
        const data = await client.request<{ course?: Record<string, unknown> }>(
          "/api/courses",
          { method: "POST", body },
        );
        const entity = (data.course ?? data) as Record<string, unknown>;
        const id = String(entity.id);
        const result = entityResult({
          entity,
          summary: `Created draft course '${entity.title}' (id=${id}).`,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", id),
          resource_uri: `flowlearn://course/${id}`,
          next_actions: [
            `flowlearn_module_create with course_id="${id}" to add the first module`,
            `flowlearn_course_update with course_id="${id}" to set goal/tone`,
          ],
        });
        setIdempotent(client_request_id as string | undefined, result);
        return result;
      },
    },
    {
      name: "flowlearn_course_update",
      description:
        "Update course metadata or transition status (draft / published / archived).\n\n" +
        "When to use: edit title/description; mark a finished course `status='published'`; archive an old course.\n" +
        "When NOT to use: to add modules/lessons (use flowlearn_module_create / flowlearn_lesson_create).\n\n" +
        "Publishing rules: status='published' is REJECTED unless the course meets the publish gate (every module has at least one lesson with flow_completed=true, no gaps). API may return either 400 (hard block) or 200 with requiresConfirmation=true (warning). Pass force_publish=true to override warnings.\n\n" +
        'Example call: { "course_id": "crs_abc", "status": "published", "force_publish": true }\n\n' +
        "Errors: FLOWLEARN_API_400 with body listing the unmet rules; call flowlearn_course_get + flowlearn_module_list to inspect.",
      inputSchema: {
        course_id: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        topic: z.string().optional(),
        goal: z.string().optional(),
        tone: z.string().optional(),
        difficulty: z
          .enum(["beginner", "intermediate", "advanced"])
          .optional(),
        status: z.enum(["draft", "published", "archived"]).optional(),
        ai_model: z.string().optional(),
        force_publish: z
          .boolean()
          .optional()
          .describe("Override soft publish-warnings (not hard blocks)"),
      },
      outputSchema: CourseEnvelope.extend({
        requiresConfirmation: z.boolean().optional(),
        validation: z.unknown().optional(),
      }),
      annotations: {
        title: "Update course",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id, force_publish, ...body }) => {
        const payload: Record<string, unknown> = { ...body };
        if (force_publish !== undefined) payload.forcePublish = force_publish;
        const data = await client.request<Record<string, unknown>>(
          `/api/courses/${course_id}`,
          { method: "PUT", body: payload },
        );
        const entity = (data.course ?? data) as Record<string, unknown>;
        const id = String(entity.id ?? course_id);
        const status = entity.status ?? "(unchanged)";
        return entityResult({
          entity: { ...entity, ...(data.requiresConfirmation !== undefined ? { requiresConfirmation: data.requiresConfirmation, validation: data.validation } : {}) },
          summary: data.requiresConfirmation
            ? `Update returned requiresConfirmation — re-call with force_publish=true to override.`
            : `Updated course '${entity.title}' (id=${id}), status=${status}.`,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", id),
          resource_uri: `flowlearn://course/${id}`,
          next_actions: data.requiresConfirmation
            ? [`flowlearn_course_update again with force_publish=true`]
            : status === "published"
              ? [`Course is live at ${editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", id)}`]
              : [`flowlearn_course_get with course_id="${id}" to verify`],
        });
      },
    },
    {
      name: "flowlearn_course_delete",
      description:
        "DESTRUCTIVE: permanently delete a course AND cascade-delete all its modules, lessons, flow steps, connections, and uploaded images. Cannot be undone.\n\n" +
        "When to use: removing a test/abandoned course at explicit user request.\n" +
        "When NOT to use: to retire a course while keeping data — use flowlearn_course_update with status='archived' instead.\n\n" +
        "Dry-run: pass dry_run=true to preview what would be deleted (returns course tree summary without mutating).\n\n" +
        'Example call: { "course_id": "crs_abc", "dry_run": true }  → preview\n' +
        '             { "course_id": "crs_abc" }                    → delete\n\n' +
        "Errors: FLOWLEARN_API_404 if id invalid; FLOWLEARN_API_403 if active tenant lacks delete role.",
      inputSchema: {
        course_id: z.string().min(1),
        ...DryRunField,
      },
      outputSchema: z.object({
        entity: z.object({ id: z.string(), deleted: z.boolean() }).passthrough(),
        summary: z.string(),
        next_actions: z.array(z.string()).optional(),
      }),
      annotations: {
        title: "Delete course",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id, dry_run }) => {
        if (dry_run) {
          try {
            const preview = await client.request<{ course?: Record<string, unknown> }>(
              `/api/courses/${course_id}`,
            );
            const c = (preview.course ?? preview) as Record<string, unknown>;
            const moduleCount = Array.isArray(c.modules) ? c.modules.length : "?";
            return entityResult({
              entity: { id: String(course_id), deleted: false, dry_run: true, would_delete: c },
              summary: `[dry-run] Would delete course '${c.title}' (id=${course_id}) and cascade ${moduleCount} modules + all lessons/steps/connections/images.`,
              next_actions: [`Re-call flowlearn_course_delete without dry_run to commit.`],
            });
          } catch {
            return errorResult({
              code: "DRY_RUN_PREVIEW_FAILED",
              message: `Could not fetch course ${course_id} to preview deletion.`,
              suggestion: "Check that the course_id exists via flowlearn_course_list.",
              retriable: false,
            });
          }
        }
        await client.request(`/api/courses/${course_id}`, { method: "DELETE" });
        return entityResult({
          entity: { id: String(course_id), deleted: true },
          summary: `Deleted course id=${course_id} and all child entities.`,
          next_actions: [`flowlearn_course_list to confirm removal`],
        });
      },
    },
  ];
}
