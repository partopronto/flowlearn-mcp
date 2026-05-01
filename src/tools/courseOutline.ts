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
  description: z.string().optional(),
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
        'Example call: { "course": { "title": "Spanish Greetings", "topic": "Greetings in Spanish", "modules": [{ "title": "Hellos", "lessons": [{ "title": "Saying Hello", "steps": [{"title":"Buenos días","content":"Means good morning."},{"title":"Hola","content":"Most common greeting."}] }] }] } }\n\n' +
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

          if (rollback_on_error && created.course) {
            try {
              await client.request(`/api/courses/${partial.course_id}`, { method: "DELETE" });
            } catch {
              // swallow rollback failure — surface the original error
            }
          }

          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof OutlineValidationError ? "OUTLINE_VALIDATION" : "OUTLINE_BUILD_FAILED";
          return errorResult({
            code,
            message: `outline_apply failed: ${message}`,
            suggestion: rollback_on_error
              ? "Partial course was rolled back (deleted). Inspect details.partial_tree for what had been created."
              : "Course was NOT rolled back (rollback_on_error=false). Use flowlearn_course_get to inspect partial state, or flowlearn_course_delete to clean up.",
            retriable: false,
            details: { partial_tree: partial, rolled_back: rollback_on_error && !!created.course },
          }) satisfies ToolResult;
        }
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
