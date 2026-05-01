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
        const base = entityResult({
          entity,
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
        // Surface requiresConfirmation/validation at the envelope ROOT — they
        // describe THIS call (a soft block on publish), not the course entity.
        if (data.requiresConfirmation !== undefined) {
          const sc = base.structuredContent ?? {};
          base.structuredContent = {
            ...sc,
            requiresConfirmation: data.requiresConfirmation,
            validation: data.validation,
          };
          base.content = [
            { type: "text", text: JSON.stringify(base.structuredContent, null, 2) },
            ...base.content.filter((c) => c.type !== "text"),
          ];
        }
        return base;
      },
    },
    {
      name: "flowlearn_course_unpublish",
      description:
        "Move a published course back to draft (status='draft'). Thin wrapper around flowlearn_course_update.\n\n" +
        "When to use: pull a live course offline so you can edit aggressively without learners seeing partial state.\n" +
        "When NOT to use: to permanently retire a course — use flowlearn_course_update with status='archived' instead; to delete — use flowlearn_course_delete.\n\n" +
        "Idempotent: calling on an already-draft course is a no-op (still returns the current entity).\n" +
        "Dry-run: pass dry_run=true to preview without mutating.\n\n" +
        'Example call: { "course_id": "crs_abc", "dry_run": true }\n\n' +
        "Errors: FLOWLEARN_API_404 if course_id invalid.",
      inputSchema: {
        course_id: z.string().min(1),
        ...DryRunField,
      },
      outputSchema: CourseEnvelope,
      annotations: {
        title: "Unpublish course",
        readOnlyHint: false,
        destructiveHint: false,
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
            return entityResult({
              entity: c,
              summary: `[dry-run] Would unpublish course '${c.title}' (id=${course_id}, current status: ${c.status ?? "?"}). Result status would be 'draft'.`,
              next_actions: [`Re-call without dry_run to commit.`],
            });
          } catch {
            return errorResult({
              code: "FLOWLEARN_API_404",
              message: `Course ${course_id} not found.`,
              suggestion: "Verify the course_id via flowlearn_course_list.",
              retriable: false,
            });
          }
        }
        const data = await client.request<Record<string, unknown>>(
          `/api/courses/${course_id}`,
          { method: "PUT", body: { status: "draft" } },
        );
        const entity = (data.course ?? data) as Record<string, unknown>;
        const id = String(entity.id ?? course_id);
        return entityResult({
          entity,
          summary: `Unpublished course '${entity.title}' (id=${id}); status is now draft.`,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", id),
          resource_uri: `flowlearn://course/${id}`,
          next_actions: [
            `flowlearn_course_update with course_id="${id}" + status="published" to re-publish when ready`,
          ],
        });
      },
    },
    {
      name: "flowlearn_course_duplicate",
      description:
        "Deep-copy a course as a new draft. Replicates the full tree: course metadata + modules + lessons + flow steps + connections.\n\n" +
        "When to use: foundation for course templates, A/B variants, or branching off a stable course for major edits without disturbing the original.\n" +
        "When NOT to use: when you only need to edit the original (use flowlearn_course_update); when uploaded images must be carried over — IMAGES ARE NOT COPIED in this duplication (image bytes live in flowlearn storage; the duplicate's flow steps reference no image until you re-upload). Re-upload images via flowlearn_flow_step_upload_image after duplication.\n\n" +
        "The new course is always created as a draft. Title defaults to '<original title> (copy)' unless new_title is supplied.\n" +
        "Atomicity: best-effort. On any sub-call failure, the partially-created copy is deleted (cascade). Same pattern as outline_apply.\n" +
        "Idempotent retry: pass client_request_id.\n" +
        "Dry-run: pass dry_run=true to preview the copy size without mutating.\n\n" +
        'Example call: { "source_course_id": "crs_abc", "new_title": "Spanish Greetings v2" }\n\n' +
        "Errors: FLOWLEARN_API_404 if source_course_id invalid; FLOWLEARN_API_* on any sub-create.",
      inputSchema: {
        source_course_id: z.string().min(1),
        new_title: z
          .string()
          .min(1)
          .optional()
          .describe("Defaults to '<original title> (copy)'"),
        ...IdempotencyField,
        ...DryRunField,
      },
      outputSchema: CourseEnvelope,
      annotations: {
        title: "Duplicate course (deep copy)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ source_course_id, new_title, client_request_id, dry_run }) => {
        // Walk the source tree.
        let sourceCourse: Record<string, unknown>;
        try {
          const courseResp = await client.request<{ course?: Record<string, unknown> }>(
            `/api/courses/${source_course_id}`,
          );
          sourceCourse = (courseResp.course ?? courseResp) as Record<string, unknown>;
        } catch {
          return errorResult({
            code: "FLOWLEARN_API_404",
            message: `Source course ${source_course_id} not found.`,
            suggestion: "Verify the course_id via flowlearn_course_list.",
            retriable: false,
          });
        }

        const targetTitle =
          (new_title as string | undefined) ??
          `${sourceCourse.title ?? "Untitled"} (copy)`;

        // Walk modules → lessons → steps → connections to count + plan.
        type StepPlan = { source: Record<string, unknown> };
        type LessonPlan = {
          source: Record<string, unknown>;
          steps: StepPlan[];
          connections: Record<string, unknown>[];
        };
        type ModulePlan = {
          source: Record<string, unknown>;
          lessons: LessonPlan[];
        };
        const plan: ModulePlan[] = [];

        const sourceModulesResp = await client.request<unknown>(
          `/api/courses/${source_course_id}/modules`,
        );
        const sourceModules = (Array.isArray(sourceModulesResp)
          ? sourceModulesResp
          : (sourceModulesResp as { modules?: unknown[] })?.modules ?? []) as Record<
          string,
          unknown
        >[];

        let lessonCount = 0;
        let stepCount = 0;
        let connCount = 0;

        for (const mod of sourceModules) {
          const lessonsResp = await client.request<unknown>(
            `/api/modules/${mod.id}/lessons`,
          );
          const sourceLessons = (Array.isArray(lessonsResp)
            ? lessonsResp
            : (lessonsResp as { lessons?: unknown[] })?.lessons ?? []) as Record<
            string,
            unknown
          >[];
          const lessonsPlan: LessonPlan[] = [];
          for (const lsn of sourceLessons) {
            const stepsResp = await client.request<unknown>(
              `/api/lessons/${lsn.id}/flow-steps`,
            );
            const sourceSteps = (Array.isArray(stepsResp)
              ? stepsResp
              : (stepsResp as { flow_steps?: unknown[] })?.flow_steps ?? []) as Record<
              string,
              unknown
            >[];
            const conns: Record<string, unknown>[] = [];
            for (const st of sourceSteps) {
              const connResp = await client.request<unknown>(
                `/api/flow-steps/${st.id}/connections`,
              );
              const stepConns = (Array.isArray(connResp)
                ? connResp
                : (connResp as { connections?: unknown[] })?.connections ?? []) as Record<
                string,
                unknown
              >[];
              for (const c of stepConns) {
                conns.push({ ...c, _from_source_step_id: st.id });
              }
            }
            lessonsPlan.push({
              source: lsn,
              steps: sourceSteps.map((s) => ({ source: s })),
              connections: conns,
            });
            lessonCount += 1;
            stepCount += sourceSteps.length;
            connCount += conns.length;
          }
          plan.push({ source: mod, lessons: lessonsPlan });
        }

        if (dry_run) {
          return entityResult({
            entity: { ...sourceCourse, title: targetTitle, status: "draft" },
            summary: `[dry-run] Would duplicate course '${sourceCourse.title}' (id=${source_course_id}) as '${targetTitle}' with ${plan.length} modules, ${lessonCount} lessons, ${stepCount} steps, ${connCount} connections. Images will NOT be copied.`,
            next_actions: [`Re-call without dry_run to commit.`],
          });
        }

        const cached = getIdempotent(client_request_id as string | undefined);
        if (cached) return cached;

        // Build the copy. Track the new course id for rollback.
        let newCourseId: string | null = null;
        try {
          const courseResp = await client.request<{ course?: Record<string, unknown> }>(
            "/api/courses",
            {
              method: "POST",
              body: {
                title: targetTitle,
                topic: sourceCourse.topic,
                description: sourceCourse.description,
                tone: sourceCourse.tone,
                difficulty: sourceCourse.difficulty,
                language: sourceCourse.language,
              },
            },
          );
          const newCourse = (courseResp.course ?? courseResp) as Record<string, unknown>;
          newCourseId = String(newCourse.id);

          for (const mp of plan) {
            const modResp = await client.request<{ module?: Record<string, unknown> }>(
              `/api/courses/${newCourseId}/modules`,
              {
                method: "POST",
                body: {
                  title: mp.source.title,
                  description: mp.source.description,
                  content: mp.source.content,
                },
              },
            );
            const newMod = (modResp.module ?? modResp) as Record<string, unknown>;
            const newModId = String(newMod.id);

            for (const lp of mp.lessons) {
              const lsnResp = await client.request<{ lesson?: Record<string, unknown> }>(
                `/api/modules/${newModId}/lessons`,
                {
                  method: "POST",
                  body: {
                    title: lp.source.title,
                    description: lp.source.description,
                    content: lp.source.content,
                  },
                },
              );
              const newLsn = (lsnResp.lesson ?? lsnResp) as Record<string, unknown>;
              const newLsnId = String(newLsn.id);

              // Create steps; map old id → new id for connection rewiring.
              const idMap = new Map<string, string>();
              for (const sp of lp.steps) {
                const s = sp.source;
                const stepResp = await client.request<{
                  flow_step?: Record<string, unknown>;
                }>(`/api/lessons/${newLsnId}/flow-steps`, {
                  method: "POST",
                  body: {
                    title: s.title,
                    content: s.content,
                    description: s.description,
                    step_type: s.step_type ?? "message",
                    is_starting_step: s.is_starting_step ?? false,
                  },
                });
                const newStep = (stepResp.flow_step ?? stepResp) as Record<string, unknown>;
                idMap.set(String(s.id), String(newStep.id));
              }

              for (const c of lp.connections) {
                const fromOld = String(c._from_source_step_id);
                const toOld = c.to_step_id == null ? null : String(c.to_step_id);
                const newFrom = idMap.get(fromOld);
                const newTo = toOld == null ? null : idMap.get(toOld) ?? null;
                if (!newFrom) continue;
                await client.request(`/api/flow-steps/${newFrom}/connections`, {
                  method: "POST",
                  body: {
                    to_step_id: newTo,
                    button_text: c.button_text,
                    button_action: c.button_action ?? "next",
                    button_order: c.button_order ?? 1,
                  },
                });
              }

              if (lp.source.flow_completed) {
                await client.request(`/api/lessons/${newLsnId}`, {
                  method: "PUT",
                  body: { flow_completed: true },
                });
              }
            }
          }

          const result = entityResult({
            entity: { ...newCourse, title: targetTitle },
            summary: `Duplicated course '${sourceCourse.title}' (id=${source_course_id}) as '${targetTitle}' (id=${newCourseId}) with ${plan.length} modules, ${lessonCount} lessons, ${stepCount} steps, ${connCount} connections. Images were NOT copied.`,
            url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", newCourseId),
            resource_uri: `flowlearn://course/${newCourseId}`,
            next_actions: [
              `flowlearn_course_get with course_id="${newCourseId}" to inspect`,
              `flowlearn_flow_step_upload_image to re-attach images on the new steps`,
            ],
          });
          setIdempotent(client_request_id as string | undefined, result);
          return result;
        } catch (err) {
          if (newCourseId) {
            try {
              await client.request(`/api/courses/${newCourseId}`, { method: "DELETE" });
            } catch {
              // swallow rollback failure — surface the original error
            }
          }
          const message = err instanceof Error ? err.message : String(err);
          return errorResult({
            code: "COURSE_DUPLICATE_FAILED",
            message: `course_duplicate failed: ${message}`,
            suggestion:
              "Partial copy was rolled back (deleted). Inspect details for what had been created.",
            retriable: false,
            details: {
              source_course_id: String(source_course_id),
              partial_course_id: newCourseId,
              rolled_back: !!newCourseId,
            },
          });
        }
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
