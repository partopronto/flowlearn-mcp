import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import {
  DryRunField,
  IdempotencyField,
  editorUrl,
  entityResult,
  errorResult,
  getIdempotent,
  setIdempotent,
  type ToolDef,
} from "./common.js";

/**
 * Stateless apply of the same diff that outline_diff produces.
 *
 * Ownership note: fetchExistingCourseTree is DELIBERATELY duplicated here
 * from courseOutline.ts to keep ownership clean. Neither file imports from
 * the other; both are independent build units. If the shape of the tree ever
 * diverges, each tool can evolve independently.
 */

// ---------------------------------------------------------------------------
// Shared Zod schemas (duplicated from courseOutline.ts intentionally)
// ---------------------------------------------------------------------------

const StepTypeEnum = z.enum(["message", "quiz", "exercise"]);
const ButtonActionEnum = z.enum(["next", "help", "skip", "custom", "branch"]);

const StepInput = z.object({
  title: z.string().min(1).describe("Step title"),
  content: z.string().describe("Step body text"),
  description: z.string().optional().describe("Optional step description"),
  step_type: StepTypeEnum.optional().describe("Defaults to 'message' server-side"),
  is_starting_step: z.boolean().optional().describe("Mark as the lesson's entry point"),
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
  button_text: z.string().min(1).describe("Button label"),
  button_action: ButtonActionEnum.optional().describe("Defaults to 'next'"),
  button_order: z.number().int().min(1).optional().describe("Display order among buttons"),
});

const LessonInput = z.object({
  title: z.string().min(1).describe("Lesson title"),
  description: z.string().optional().describe("Optional lesson description"),
  steps: z.array(StepInput).min(1).describe("Ordered list of flow steps"),
  connections: z
    .array(ConnectionInput)
    .optional()
    .describe(
      "Optional. If omitted, defaults to a linear chain: step 0→1→…→N with 'Next' buttons plus a terminal 'Complete lesson' button.",
    ),
});

const ModuleInput = z.object({
  title: z.string().min(1).describe("Module title"),
  description: z.string().optional().describe("Optional module description"),
  objectives: z.array(z.string()).optional().describe("Learning objectives"),
  lessons: z.array(LessonInput).min(1).describe("Ordered list of lessons"),
});

const ProposedCourseInput = z.object({
  title: z.string().min(1).describe("Course title"),
  topic: z.string().min(1).describe("Course topic"),
  description: z
    .string()
    .optional()
    .describe(
      "Optional in diff-apply context — omitting means 'no change to course description'.",
    ),
  tone: z.string().optional(),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  language: z.string().optional(),
  modules: z.array(ModuleInput).min(1).describe("Ordered list of modules"),
});

