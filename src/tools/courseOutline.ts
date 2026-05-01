import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  IdempotencyField,
  editorUrl,
  entityResult,
  errorResult,
  getIdempotent,
  setIdempotent,
  type ToolDef,
  type ToolResult,
} from "./common.js";

/**
 * One-shot course authoring: take a nested outline and create the entire
 * course tree (course → modules → lessons → flow_steps → connections) in
 * a single tool call instead of 30+.
 *
 * Atomicity: best-effort. If any sub-call fails and rollback_on_error=true
 * (default), the partially-created course is deleted (cascade kills children).
 * Not a true DB transaction — intermediate state may briefly be visible to
 * other readers — but recovery is automatic.
 *
 * Idempotency: pass a single client_request_id at the outline level. Repeating
 * with the same key returns the cached full-tree response without re-creating
 * anything. Per-process cache; resets on MCP restart.
 */

const StepTypeEnum = z.enum(["message", "quiz", "exercise"]);
const ButtonActionEnum = z.enum(["next", "help", "skip", "custom", "branch"]);

const StepInput = z.object({
  title: z.string().min(1),
  content: z.string(),
  description: z.string().optional(),
  step_type: StepTypeEnum.optional(),
  is_starting_step: z.boolean().optional(),
});

const ConnectionInput = z.object({
  from_index: z
    .number()
    .int()
    .min(0)
    .describe("Index into the lesson's `steps` array"),
  to_index: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe("Index into `steps`, or null for terminal buttons"),
  button_text: z.string().min(1),
  button_action: ButtonActionEnum.optional(),
  button_order: z.number().int().min(1).optional(),
});

const LessonInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(StepInput).min(1),
  connections: z
    .array(ConnectionInput)
    .optional()
    .describe(
      "Optional. If omitted, defaults to a linear chain: step 0 → 1 → 2 → ... with 'Next' buttons.",
    ),
});

const ModuleInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  objectives: z.array(z.string()).optional(),
  lessons: z.array(LessonInput).min(1),
});

const CourseInput = z.object({
  title: z.string().min(1),
  topic: z.string().min(1),
  description: z
    .string()
    .min(20)
    .describe(
      "REQUIRED: 1-2 sentence summary of what the learner will be able to do after this course. Catalog renders 'No description provided' if absent — looks unfinished. Min 20 chars to prevent filler.",
    ),
  tone: z.string().optional(),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  language: z.string().optional(),
  modules: z.array(ModuleInput).min(1),
});

const OutlineEnvelope = z.object({
  entity: z.object({
    course: z.unknown(),
    stats: z.object({
      modules: z.number().int(),
      lessons: z.number().int(),
      flow_steps: z.number().int(),
      connections: z.number().int(),
    }),
    modules: z.array(z.unknown()),
    lessons: z.array(z.unknown()),
    flow_steps: z.array(z.unknown()),
    connections: z.array(z.unknown()),
    flow_completed_marked: z.boolean(),
    published: z.boolean(),
  }),
  summary: z.string(),
  url: z.string().optional(),
  resource_uri: z.string().optional(),
  next_actions: z.array(z.string()).optional(),
});

type CreatedTree = {
  course: Record<string, unknown> | null;
  modules: Record<string, unknown>[];
  lessons: Record<string, unknown>[];
  flow_steps: Record<string, unknown>[];
  connections: Record<string, unknown>[];
};

const OutlineDiffEnvelope = z.object({
  entity: z.object({
    summary: z.string(),
    changes: z.object({
      modules: z.object({
        added: z.array(z.object({ title: z.string() })),
        removed: z.array(z.object({ id: z.string(), title: z.string() })),
        renamed: z.array(
          z.object({ id: z.string(), old: z.string(), new: z.string() }),
        ),
      }),
      lessons: z.object({
        added: z.array(z.object({ module: z.string(), title: z.string() })),
        removed: z.array(z.object({ id: z.string(), title: z.string() })),
        renamed: z.array(
          z.object({ id: z.string(), old: z.string(), new: z.string() }),
        ),
      }),
      flow_steps: z.object({
        added: z.array(z.object({ lesson: z.string(), title: z.string() })),
        removed: z.array(
          z.object({ id: z.string(), lesson: z.string(), title: z.string() }),
        ),
        content_changed: z.array(
          z.object({ id: z.string(), lesson: z.string(), title: z.string() }),
        ),
      }),
      connections: z.object({ net_change: z.number().int() }),
    }),
  }),
  summary: z.string(),
  url: z.string().optional(),
  resource_uri: z.string().optional(),
  next_actions: z.array(z.string()).optional(),
});

