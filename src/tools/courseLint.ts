import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import { entityResult, type ToolDef } from "./common.js";

/**
 * Read-only quality / publish-readiness audit for a course. The agent calls
 * this in a loop ("lint → fix → re-lint") until publish_ready=true, then
 * sets status=published with confidence.
 */

type Severity = "error" | "warning";

type Issue = {
  severity: Severity;
  code: string;
  message: string;
  fix_hint: string;
  location: Record<string, string>;
};

const IssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
  fix_hint: z.string(),
  location: z.record(z.string()),
});

const LintEnvelope = z.object({
  entity: z.object({
    course_id: z.string(),
    publish_ready: z.boolean(),
    counts: z.object({ errors: z.number().int(), warnings: z.number().int() }),
    issues: z.array(IssueSchema),
  }),
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
});

export function buildCourseLintTools(client: FlowlearnClient): ToolDef[] {
  return [
    {
      name: "flowlearn_course_lint",
      description:
        "READ-ONLY publish-readiness + structural audit of a course. Walks the entire tree (modules → lessons → flow steps → connections) and reports issues categorised as `error` (publish-blocking) or `warning` (recommended fix). Returns publish_ready=true iff there are zero errors AND every lesson has flow_completed=true.\n\n" +
        "When to use: after building a course (especially after flowlearn_course_outline_apply); before calling flowlearn_course_update with status='published'; in a fix-loop where the agent repeatedly lints, fixes the top error, then re-lints.\n" +
        "When NOT to use: as a substitute for actual content review — lint catches structure, not pedagogy.\n\n" +
        "Severity scale:\n" +
        "  error    Publish will fail or course is broken. Examples: missing starting step, dangling connection, empty course.\n" +
        "  warning  Course works but quality issue. Examples: unreachable step, empty step content, lesson not flow_completed.\n\n" +
        'Example call: { "course_id": "crs_abc" }\n\n' +
        "Filter by severity client-side; the response always includes both. publish_ready is a single boolean for quick gating.\n\n" +
        "Errors: FLOWLEARN_API_404 if course_id invalid.",
      inputSchema: {
        course_id: z.string().min(1),
      },
      outputSchema: LintEnvelope,
      annotations: {
        title: "Lint course",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id }) => {
        const issues: Issue[] = [];

        // Fetch course tree.
        const courseResp = await client.request<{ course?: Record<string, unknown> }>(
          `/api/courses/${course_id}`,
        );
        const course = (courseResp.course ?? courseResp) as Record<string, unknown>;

        const modulesArr: Record<string, unknown>[] =
          (course.modules as Record<string, unknown>[] | undefined) ??
          (await client
            .request<{ modules?: unknown[] }>(`/api/courses/${course_id}/modules`)
            .then((d) => (Array.isArray(d) ? d : (d.modules ?? [])) as Record<string, unknown>[])) ??
          [];

        if (modulesArr.length === 0) {
          issues.push({
            severity: "error",
            code: "EMPTY_COURSE",
            message: "Course has no modules.",
            fix_hint: "Call flowlearn_module_create.",
            location: { course_id: String(course_id) },
          });
        }

        for (const m of modulesArr) {
          const moduleId = String(m.id);
          const moduleTitle = String(m.title ?? "(untitled module)");

          const lessonsResp = await client.request<unknown>(
            `/api/modules/${moduleId}/lessons`,
          );
          const lessons = (Array.isArray(lessonsResp)
            ? lessonsResp
            : (lessonsResp as { lessons?: unknown[] })?.lessons ?? []) as Record<string, unknown>[];

          if (lessons.length === 0) {
            issues.push({
              severity: "warning",
              code: "EMPTY_MODULE",
              message: `Module '${moduleTitle}' has no lessons.`,
              fix_hint: "Call flowlearn_lesson_create.",
              location: { module_id: moduleId },
            });
            continue;
          }

          for (const l of lessons) {
            const lessonId = String(l.id);
            const lessonTitle = String(l.title ?? "(untitled lesson)");
            const flowCompleted = l.flow_completed === true;

            const stepsResp = await client.request<unknown>(
              `/api/lessons/${lessonId}/flow-steps`,
            );
            const steps = (Array.isArray(stepsResp)
              ? stepsResp
              : (stepsResp as { flow_steps?: unknown[] })?.flow_steps ?? []) as Record<string, unknown>[];

            if (steps.length === 0) {
              issues.push({
                severity: "warning",
                code: "EMPTY_LESSON",
                message: `Lesson '${lessonTitle}' has no flow steps.`,
                fix_hint: "Call flowlearn_flow_step_create.",
                location: { lesson_id: lessonId, module_id: moduleId },
              });
              if (!flowCompleted) {
                issues.push({
                  severity: "warning",
                  code: "LESSON_NOT_FLOW_COMPLETED",
                  message: `Lesson '${lessonTitle}' has flow_completed=false; will block publish.`,
                  fix_hint: "Call flowlearn_lesson_update with flow_completed=true once the flow is finalized.",
                  location: { lesson_id: lessonId, module_id: moduleId },
                });
              }
              continue;
            }

            const starters = steps.filter((s) => s.is_starting_step === true);
            if (starters.length === 0) {
              issues.push({
                severity: "error",
                code: "NO_STARTING_STEP",
                message: `Lesson '${lessonTitle}' has no flow step marked is_starting_step=true.`,
                fix_hint:
                  "Call flowlearn_flow_step_update on one step with is_starting_step=true, or use flowlearn_flow_step_reorder so the first step in order becomes the starter.",
                location: { lesson_id: lessonId },
              });
            } else if (starters.length > 1) {
              issues.push({
                severity: "error",
                code: "MULTIPLE_STARTING_STEPS",
                message: `Lesson '${lessonTitle}' has ${starters.length} flow steps marked is_starting_step=true; only one is allowed.`,
                fix_hint: "Set is_starting_step=false on all but one starter via flowlearn_flow_step_update.",
                location: { lesson_id: lessonId },
              });
            }

            // Empty content + dangling connections + reachability.
            const stepIds = new Set(steps.map((s) => String(s.id)));
            const stepsById = new Map(steps.map((s) => [String(s.id), s] as const));
            for (const s of steps) {
              const stepId = String(s.id);
              const stepTitle = String(s.title ?? "(untitled step)");
              const content = (s.content as string | null | undefined) ?? "";
              if (typeof content !== "string" || content.trim() === "") {
                issues.push({
                  severity: "warning",
                  code: "EMPTY_STEP_CONTENT",
                  message: `Step '${stepTitle}' has empty content.`,
                  fix_hint: "Call flowlearn_flow_step_update with content set.",
                  location: { flow_step_id: stepId, lesson_id: lessonId },
                });
              }

              const conns = (s.connections as Record<string, unknown>[] | undefined) ?? [];
              for (const c of conns) {
                const target = c.to_step_id;
                if (target !== null && target !== undefined && !stepIds.has(String(target))) {
                  issues.push({
                    severity: "error",
                    code: "DANGLING_CONNECTION",
                    message: `Connection on step '${stepTitle}' points to flow_step_id=${target} which is not in this lesson.`,
                    fix_hint:
                      "Update the connection target via flowlearn_connection_replace_all, or delete it via flowlearn_connection_clear and re-add.",
                    location: { flow_step_id: stepId, lesson_id: lessonId },
                  });
                }
              }
            }

            // Completion check: at least one step must have a terminal
            // outgoing connection (to_step_id=null) — without it, progress
            // never reaches 100% even if every step is reached. Steps with
            // zero outgoing connections of any kind are also problematic
            // because clicking through them never registers a "next" event.
            const stepsWithAnyOutgoing = new Set<string>();
            const stepsWithTerminal = new Set<string>();
            for (const s of steps) {
              const conns = (s.connections as Record<string, unknown>[] | undefined) ?? [];
              if (conns.length > 0) stepsWithAnyOutgoing.add(String(s.id));
              if (conns.some((c) => c.to_step_id === null)) {
                stepsWithTerminal.add(String(s.id));
              }
            }
            if (stepsWithTerminal.size === 0) {
              issues.push({
                severity: "warning",
                code: "NO_TERMINAL_BUTTON",
                message: `Lesson '${lessonTitle}' has no terminal connection (to_step_id=null). Progress cannot reach 100% — learners get stuck on the last step with no completion button.`,
                fix_hint:
                  "Call flowlearn_connection_add on the LAST step in this lesson with { to_step_id: null, button_text: \"Complete lesson\", button_order: 1 }.",
                location: { lesson_id: lessonId },
              });
            }
            // Steps with zero outgoing connections that are also NOT the
            // terminal-button-bearing step (i.e., real dead ends).
            for (const s of steps) {
              const sid = String(s.id);
              if (!stepsWithAnyOutgoing.has(sid)) {
                issues.push({
                  severity: "warning",
                  code: "STEP_HAS_NO_OUTGOING",
                  message: `Step '${String(s.title ?? "(untitled)")}' has no outgoing connection — clicking through it registers nothing.`,
                  fix_hint:
                    "Add a connection via flowlearn_connection_add. For the lesson's last step, use to_step_id=null + button_text=\"Complete lesson\".",
                  location: { flow_step_id: sid, lesson_id: lessonId },
                });
              }
            }

            // Reachability BFS from starting step.
            if (starters.length === 1) {
              const start = starters[0];
              const startId = String(start.id);
              const reachable = new Set<string>([startId]);
              const queue: string[] = [startId];
              while (queue.length > 0) {
                const cur = queue.shift()!;
                const curStep = stepsById.get(cur);
                const conns = (curStep?.connections as Record<string, unknown>[] | undefined) ?? [];
                for (const c of conns) {
                  const target = c.to_step_id;
                  if (target && stepIds.has(String(target)) && !reachable.has(String(target))) {
                    reachable.add(String(target));
                    queue.push(String(target));
                  }
                }
              }
              for (const s of steps) {
                const sid = String(s.id);
                if (!reachable.has(sid)) {
                  issues.push({
                    severity: "warning",
                    code: "UNREACHABLE_STEP",
                    message: `Step '${String(s.title ?? "(untitled)")}' is unreachable from the starting step.`,
                    fix_hint:
                      "Add a connection from a reachable step (flowlearn_connection_add), or delete the orphan step (flowlearn_flow_step_delete).",
                    location: { flow_step_id: sid, lesson_id: lessonId },
                  });
                }
              }
            }

            if (!flowCompleted) {
              issues.push({
                severity: "warning",
                code: "LESSON_NOT_FLOW_COMPLETED",
                message: `Lesson '${lessonTitle}' has flow_completed=false; will block publish.`,
                fix_hint: "Call flowlearn_lesson_update with flow_completed=true once the flow is finalized.",
                location: { lesson_id: lessonId, module_id: moduleId },
              });
            }
          }
        }

        const errors = issues.filter((i) => i.severity === "error").length;
        const warnings = issues.filter((i) => i.severity === "warning").length;
        const publishReady =
          errors === 0 &&
          modulesArr.length > 0 &&
          !issues.some((i) => i.code === "LESSON_NOT_FLOW_COMPLETED");

        return entityResult({
          entity: {
            course_id: String(course_id),
            publish_ready: publishReady,
            counts: { errors, warnings },
            issues,
          },
          summary: publishReady
            ? `Course is publish-ready (0 errors, ${warnings} warnings).`
            : `Course is NOT publish-ready: ${errors} error(s), ${warnings} warning(s). See issues[] for fix hints.`,
          next_actions: publishReady
            ? [
                `flowlearn_course_update with course_id="${course_id}" + status="published" to publish`,
              ]
            : errors > 0
              ? [
                  `Fix the ${errors} error(s) in the issues array, then re-call flowlearn_course_lint`,
                ]
              : [
                  `Fix or accept the ${warnings} warning(s); LESSON_NOT_FLOW_COMPLETED issues block publish`,
                ],
        });
      },
    },
  ];
}