// ---------------------------------------------------------------------------
// Tree types (duplicated from courseOutline.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// fetchExistingCourseTree — local copy, does not re-export
// ---------------------------------------------------------------------------

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
        Array.isArray(d)
          ? (d as Record<string, unknown>[])
          : ((d.modules ?? []) as Record<string, unknown>[]),
      )) ??
    [];

  const modules: ExistingModule[] = [];
  for (const m of modulesArr) {
    const moduleId = String(m.id);
    const lessonsResp = await client.request<unknown>(`/api/modules/${moduleId}/lessons`);
    const lessons = (
      Array.isArray(lessonsResp)
        ? lessonsResp
        : (lessonsResp as { lessons?: unknown[] })?.lessons ?? []
    ) as Record<string, unknown>[];

    const lessonRecords: ExistingLesson[] = [];
    for (const l of lessons) {
      const lessonId = String(l.id);
      const stepsResp = await client.request<unknown>(
        `/api/lessons/${lessonId}/flow-steps`,
      );
      const steps = (
        Array.isArray(stepsResp)
          ? stepsResp
          : (stepsResp as { flow_steps?: unknown[] })?.flow_steps ?? []
      ) as Record<string, unknown>[];
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

// ---------------------------------------------------------------------------
// defaultLinearChain — local copy, does not re-export
// ---------------------------------------------------------------------------

function defaultLinearChain(stepCount: number): z.infer<typeof ConnectionInput>[] {
  const conns: z.infer<typeof ConnectionInput>[] = [];
  for (let i = 0; i < stepCount - 1; i++) {
    conns.push({
      from_index: i,
      to_index: i + 1,
      button_text: "Next",
      button_action: "next",
      button_order: 1,
    });
  }
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

// ---------------------------------------------------------------------------
// Mutation tracking
// ---------------------------------------------------------------------------

type AppliedOp = {
  op: "create_module" | "rename_module" | "delete_module" | "create_lesson" | "rename_lesson" | "delete_lesson" | "create_step" | "delete_step" | "update_step";
  entity_id: string;
  kind: "module" | "lesson" | "flow_step";
};

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const ApplyDiffEnvelope = z.object({
  entity: z.object({
    course_id: z.string(),
    applied: z.object({
      modules: z.object({
        added: z.number().int(),
        removed: z.number().int(),
        renamed: z.number().int(),
        unchanged: z.number().int(),
      }),
      lessons: z.object({
        added: z.number().int(),
        removed: z.number().int(),
        renamed: z.number().int(),
        unchanged: z.number().int(),
      }),
      flow_steps: z.object({
        added: z.number().int(),
        removed: z.number().int(),
        content_changed: z.number().int(),
        unchanged: z.number().int(),
      }),
    }),
    warnings: z.array(z.string()),
    partial_failures: z
      .object({
        failed_at: z.record(z.unknown()),
        applied_so_far: z.number().int(),
      })
      .optional(),
  }),
  summary: z.string(),
  url: z.string().optional(),
  resource_uri: z.string().optional(),
  next_actions: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildCourseOutlineApplyDiffTools(client: FlowlearnClient): ToolDef[] {
  const cfg = () => client.getConfig();

  return [
    {
      name: "flowlearn_course_outline_apply_diff",
      description:
        "Stateless structural sync: compare a proposed outline tree against an existing course and apply every detected change in one call. Operates on the same diff logic as flowlearn_course_outline_diff — but mutates.\n\n" +
        "When to use: after reviewing the diff with flowlearn_course_outline_diff and deciding to commit; re-syncing a course from an edited export; incremental restructures (add/remove/rename modules, lessons, steps) without rebuilding the whole course.\n" +
        "When NOT to use: creating a brand-new course (use flowlearn_course_outline_apply instead — it's cheaper); purely content-only edits with no structural changes (use flowlearn_flow_step_update directly); when the existing course id is unknown (call flowlearn_course_list first).\n\n" +
        "Diff granularity: positional. Module 0 in proposed vs module 0 in existing, lesson 0 vs 0, step 0 vs 0. A title change at the same position = rename; extra entries at the end = added; missing trailing entries = removed.\n\n" +
        "Atomicity: BEST-EFFORT. Changes are applied sequentially. On failure, details.partial_failures shows how far the apply got. There is NO automatic rollback — flowlearn.io has no transaction semantics and deleted entities cannot be recovered. Preview with dry_run=true before committing destructive operations.\n\n" +
        "Connections: connection graph changes surface as per-lesson warnings but are NOT auto-rewired. Positional diff cannot safely reconstruct edge semantics — rewire manually with flowlearn_connection_replace_all or flowlearn_connection_graph_replace.\n\n" +
        'Example call: { "course_id": "crs_abc", "proposed": { "title": "Spanish Greetings", "topic": "Greetings", "modules": [{ "title": "Hellos", "lessons": [{ "title": "Saying Hello", "steps": [{"title":"Hola","content":"Most common greeting."}] }] }] } }\n\n' +
        "Errors: FLOWLEARN_API_404 if course_id invalid; INVALID_ARGUMENTS if proposed schema fails Zod validation; OUTLINE_DIFF_FETCH_FAILED if tree fetch fails (retriable). On partial apply failure: returns an error with details.partial_failures.",
      inputSchema: {
        course_id: z.string().min(1).describe("ID of the existing course to update"),
        proposed: ProposedCourseInput,
        ignore: z
          .object({
            titles: z
              .boolean()
              .optional()
              .describe("If true, suppress rename operations (module/lesson titles unchanged)."),
            content: z
              .boolean()
              .optional()
              .describe(
                "If true, do not apply step content_changed updates. Default false (content changes ARE applied).",
              ),
          })
          .optional()
          .describe("Control which diff classes to suppress"),
        ...DryRunField,
        ...IdempotencyField,
      },
      outputSchema: ApplyDiffEnvelope,
      annotations: {
        title: "Apply diff to existing course",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args) => {
        const {
          course_id,
          proposed,
          ignore,
          dry_run,
          client_request_id,
        } = args as {
          course_id: string;
          proposed: z.infer<typeof ProposedCourseInput>;
          ignore?: { titles?: boolean; content?: boolean };
          dry_run?: boolean;
          client_request_id?: string;
        };

        const ignoreTitles = ignore?.titles === true;
        const ignoreContent = ignore?.content === true;

        // Fetch the existing tree.
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

        // -----------------------------------------------------------------------
        // Compute diff (same logic as outline_diff)
        // -----------------------------------------------------------------------

        type ModuleRename = { idx: number; id: string; oldTitle: string; newTitle: string };
        type ModuleRemove = { idx: number; id: string; title: string };
        type ModuleAdd = { idx: number; proposedModule: z.infer<typeof ModuleInput> };

        type LessonRename = { moduleIdx: number; lessonIdx: number; id: string; oldTitle: string; newTitle: string };
        type LessonRemove = { moduleIdx: number; lessonIdx: number; id: string; title: string };
        type LessonAdd = { moduleIdx: number; lessonIdx: number; parentModuleId?: string; proposedLesson: z.infer<typeof LessonInput> };

        type StepContentChange = { moduleIdx: number; lessonIdx: number; stepIdx: number; id: string; proposedContent: string };
        type StepRemove = { moduleIdx: number; lessonIdx: number; stepIdx: number; id: string };
        type StepAdd = { moduleIdx: number; lessonIdx: number; stepIdx: number; parentLessonId?: string; proposedStep: z.infer<typeof StepInput> };

        const moduleRenames: ModuleRename[] = [];
        const moduleRemoves: ModuleRemove[] = [];
        const moduleAdds: ModuleAdd[] = [];

        const lessonRenames: LessonRename[] = [];
        const lessonRemoves: LessonRemove[] = [];
        const lessonAdds: LessonAdd[] = [];

        const stepContentChanges: StepContentChange[] = [];
        const stepRemoves: StepRemove[] = [];
        const stepAdds: StepAdd[] = [];

        const connectionWarnings: string[] = [];

        const maxModules = Math.max(proposed.modules.length, existing.modules.length);
        for (let mi = 0; mi < maxModules; mi++) {
          const pm = proposed.modules[mi];
          const em = existing.modules[mi];

          if (pm && !em) {
            moduleAdds.push({ idx: mi, proposedModule: pm });
            continue;
          }
          if (!pm && em) {
            moduleRemoves.push({ idx: mi, id: em.id, title: em.title });
            continue;
          }
          if (!pm || !em) continue;

          if (!ignoreTitles && pm.title !== em.title) {
            moduleRenames.push({ idx: mi, id: em.id, oldTitle: em.title, newTitle: pm.title });
          }

          const maxLessons = Math.max(pm.lessons.length, em.lessons.length);
          for (let li = 0; li < maxLessons; li++) {
            const pl = pm.lessons[li];
            const el = em.lessons[li];

            if (pl && !el) {
              lessonAdds.push({ moduleIdx: mi, lessonIdx: li, parentModuleId: em.id, proposedLesson: pl });
              continue;
            }
            if (!pl && el) {
              lessonRemoves.push({ moduleIdx: mi, lessonIdx: li, id: el.id, title: el.title });
              continue;
            }
            if (!pl || !el) continue;

            if (!ignoreTitles && pl.title !== el.title) {
              lessonRenames.push({ moduleIdx: mi, lessonIdx: li, id: el.id, oldTitle: el.title, newTitle: pl.title });
            }

            // Connection count comparison → warning only.
            const proposedConnCount = (pl.connections ?? defaultLinearChain(pl.steps.length)).length;
            if (proposedConnCount !== el.connectionCount) {
              connectionWarnings.push(
                `Lesson '${el.title}' (id=${el.id}): connection count differs (existing=${el.connectionCount}, proposed=${proposedConnCount}). Connections are NOT auto-rewired — use flowlearn_connection_graph_replace to update.`,
              );
            }

            const maxSteps = Math.max(pl.steps.length, el.steps.length);
            for (let si = 0; si < maxSteps; si++) {
              const ps = pl.steps[si];
              const es = el.steps[si];

              if (ps && !es) {
                stepAdds.push({ moduleIdx: mi, lessonIdx: li, stepIdx: si, parentLessonId: el.id, proposedStep: ps });
                continue;
              }
              if (!ps && es) {
                stepRemoves.push({ moduleIdx: mi, lessonIdx: li, stepIdx: si, id: es.id });
                continue;
              }
              if (!ps || !es) continue;

              if (!ignoreContent && ps.content !== es.content) {
                stepContentChanges.push({
                  moduleIdx: mi,
                  lessonIdx: li,
                  stepIdx: si,
                  id: es.id,
                  proposedContent: ps.content,
                });
              }
            }
          }
        }

        // -----------------------------------------------------------------------
        // Dry-run: return the plan without mutating
        // -----------------------------------------------------------------------

        if (dry_run) {
          const existingUnchangedModules =
            Math.min(proposed.modules.length, existing.modules.length) - moduleRenames.length;
          // Count unchanged lessons/steps is complex to compute perfectly in dry-run;
          // provide a useful approximation.
          return entityResult({
            entity: {
              course_id,
              applied: {
                modules: {
                  added: moduleAdds.length,
                  removed: moduleRemoves.length,
                  renamed: moduleRenames.length,
                  unchanged: Math.max(0, existingUnchangedModules),
                },
                lessons: {
                  added: lessonAdds.length,
                  removed: lessonRemoves.length,
                  renamed: lessonRenames.length,
                  unchanged: 0, // approximate — not counted in dry-run
                },
                flow_steps: {
                  added: stepAdds.length,
                  removed: stepRemoves.length,
                  content_changed: stepContentChanges.length,
                  unchanged: 0, // approximate
                },
              },
              warnings: connectionWarnings,
            },
            summary: `[dry-run] Would apply: +${moduleAdds.length}/-${moduleRemoves.length} modules, +${lessonAdds.length}/-${lessonRemoves.length} lessons, +${stepAdds.length}/-${stepRemoves.length} steps, ~${stepContentChanges.length} step content changes, ${moduleRenames.length + lessonRenames.length} renames. ${connectionWarnings.length} connection warning(s).`,
            url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", course_id),
            resource_uri: `flowlearn://course/${course_id}`,
            next_actions: [`Re-call without dry_run to commit.`],
          });
        }

        // -----------------------------------------------------------------------
        // Idempotency check
        // -----------------------------------------------------------------------

        const cached = getIdempotent(client_request_id);
        if (cached) return cached;

        // -----------------------------------------------------------------------
        // Apply mutations
        // -----------------------------------------------------------------------

        const appliedOps: AppliedOp[] = [];

        // Counters for the result envelope.
        let modulesAdded = 0;
        let modulesRemoved = 0;
        let modulesRenamed = 0;
        let modulesUnchanged = 0;
        let lessonsAdded = 0;
        let lessonsRemoved = 0;
        let lessonsRenamed = 0;
        let lessonsUnchanged = 0;
        let stepsAdded = 0;
        let stepsRemoved = 0;
        let stepsContentChanged = 0;
        let stepsUnchanged = 0;

        // We need a mutable copy of module/lesson id maps so that lesson ops on
        // newly-created modules can use the right parent id.
        // Map from module_index → id (either existing or freshly-created).
        const moduleIdByIdx: Map<number, string> = new Map(
          existing.modules.map((em, mi) => [mi, em.id]),
        );
        // Map from "mi:li" → lesson_id.
        const lessonIdByIdx: Map<string, string> = new Map();
        for (let mi = 0; mi < existing.modules.length; mi++) {
          for (let li = 0; li < existing.modules[mi].lessons.length; li++) {
            lessonIdByIdx.set(`${mi}:${li}`, existing.modules[mi].lessons[li].id);
          }
        }

        const applyFailed = async (
          op: string,
          err: unknown,
        ): Promise<{
          code: string;
          message: string;
          suggestion: string;
          retriable: boolean;
          details: Record<string, unknown>;
        }> => {
          const message = err instanceof Error ? err.message : String(err);
          return {
            code: "OUTLINE_APPLY_DIFF_FAILED",
            message: `outline_apply_diff failed at ${op}: ${message}`,
            suggestion:
              "No rollback was attempted — check details.partial_failures.applied_so_far and details.partial_failures.failed_at to see how far the apply got. Resume manually from there.",
            retriable: false,
            details: {
              partial_failures: {
                failed_at: { op, message },
                applied_so_far: appliedOps.length,
              },
            },
          };
        };

        // --- Module operations ---

        // Removes first (to avoid conflicts), then renames, then adds.
        for (const r of moduleRemoves) {
          try {
            await client.request(`/api/modules/${r.id}`, { method: "DELETE" });
            appliedOps.push({ op: "delete_module", entity_id: r.id, kind: "module" });
            modulesRemoved++;
            moduleIdByIdx.delete(r.idx);
          } catch (err) {
            return errorResult(await applyFailed(`delete_module id=${r.id}`, err));
          }
        }

        for (const r of moduleRenames) {
          try {
            await client.request(`/api/modules/${r.id}`, {
              method: "PUT",
              body: { title: r.newTitle },
            });
            appliedOps.push({ op: "rename_module", entity_id: r.id, kind: "module" });
            modulesRenamed++;
          } catch (err) {
            return errorResult(await applyFailed(`rename_module id=${r.id}`, err));
          }
        }

        for (const a of moduleAdds) {
          try {
            const resp = await client.request<{ module?: Record<string, unknown> }>(
              `/api/courses/${course_id}/modules`,
              {
                method: "POST",
                body: {
                  title: a.proposedModule.title,
                  description: a.proposedModule.description,
                  content: a.proposedModule.objectives
                    ? { objectives: a.proposedModule.objectives }
                    : undefined,
                },
              },
            );
            const entity = (resp.module ?? resp) as Record<string, unknown>;
            const newModuleId = String(entity.id);
            appliedOps.push({ op: "create_module", entity_id: newModuleId, kind: "module" });
            modulesAdded++;
            moduleIdByIdx.set(a.idx, newModuleId);

            // Create all lessons + steps under this new module.
            for (let li = 0; li < a.proposedModule.lessons.length; li++) {
              const pl = a.proposedModule.lessons[li];
              try {
                const lResp = await client.request<{ lesson?: Record<string, unknown> }>(
                  `/api/modules/${newModuleId}/lessons`,
                  { method: "POST", body: { title: pl.title, description: pl.description } },
                );
                const lEntity = (lResp.lesson ?? lResp) as Record<string, unknown>;
                const newLessonId = String(lEntity.id);
                appliedOps.push({ op: "create_lesson", entity_id: newLessonId, kind: "lesson" });
                lessonsAdded++;
                lessonIdByIdx.set(`${a.idx}:${li}`, newLessonId);

                // Create steps.
                const stepIds: string[] = [];
                for (const ps of pl.steps) {
                  const sResp = await client.request<{ flow_step?: Record<string, unknown> }>(
                    `/api/lessons/${newLessonId}/flow-steps`,
                    { method: "POST", body: { title: ps.title, content: ps.content, step_type: ps.step_type ?? "message" } },
                  );
                  const sEntity = (sResp.flow_step ?? sResp) as Record<string, unknown>;
                  const newStepId = String(sEntity.id);
                  appliedOps.push({ op: "create_step", entity_id: newStepId, kind: "flow_step" });
                  stepsAdded++;
                  stepIds.push(newStepId);
                }
              } catch (err) {
                return errorResult(await applyFailed(`create_lesson in new module idx=${a.idx}`, err));
              }
            }
          } catch (err) {
            return errorResult(await applyFailed(`create_module idx=${a.idx}`, err));
          }
        }

        // Count unchanged modules (those that were neither added/removed/renamed).
        const processedModuleIndices = new Set([
          ...moduleAdds.map((a) => a.idx),
          ...moduleRemoves.map((r) => r.idx),
          ...moduleRenames.map((r) => r.idx),
        ]);
        for (let mi = 0; mi < Math.min(proposed.modules.length, existing.modules.length); mi++) {
          if (!processedModuleIndices.has(mi)) modulesUnchanged++;
        }

        // --- Lesson operations ---

        for (const r of lessonRemoves) {
          try {
            await client.request(`/api/lessons/${r.id}`, { method: "DELETE" });
            appliedOps.push({ op: "delete_lesson", entity_id: r.id, kind: "lesson" });
            lessonsRemoved++;
            lessonIdByIdx.delete(`${r.moduleIdx}:${r.lessonIdx}`);
          } catch (err) {
            return errorResult(await applyFailed(`delete_lesson id=${r.id}`, err));
          }
        }

        for (const r of lessonRenames) {
          try {
            await client.request(`/api/lessons/${r.id}`, {
              method: "PUT",
              body: { title: r.newTitle },
            });
            appliedOps.push({ op: "rename_lesson", entity_id: r.id, kind: "lesson" });
            lessonsRenamed++;
          } catch (err) {
            return errorResult(await applyFailed(`rename_lesson id=${r.id}`, err));
          }
        }

        for (const a of lessonAdds) {
          const parentModuleId = a.parentModuleId ?? moduleIdByIdx.get(a.moduleIdx);
          if (!parentModuleId) {
            return errorResult({
              code: "OUTLINE_APPLY_DIFF_FAILED",
              message: `Cannot create lesson at module index ${a.moduleIdx}: parent module id not found.`,
              suggestion: "The module at this index may have been deleted before the lesson add. Inspect partial_failures.",
              retriable: false,
              details: { partial_failures: { failed_at: { op: `create_lesson moduleIdx=${a.moduleIdx}` }, applied_so_far: appliedOps.length } },
            });
          }
          try {
            const lResp = await client.request<{ lesson?: Record<string, unknown> }>(
              `/api/modules/${parentModuleId}/lessons`,
              { method: "POST", body: { title: a.proposedLesson.title, description: a.proposedLesson.description } },
            );
            const lEntity = (lResp.lesson ?? lResp) as Record<string, unknown>;
            const newLessonId = String(lEntity.id);
            appliedOps.push({ op: "create_lesson", entity_id: newLessonId, kind: "lesson" });
            lessonsAdded++;
            lessonIdByIdx.set(`${a.moduleIdx}:${a.lessonIdx}`, newLessonId);

            // Create steps for this new lesson.
            for (const ps of a.proposedLesson.steps) {
              try {
                const sResp = await client.request<{ flow_step?: Record<string, unknown> }>(
                  `/api/lessons/${newLessonId}/flow-steps`,
                  { method: "POST", body: { title: ps.title, content: ps.content, step_type: ps.step_type ?? "message" } },
                );
                const sEntity = (sResp.flow_step ?? sResp) as Record<string, unknown>;
                appliedOps.push({ op: "create_step", entity_id: String(sEntity.id), kind: "flow_step" });
                stepsAdded++;
              } catch (err) {
                return errorResult(await applyFailed(`create_step in new lesson id=${newLessonId}`, err));
              }
            }
          } catch (err) {
            return errorResult(await applyFailed(`create_lesson moduleIdx=${a.moduleIdx}`, err));
          }
        }

        // Count unchanged lessons.
        const processedLessonKeys = new Set([
          ...lessonAdds.map((a) => `${a.moduleIdx}:${a.lessonIdx}`),
          ...lessonRemoves.map((r) => `${r.moduleIdx}:${r.lessonIdx}`),
          ...lessonRenames.map((r) => `${r.moduleIdx}:${r.lessonIdx}`),
        ]);
        for (let mi = 0; mi < Math.min(proposed.modules.length, existing.modules.length); mi++) {
          const pm = proposed.modules[mi];
          const em = existing.modules[mi];
          if (!pm || !em) continue;
          for (let li = 0; li < Math.min(pm.lessons.length, em.lessons.length); li++) {
            if (!processedLessonKeys.has(`${mi}:${li}`)) lessonsUnchanged++;
          }
        }

        // --- Step operations ---

        for (const r of stepRemoves) {
          try {
            await client.request(`/api/flow-steps/${r.id}`, { method: "DELETE" });
            appliedOps.push({ op: "delete_step", entity_id: r.id, kind: "flow_step" });
            stepsRemoved++;
          } catch (err) {
            return errorResult(await applyFailed(`delete_step id=${r.id}`, err));
          }
        }

        for (const c of stepContentChanges) {
          try {
            await client.request(`/api/flow-steps/${c.id}`, {
              method: "PUT",
              body: { content: c.proposedContent },
            });
            appliedOps.push({ op: "update_step", entity_id: c.id, kind: "flow_step" });
            stepsContentChanged++;
          } catch (err) {
            return errorResult(await applyFailed(`update_step id=${c.id}`, err));
          }
        }

        for (const a of stepAdds) {
          const parentLessonId = a.parentLessonId ?? lessonIdByIdx.get(`${a.moduleIdx}:${a.lessonIdx}`);
          if (!parentLessonId) {
            return errorResult({
              code: "OUTLINE_APPLY_DIFF_FAILED",
              message: `Cannot create step at module ${a.moduleIdx}, lesson ${a.lessonIdx}: parent lesson id not found.`,
              suggestion: "The lesson at this position may have been deleted or was not created. Inspect partial_failures.",
              retriable: false,
              details: { partial_failures: { failed_at: { op: `create_step mi=${a.moduleIdx} li=${a.lessonIdx}` }, applied_so_far: appliedOps.length } },
            });
          }
          try {
            const sResp = await client.request<{ flow_step?: Record<string, unknown> }>(
              `/api/lessons/${parentLessonId}/flow-steps`,
              { method: "POST", body: { title: a.proposedStep.title, content: a.proposedStep.content, step_type: a.proposedStep.step_type ?? "message" } },
            );
            const sEntity = (sResp.flow_step ?? sResp) as Record<string, unknown>;
            appliedOps.push({ op: "create_step", entity_id: String(sEntity.id), kind: "flow_step" });
            stepsAdded++;
          } catch (err) {
            return errorResult(await applyFailed(`create_step mi=${a.moduleIdx} li=${a.lessonIdx}`, err));
          }
        }

        // Count unchanged steps.
        const processedStepKeys = new Set([
          ...stepAdds.map((a) => `${a.moduleIdx}:${a.lessonIdx}:${a.stepIdx}`),
          ...stepRemoves.map((r) => `${r.moduleIdx}:${r.lessonIdx}:${r.stepIdx}`),
          ...stepContentChanges.map((c) => `${c.moduleIdx}:${c.lessonIdx}:${c.stepIdx}`),
        ]);
        for (let mi = 0; mi < Math.min(proposed.modules.length, existing.modules.length); mi++) {
          const pm = proposed.modules[mi];
          const em = existing.modules[mi];
          if (!pm || !em) continue;
          for (let li = 0; li < Math.min(pm.lessons.length, em.lessons.length); li++) {
            const pl = pm.lessons[li];
            const el = em.lessons[li];
            if (!pl || !el) continue;
            for (let si = 0; si < Math.min(pl.steps.length, el.steps.length); si++) {
              if (!processedStepKeys.has(`${mi}:${li}:${si}`)) stepsUnchanged++;
            }
          }
        }

        const summary = [
          `Applied diff to course '${existing.title}' (id=${course_id}):`,
          modulesAdded > 0 ? `+${modulesAdded} modules` : null,
          modulesRemoved > 0 ? `-${modulesRemoved} modules` : null,
          modulesRenamed > 0 ? `~${modulesRenamed} module renames` : null,
          lessonsAdded > 0 ? `+${lessonsAdded} lessons` : null,
          lessonsRemoved > 0 ? `-${lessonsRemoved} lessons` : null,
          lessonsRenamed > 0 ? `~${lessonsRenamed} lesson renames` : null,
          stepsAdded > 0 ? `+${stepsAdded} steps` : null,
          stepsRemoved > 0 ? `-${stepsRemoved} steps` : null,
          stepsContentChanged > 0 ? `~${stepsContentChanged} step content updates` : null,
          connectionWarnings.length > 0 ? `${connectionWarnings.length} connection warning(s)` : null,
        ]
          .filter(Boolean)
          .join(", ");

        const nothingChanged =
          modulesAdded + modulesRemoved + modulesRenamed +
          lessonsAdded + lessonsRemoved + lessonsRenamed +
          stepsAdded + stepsRemoved + stepsContentChanged === 0;

        const finalSummary = nothingChanged
          ? `Course '${existing.title}' (id=${course_id}): proposed tree matches existing structure — no changes applied.`
          : summary || `Course '${existing.title}' updated.`;

        const result = entityResult({
          entity: {
            course_id,
            applied: {
              modules: {
                added: modulesAdded,
                removed: modulesRemoved,
                renamed: modulesRenamed,
                unchanged: modulesUnchanged,
              },
              lessons: {
                added: lessonsAdded,
                removed: lessonsRemoved,
                renamed: lessonsRenamed,
                unchanged: lessonsUnchanged,
              },
              flow_steps: {
                added: stepsAdded,
                removed: stepsRemoved,
                content_changed: stepsContentChanged,
                unchanged: stepsUnchanged,
              },
            },
            warnings: connectionWarnings,
          },
          summary: finalSummary,
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", course_id),
          resource_uri: `flowlearn://course/${course_id}`,
          next_actions: [
            connectionWarnings.length > 0
              ? "Use flowlearn_connection_graph_replace on affected lessons to update the connection graph."
              : "Use flowlearn_course_lint to verify the updated course is publish-ready.",
          ],
        });

        setIdempotent(client_request_id, result);
        return result;
      },
    },
  ];
}