type ExistingStep = {
  id: string;
  title: string;
  content: string;
};

type ExistingLesson = {
  id: string;
  title: string;
  steps: ExistingStep[];
  connectionCount: number;
};

type ExistingModule = {
  id: string;
  title: string;
  lessons: ExistingLesson[];
};

type ExistingCourseTree = {
  id: string;
  title: string;
  modules: ExistingModule[];
};

async function fetchExistingCourseTree(
  client: FlowlearnClient,
  courseId: string,
): Promise<ExistingCourseTree> {
  const courseResp = await client.request<{ course?: Record<string, unknown> }>(
    `/api/courses/${courseId}`,
  );
  const course = (courseResp.course ?? courseResp) as Record<string, unknown>;

  const modulesArr: Record<string, unknown>[] =
    (course.modules as Record<string, unknown>[] | undefined) ??
    (await client
      .request<{ modules?: unknown[] }>(`/api/courses/${courseId}/modules`)
      .then((d) =>
        Array.isArray(d) ? (d as Record<string, unknown>[]) : ((d.modules ?? []) as Record<string, unknown>[]),
      )) ??
    [];

  const modules: ExistingModule[] = [];
  for (const m of modulesArr) {
    const moduleId = String(m.id);
    const lessonsResp = await client.request<unknown>(
      `/api/modules/${moduleId}/lessons`,
    );
    const lessons = (Array.isArray(lessonsResp)
      ? lessonsResp
      : (lessonsResp as { lessons?: unknown[] })?.lessons ?? []) as Record<string, unknown>[];

    const lessonRecords: ExistingLesson[] = [];
    for (const l of lessons) {
      const lessonId = String(l.id);
      const stepsResp = await client.request<unknown>(
        `/api/lessons/${lessonId}/flow-steps`,
      );
      const steps = (Array.isArray(stepsResp)
        ? stepsResp
        : (stepsResp as { flow_steps?: unknown[] })?.flow_steps ?? []) as Record<string, unknown>[];
      steps.sort((a, b) => Number(a.order_index ?? 0) - Number(b.order_index ?? 0));

      let connectionCount = 0;
      const stepRecords: ExistingStep[] = steps.map((s) => {
        const conns = (s.connections as unknown[] | undefined) ?? [];
        connectionCount += conns.length;
        return {
          id: String(s.id),
          title: String(s.title ?? ""),
          content: String(s.content ?? ""),
        };
      });

      lessonRecords.push({
        id: lessonId,
        title: String(l.title ?? ""),
        steps: stepRecords,
        connectionCount,
      });
    }

    modules.push({
      id: moduleId,
      title: String(m.title ?? ""),
      lessons: lessonRecords,
    });
  }

  return {
    id: String(course.id ?? courseId),
    title: String(course.title ?? ""),
    modules,
  };
}

export function buildCourseOutlineTools(client: FlowlearnClient): ToolDef[] {
  const cfg = () => client.getConfig();

  return [
    {
      name: "flowlearn_course_outline_apply",
      description:
        "ONE-SHOT course creation: take a nested outline and build the entire course (course → modules → lessons → flow steps → connections) in a single call. Replaces 30+ individual tool calls.\n\n" +
        "When to use: scaffolding a NEW course from a structured outline the agent has already produced. Standard happy path for /flowlearn:scaffold_course.\n" +
        "When NOT to use: editing an existing course (use the per-entity update/create tools); when input is unstructured prose (parse first, then call this).\n\n" +
        "Atomicity: if any sub-call fails and rollback_on_error=true (default), the partially-created course is deleted via cascade. Not a true DB transaction — readers may briefly see partial state — but recovery is automatic.\n\n" +
        "Connections default: if a lesson omits `connections`, steps are wired in a linear chain with 'Next' buttons, PLUS a terminal 'Complete lesson' button on the last step (to_step_id=null) — without that terminal, the lesson's progress meter never reaches 100%. To override (branching, custom terminal text, multi-button steps), supply explicit connections referencing step indices into the lesson's `steps` array.\n\n" +
        "Starting step: the first step in each lesson auto-gets is_starting_step=true unless one of the steps has it set explicitly.\n\n" +
        "Idempotent retry: pass client_request_id; same key on retry returns cached result without re-creating.\n\n" +
        "Dry-run: pass dry_run=true to validate the structure and return the plan WITHOUT mutating.\n\n" +
        'Example call: { "course": { "title": "Spanish Greetings", "topic": "Greetings in Spanish", "description": "Learn the most common Spanish greetings and when to use each one in everyday conversation.", "modules": [{ "title": "Hellos", "lessons": [{ "title": "Saying Hello", "steps": [{"title":"Buenos días","content":"Means good morning."},{"title":"Hola","content":"Most common greeting."}] }] }] } }\n\n' +
        "Errors: INVALID_ARGUMENTS on schema violations (Zod). Underlying FLOWLEARN_API_* errors abort the build; if rollback_on_error=true the course is deleted before the error returns. Returns a wrapped FLOWLEARN_API_* with details.partial_tree showing what was created before failure.",
      inputSchema: {
        course: CourseInput,
        mark_flow_completed: z
          .boolean()
          .optional()
          .describe(
            "Default true. After every lesson is built, mark it flow_completed=true so the course is publish-ready.",
          ),
        publish: z
          .boolean()
          .optional()
          .describe(
            "Default false. If true, set status='published' on the course after building (with force_publish=true to bypass warnings).",
          ),
        rollback_on_error: z
          .boolean()
          .optional()
          .describe(
            "Default true. If a sub-call fails partway through, delete the course (cascade kills children).",
          ),
        ...IdempotencyField,
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "If true, validate and return the plan without mutating. No idempotency key consumed.",
          ),
      },
      outputSchema: OutlineEnvelope,
      annotations: {
        title: "Apply outline (one-shot course creation)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args) => {
        const {
          course,
          mark_flow_completed = true,
          publish = false,
          rollback_on_error = true,
          client_request_id,
          dry_run,
        } = args as {
          course: z.infer<typeof CourseInput>;
          mark_flow_completed?: boolean;
          publish?: boolean;
          rollback_on_error?: boolean;
          client_request_id?: string;
          dry_run?: boolean;
        };

        // Dry-run: skip idempotency cache (no side effects), return plan.
        if (dry_run) {
          // Validate connection ranges up-front so a successful dry-run mirrors
          // what the live branch will accept. Mirrors lines 303-312 of the
          // live branch.
          for (const m of course.modules) {
            for (const l of m.lessons) {
              const stepCount = l.steps.length;
              const conns = l.connections ?? defaultLinearChain(stepCount);
              for (const c of conns) {
                if (c.from_index >= stepCount || c.from_index < 0) {
                  return errorResult({
                    code: "OUTLINE_VALIDATION",
                    message: `${l.title}: connection.from_index=${c.from_index} out of range (lesson has ${stepCount} steps).`,
                    retriable: true,
                  });
                }
                if (
                  c.to_index !== null &&
                  (c.to_index >= stepCount || c.to_index < 0)
                ) {
                  return errorResult({
                    code: "OUTLINE_VALIDATION",
                    message: `${l.title}: connection.to_index=${c.to_index} out of range (lesson has ${stepCount} steps).`,
                    retriable: true,
                  });
                }
              }
            }
          }

          return entityResult({
            entity: {
              course: { ...course, modules: undefined },
              stats: countTree(course),
              modules: course.modules.map((m) => ({
                title: m.title,
                lesson_count: m.lessons.length,
              })),
              lessons: course.modules.flatMap((m) =>
                m.lessons.map((l) => ({
                  module: m.title,
                  title: l.title,
                  step_count: l.steps.length,
                  connection_count: (l.connections ?? defaultLinearChain(l.steps.length)).length,
                })),
              ),
              flow_steps: [],
              connections: [],
              flow_completed_marked: mark_flow_completed,
              published: publish,
            },
            summary: `[dry-run] Would create course '${course.title}' with ${countTree(course).modules} modules, ${countTree(course).lessons} lessons, ${countTree(course).flow_steps} flow steps, ${countTree(course).connections} connections.${mark_flow_completed ? " All lessons would be marked flow_completed=true." : ""}${publish ? " Course would be published." : ""}`,
            next_actions: [`Re-call without dry_run to commit.`],
          });
        }

        const cached = getIdempotent(client_request_id);
        if (cached) return cached;

        const created: CreatedTree = {
          course: null,
          modules: [],
          lessons: [],
          flow_steps: [],
          connections: [],
        };

        try {
          // 1. Create the course.
          const courseResp = await client.request<{ course?: Record<string, unknown> }>(
            "/api/courses",
            {
              method: "POST",
              body: {
                title: course.title,
                topic: course.topic,
                description: course.description,
                tone: course.tone,
                difficulty: course.difficulty,
                language: course.language,
              },
            },
          );
          const courseEntity = (courseResp.course ?? courseResp) as Record<string, unknown>;
          created.course = courseEntity;
          const courseId = String(courseEntity.id);

          // 2. For each module → lesson → step → connection.
          for (const m of course.modules) {
            const moduleResp = await client.request<{ module?: Record<string, unknown> }>(
              `/api/courses/${courseId}/modules`,
              {
                method: "POST",
                body: {
                  title: m.title,
                  description: m.description,
                  content: m.objectives ? { objectives: m.objectives } : undefined,
                },
              },
            );
            const moduleEntity = (moduleResp.module ?? moduleResp) as Record<string, unknown>;
            created.modules.push(moduleEntity);
            const moduleId = String(moduleEntity.id);

            for (const l of m.lessons) {
              const lessonResp = await client.request<{ lesson?: Record<string, unknown> }>(
                `/api/modules/${moduleId}/lessons`,
                {
                  method: "POST",
                  body: { title: l.title, description: l.description },
                },
              );
              const lessonEntity = (lessonResp.lesson ?? lessonResp) as Record<string, unknown>;
              created.lessons.push(lessonEntity);
              const lessonId = String(lessonEntity.id);

              // Decide which step is the starter.
              const explicitStarter = l.steps.findIndex((s) => s.is_starting_step === true);
              const starterIdx = explicitStarter >= 0 ? explicitStarter : 0;

              // Create steps; capture ids for connection wiring.
              const stepIds: string[] = [];
              for (let i = 0; i < l.steps.length; i++) {
                const s = l.steps[i];
                const stepResp = await client.request<{ flow_step?: Record<string, unknown> }>(
                  `/api/lessons/${lessonId}/flow-steps`,
                  {
                    method: "POST",
                    body: {
                      title: s.title,
                      content: s.content,
                      description: s.description,
                      step_type: s.step_type ?? "message",
                      is_starting_step: i === starterIdx,
                    },
                  },
                );
                const stepEntity = (stepResp.flow_step ?? stepResp) as Record<string, unknown>;
                created.flow_steps.push(stepEntity);
                stepIds.push(String(stepEntity.id));
              }

              // Wire connections.
              const conns = l.connections ?? defaultLinearChain(l.steps.length);
              for (const c of conns) {
                if (c.from_index >= stepIds.length || c.from_index < 0) {
                  throw new OutlineValidationError(
                    `connection.from_index=${c.from_index} out of range (lesson '${l.title}' has ${stepIds.length} steps).`,
                  );
                }
                if (c.to_index !== null && (c.to_index >= stepIds.length || c.to_index < 0)) {
                  throw new OutlineValidationError(
                    `connection.to_index=${c.to_index} out of range (lesson '${l.title}' has ${stepIds.length} steps).`,
                  );
                }
                const connResp = await client.request<{ connection?: Record<string, unknown> }>(
                  `/api/flow-steps/${stepIds[c.from_index]}/connections`,
                  {
                    method: "POST",
                    body: {
                      to_step_id: c.to_index === null ? null : stepIds[c.to_index],
                      button_text: c.button_text,
                      button_action: c.button_action ?? "next",
                      button_order: c.button_order ?? 1,
                    },
                  },
                );
                const connEntity = (connResp.connection ?? connResp) as Record<string, unknown>;
                created.connections.push(connEntity);
              }

              // Mark lesson flow_completed.
              if (mark_flow_completed) {
                await client.request(`/api/lessons/${lessonId}`, {
                  method: "PUT",
                  body: { flow_completed: true },
                });
              }
            }
          }

          // 3. Optional publish.
          let published = false;
          if (publish) {
            await client.request(`/api/courses/${courseId}`, {
              method: "PUT",
              body: { status: "published", forcePublish: true },
            });
            published = true;
          }

          const stats = {
            modules: created.modules.length,
            lessons: created.lessons.length,
            flow_steps: created.flow_steps.length,
            connections: created.connections.length,
          };

          const result = entityResult({
            entity: {
              course: courseEntity,
              stats,
              modules: created.modules,
              lessons: created.lessons,
              flow_steps: created.flow_steps,
              connections: created.connections,
              flow_completed_marked: mark_flow_completed,
              published,
            },
            summary: `Created course '${course.title}' (id=${courseId}) with ${stats.modules} modules, ${stats.lessons} lessons, ${stats.flow_steps} flow steps, ${stats.connections} connections${mark_flow_completed ? ", all flow_completed=true" : ""}${published ? ", status=published" : ""}.`,
            url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", courseId),
            resource_uri: `flowlearn://course/${courseId}`,
            next_actions: published
              ? [`Course is live at ${editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", courseId)}`]
              : [
                  `flowlearn_course_lint with course_id="${courseId}" to verify publish-readiness`,
                  `flowlearn_course_update with course_id="${courseId}" + status="published" to publish`,
                ],
          });
          setIdempotent(client_request_id, result);
          return result;
        } catch (err) {
          const partial = {
            course_id: created.course ? String((created.course as Record<string, unknown>).id) : null,
            modules_created: created.modules.length,
            lessons_created: created.lessons.length,
            flow_steps_created: created.flow_steps.length,
            connections_created: created.connections.length,
          };

          let rolledBackOk = false;
          let rollbackError: string | undefined;
          if (rollback_on_error && created.course) {
            try {
              await client.request(`/api/courses/${partial.course_id}`, { method: "DELETE" });
              rolledBackOk = true;
            } catch (rbErr) {
              rolledBackOk = false;
              rollbackError = rbErr instanceof Error ? rbErr.message : String(rbErr);
            }
          }

          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof OutlineValidationError ? "OUTLINE_VALIDATION" : "OUTLINE_BUILD_FAILED";

          let suggestion: string;
          if (!rollback_on_error) {
            suggestion =
              "Course was NOT rolled back (rollback_on_error=false). Use flowlearn_course_get to inspect partial state, or flowlearn_course_delete to clean up.";
          } else if (rolledBackOk) {
            suggestion =
              "Partial course was rolled back (deleted). Inspect details.partial_tree for what had been created.";
          } else if (created.course) {
            suggestion = `Rollback DELETE itself failed (see details.rollback_error). The partial course at id=${partial.course_id} still exists; call flowlearn_course_delete manually.`;
          } else {
            suggestion =
              "No course was created before failure — nothing to roll back. Inspect details.partial_tree for context.";
          }

          const details: Record<string, unknown> = {
            partial_tree: partial,
            rolled_back: rolledBackOk,
          };
          if (rollbackError !== undefined) {
            details.rollback_error = rollbackError;
          }

          return errorResult({
            code,
            message: `outline_apply failed: ${message}`,
            suggestion,
            retriable: false,
            details,
          }) satisfies ToolResult;
        }
      },
    },
    {
      name: "flowlearn_course_outline_diff",
      description:
        "PREVIEW the structural diff between a proposed outline tree and an existing flowlearn course, WITHOUT mutating anything. Read-only sibling of flowlearn_course_outline_apply — same input shape on the `proposed` field.\n\n" +
        "When to use: before re-applying an edited export to compare 'what's there' vs 'what I want'; before a destructive sync to surface what would change; for human review of agent-proposed restructures.\n" +
        "When NOT to use: actually applying changes (this is read-only — there is intentionally NO outline_apply_diff yet); fine-grained per-step content auditing (use flowlearn_course_lint or the /flowlearn:author_review prompt).\n\n" +
        "Comparison granularity: module/lesson titles by position, step titles + content (length-only signal — full text NOT diffed unless ignore.content=false), connection counts per lesson. Renames are detected by index position (module 1 'Intro' → 'Welcome' = renamed). Full structural reconciliation is out of scope.\n\n" +
        'Example call: { "course_id": "crs_abc", "proposed": { "title": "Spanish Greetings", "topic": "Greetings", "modules": [{ "title": "Hellos", "lessons": [{ "title": "Saying Hello", "steps": [{"title":"Hola","content":"Most common greeting."}] }] }] } }\n\n' +
        "Errors: FLOWLEARN_API_404 if course_id invalid; INVALID_ARGUMENTS if proposed schema fails Zod validation.",
      inputSchema: {
        course_id: z.string().min(1),
        proposed: CourseInput.extend({
          description: z
            .string()
            .optional()
            .describe(
              "Optional in diff context — an empty/missing description means 'no change requested for this field'. (Required for outline_apply.)",
            ),
        }),
        ignore: z
          .object({
            titles: z
              .boolean()
              .optional()
              .describe("If true, suppress rename detection (titles[].renamed)."),
            content: z
              .boolean()
              .optional()
              .describe(
                "If true, do not flag step content_changed entries. Default false (changes ARE reported).",
              ),
          })
          .optional(),
      },
      outputSchema: OutlineDiffEnvelope,
      annotations: {
        title: "Diff outline against existing course",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (args) => {
        const { course_id, proposed, ignore } = args as {
          course_id: string;
          proposed: z.infer<typeof CourseInput> & { description?: string };
          ignore?: { titles?: boolean; content?: boolean };
        };
        const ignoreTitles = ignore?.titles === true;
        const ignoreContent = ignore?.content === true;

        // Walk the existing course tree.
        let existing: ExistingCourseTree;
        try {
          existing = await fetchExistingCourseTree(client, course_id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult({
            code: "OUTLINE_DIFF_FETCH_FAILED",
            message: `Could not load course id=${course_id}: ${message}`,
            suggestion:
              "Verify course_id with flowlearn_course_list. If correct, the API may be transiently unavailable; retry.",
            retriable: true,
          });
        }

        // Module-level diff (positional).
        const moduleAdded: { title: string }[] = [];
        const moduleRemoved: { id: string; title: string }[] = [];
        const moduleRenamed: { id: string; old: string; new: string }[] = [];

        const lessonAdded: { module: string; title: string }[] = [];
        const lessonRemoved: { id: string; title: string }[] = [];
        const lessonRenamed: { id: string; old: string; new: string }[] = [];

        const stepAdded: { lesson: string; title: string }[] = [];
        const stepRemoved: { id: string; lesson: string; title: string }[] = [];
        const stepContentChanged: { id: string; lesson: string; title: string }[] = [];

        let proposedConnTotal = 0;
        let existingConnTotal = 0;

        const maxModules = Math.max(proposed.modules.length, existing.modules.length);
        for (let mi = 0; mi < maxModules; mi++) {
          const pm = proposed.modules[mi];
          const em = existing.modules[mi];
          if (pm && !em) {
            moduleAdded.push({ title: pm.title });
            // All lessons / steps under a new module are also "added".
            for (const pl of pm.lessons) {
              lessonAdded.push({ module: pm.title, title: pl.title });
              for (const ps of pl.steps) {
                stepAdded.push({ lesson: pl.title, title: ps.title });
              }
              proposedConnTotal += (pl.connections ?? defaultLinearChain(pl.steps.length)).length;
            }
            continue;
          }
          if (!pm && em) {
            moduleRemoved.push({ id: em.id, title: em.title });
            for (const el of em.lessons) {
              lessonRemoved.push({ id: el.id, title: el.title });
              for (const es of el.steps) {
                stepRemoved.push({ id: es.id, lesson: el.title, title: es.title });
              }
              existingConnTotal += el.connectionCount;
            }
            continue;
          }
          if (!pm || !em) continue; // unreachable, but pleases TS

          if (!ignoreTitles && pm.title !== em.title) {
            moduleRenamed.push({ id: em.id, old: em.title, new: pm.title });
          }

          // Lesson-level diff within this module (positional).
          const maxLessons = Math.max(pm.lessons.length, em.lessons.length);
          for (let li = 0; li < maxLessons; li++) {
            const pl = pm.lessons[li];
            const el = em.lessons[li];
            if (pl && !el) {
              lessonAdded.push({ module: pm.title, title: pl.title });
              for (const ps of pl.steps) {
                stepAdded.push({ lesson: pl.title, title: ps.title });
              }
              proposedConnTotal += (pl.connections ?? defaultLinearChain(pl.steps.length)).length;
              continue;
            }
            if (!pl && el) {
              lessonRemoved.push({ id: el.id, title: el.title });
              for (const es of el.steps) {
                stepRemoved.push({ id: es.id, lesson: el.title, title: es.title });
              }
              existingConnTotal += el.connectionCount;
              continue;
            }
            if (!pl || !el) continue;

            if (!ignoreTitles && pl.title !== el.title) {
              lessonRenamed.push({ id: el.id, old: el.title, new: pl.title });
            }

            proposedConnTotal += (pl.connections ?? defaultLinearChain(pl.steps.length)).length;
            existingConnTotal += el.connectionCount;

            // Step-level diff within this lesson (positional).
            const maxSteps = Math.max(pl.steps.length, el.steps.length);
            for (let si = 0; si < maxSteps; si++) {
              const ps = pl.steps[si];
              const es = el.steps[si];
              if (ps && !es) {
                stepAdded.push({ lesson: pl.title, title: ps.title });
                continue;
              }
              if (!ps && es) {
                stepRemoved.push({ id: es.id, lesson: el.title, title: es.title });
                continue;
              }
              if (!ps || !es) continue;
              if (!ignoreContent && ps.content !== es.content) {
                stepContentChanged.push({ id: es.id, lesson: el.title, title: ps.title });
              }
            }
          }
        }

        const netConn = proposedConnTotal - existingConnTotal;
        const summaryParts: string[] = [];
        if (moduleAdded.length) summaryParts.push(`+${moduleAdded.length} modules`);
        if (moduleRemoved.length) summaryParts.push(`-${moduleRemoved.length} modules`);
        if (lessonAdded.length) summaryParts.push(`+${lessonAdded.length} lessons`);
        if (lessonRemoved.length) summaryParts.push(`-${lessonRemoved.length} lessons`);
        if (stepAdded.length) summaryParts.push(`+${stepAdded.length} steps`);
        if (stepRemoved.length) summaryParts.push(`-${stepRemoved.length} steps`);
        if (stepContentChanged.length) summaryParts.push(`~${stepContentChanged.length} step content changes`);
        const summary =
          summaryParts.length === 0
            ? `Course '${existing.title}': proposed tree matches existing structure (no changes).`
            : `Course '${existing.title}': ${summaryParts.join(", ")}.`;

        return entityResult({
          entity: {
            summary,
            changes: {
              modules: {
                added: moduleAdded,
                removed: moduleRemoved,
                renamed: moduleRenamed,
              },
              lessons: {
                added: lessonAdded,
                removed: lessonRemoved,
                renamed: lessonRenamed,
              },
              flow_steps: {
                added: stepAdded,
                removed: stepRemoved,
                content_changed: stepContentChanged,
              },
              connections: {
                net_change: netConn,
              },
            },
          },
          summary,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", course_id),
          resource_uri: `flowlearn://course/${course_id}`,
          next_actions: [
            `Review the diff, then call flowlearn_course_outline_apply_diff with the same { course_id, proposed } to apply the changes. Or edit per-entity (flowlearn_lesson_update, flowlearn_flow_step_update, etc.) for surgical control.`,
          ],
        });
      },
    },
  ];
}

function defaultLinearChain(stepCount: number): z.infer<typeof ConnectionInput>[] {
  const conns: z.infer<typeof ConnectionInput>[] = [];
  // Chain consecutive steps with "Next" buttons.
  for (let i = 0; i < stepCount - 1; i++) {
    conns.push({
      from_index: i,
      to_index: i + 1,
      button_text: "Next",
      button_action: "next",
      button_order: 1,
    });
  }
  // Terminal button on the last step. Without this, the last step has no
  // outgoing edge and flowlearn's progress meter never reaches 100% — the
  // lesson appears permanently incomplete. The button has to_step_id=null
  // (terminal); clicking it registers completion.
  if (stepCount > 0) {
    conns.push({
      from_index: stepCount - 1,
      to_index: null,
      button_text: "Complete lesson",
      button_action: "next",
      button_order: 1,
    });
  }
  return conns;
}

function countTree(course: z.infer<typeof CourseInput>): {
  modules: number;
  lessons: number;
  flow_steps: number;
  connections: number;
} {
  let lessons = 0;
  let flow_steps = 0;
  let connections = 0;
  for (const m of course.modules) {
    lessons += m.lessons.length;
    for (const l of m.lessons) {
      flow_steps += l.steps.length;
      connections += (l.connections ?? defaultLinearChain(l.steps.length)).length;
    }
  }
  return { modules: course.modules.length, lessons, flow_steps, connections };
}

class OutlineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutlineValidationError";
  }
}
