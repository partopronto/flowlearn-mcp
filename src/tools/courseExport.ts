import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import { entityResult, type ToolDef } from "./common.js";

/**
 * Round-trip an existing course back to outline shape. The output is
 * structurally compatible with flowlearn_course_outline_apply's input —
 * agents can export, edit (offline or via the chat), and re-apply to create
 * a copy / template / fork.
 *
 * Connections are translated from {flow_step_id, to_step_id} (id-based) back
 * to {from_index, to_index} (position-based) so the same outline can be
 * applied to a different course without id collisions.
 */

const StepTypeEnum = z.enum(["message", "quiz", "exercise"]);
const ButtonActionEnum = z.enum(["next", "help", "skip", "custom", "branch"]);

const ExportedConnection = z.object({
  from_index: z.number().int(),
  to_index: z.number().int().nullable(),
  button_text: z.string(),
  button_action: ButtonActionEnum.optional(),
  button_order: z.number().int().optional(),
});

const ExportedStep = z.object({
  title: z.string(),
  content: z.string(),
  description: z.string().optional(),
  step_type: StepTypeEnum.optional(),
  is_starting_step: z.boolean().optional(),
  image_url: z.string().nullish(),
});

const ExportedLesson = z.object({
  title: z.string(),
  description: z.string().optional(),
  flow_completed: z.boolean().optional(),
  steps: z.array(ExportedStep),
  connections: z.array(ExportedConnection),
});

const ExportedModule = z.object({
  title: z.string(),
  description: z.string().optional(),
  objectives: z.array(z.string()).optional(),
  lessons: z.array(ExportedLesson),
});

const ExportedCourse = z.object({
  title: z.string(),
  topic: z.string().nullish(),
  description: z.string().nullish(),
  tone: z.string().nullish(),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).nullish(),
  language: z.string().nullish(),
  status: z.enum(["draft", "published", "archived"]).nullish(),
  modules: z.array(ExportedModule),
});

const OutlineExportEnvelope = z.object({
  entity: z.object({
    outline: z.object({ course: ExportedCourse }),
    source_course_id: z.string(),
    exported_at: z.string(),
    stats: z.object({
      modules: z.number().int(),
      lessons: z.number().int(),
      flow_steps: z.number().int(),
      connections: z.number().int(),
    }),
  }),
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
});

export function buildCourseExportTools(client: FlowlearnClient): ToolDef[] {
  return [
    {
      name: "flowlearn_course_export_outline",
      description:
        "Read-only export of an existing course as an outline-shaped JSON tree. The output is structurally compatible with flowlearn_course_outline_apply's input — feed it back to recreate the course, fork into a new tenant, or save as a template.\n\n" +
        "When to use: backing up a course before risky edits; cloning a course as a template; round-tripping content offline (export → edit JSON → import). Combined with flowlearn_course_outline_apply, this gives you copy-on-write workflows.\n" +
        "When NOT to use: as a substitute for flowlearn_course_get when you only need metadata (this fetches the entire tree — N+M+K+L API calls).\n\n" +
        "Connections are translated from id-based ({flow_step_id, to_step_id}) to position-based ({from_index, to_index}) so the export can be applied to a different course without id collisions. Image URLs are preserved as `image_url` on each step (NOT re-uploaded — the agent decides whether to re-fetch when re-applying).\n\n" +
        'Example call: { "course_id": "crs_abc" }\n\n' +
        "Errors: FLOWLEARN_API_404 if course_id invalid.",
      inputSchema: {
        course_id: z.string().min(1),
      },
      outputSchema: OutlineExportEnvelope,
      annotations: {
        title: "Export course as outline",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id }) => {
        // Walk the tree.
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

        const exportedModules: z.infer<typeof ExportedModule>[] = [];
        let totalLessons = 0;
        let totalSteps = 0;
        let totalConnections = 0;

        for (const m of modulesArr) {
          const moduleId = String(m.id);
          const lessonsResp = await client.request<unknown>(
            `/api/modules/${moduleId}/lessons`,
          );
          const lessons = (Array.isArray(lessonsResp)
            ? lessonsResp
            : (lessonsResp as { lessons?: unknown[] })?.lessons ?? []) as Record<string, unknown>[];

          const exportedLessons: z.infer<typeof ExportedLesson>[] = [];
          for (const l of lessons) {
            const lessonId = String(l.id);
            const stepsResp = await client.request<unknown>(
              `/api/lessons/${lessonId}/flow-steps`,
            );
            const steps = (Array.isArray(stepsResp)
              ? stepsResp
              : (stepsResp as { flow_steps?: unknown[] })?.flow_steps ?? []) as Record<string, unknown>[];

            // Sort by order_index to ensure index positions match author intent.
            steps.sort((a, b) => (Number(a.order_index ?? 0) - Number(b.order_index ?? 0)));

            const stepIdToIndex = new Map<string, number>();
            const exportedSteps: z.infer<typeof ExportedStep>[] = [];
            steps.forEach((s, i) => {
              stepIdToIndex.set(String(s.id), i);
              exportedSteps.push({
                title: String(s.title ?? ""),
                content: String(s.content ?? ""),
                description: (s.description as string | undefined) ?? undefined,
                step_type: (s.step_type as "message" | "quiz" | "exercise" | undefined) ?? undefined,
                is_starting_step: s.is_starting_step === true ? true : undefined,
                image_url: (s.image_url as string | null | undefined) ?? null,
              });
            });

            const exportedConnections: z.infer<typeof ExportedConnection>[] = [];
            for (const s of steps) {
              const fromIdx = stepIdToIndex.get(String(s.id));
              if (fromIdx === undefined) continue;
              const conns = (s.connections as Record<string, unknown>[] | undefined) ?? [];
              for (const c of conns) {
                const target = c.to_step_id;
                const toIdx =
                  target === null || target === undefined
                    ? null
                    : (stepIdToIndex.get(String(target)) ?? null);
                exportedConnections.push({
                  from_index: fromIdx,
                  to_index: toIdx,
                  button_text: String(c.button_text ?? "Next"),
                  button_action: (c.button_action as "next" | "help" | "skip" | "custom" | "branch" | undefined) ?? undefined,
                  button_order: (c.button_order as number | undefined) ?? undefined,
                });
              }
            }

            exportedLessons.push({
              title: String(l.title ?? ""),
              description: (l.description as string | undefined) ?? undefined,
              flow_completed: l.flow_completed === true ? true : undefined,
              steps: exportedSteps,
              connections: exportedConnections,
            });

            totalLessons += 1;
            totalSteps += exportedSteps.length;
            totalConnections += exportedConnections.length;
          }

          exportedModules.push({
            title: String(m.title ?? ""),
            description: (m.description as string | undefined) ?? undefined,
            objectives:
              (m.content as { objectives?: string[] } | null | undefined)?.objectives ??
              undefined,
            lessons: exportedLessons,
          });
        }

        const outline = {
          course: {
            title: String(course.title ?? ""),
            topic: (course.topic as string | undefined) ?? null,
            description: (course.description as string | undefined) ?? null,
            tone: (course.tone as string | undefined) ?? null,
            difficulty: (course.difficulty as "beginner" | "intermediate" | "advanced" | undefined) ?? null,
            language: (course.language as string | undefined) ?? null,
            status: (course.status as "draft" | "published" | "archived" | undefined) ?? null,
            modules: exportedModules,
          },
        };

        return entityResult({
          entity: {
            outline,
            source_course_id: String(course_id),
            exported_at: new Date().toISOString(),
            stats: {
              modules: exportedModules.length,
              lessons: totalLessons,
              flow_steps: totalSteps,
              connections: totalConnections,
            },
          },
          summary: `Exported course '${course.title}' (id=${course_id}): ${exportedModules.length} modules, ${totalLessons} lessons, ${totalSteps} flow steps, ${totalConnections} connections.`,
          next_actions: [
            `Edit the outline JSON in your editor / clipboard, then call flowlearn_course_outline_apply with { course: <edited-outline.course> } to recreate as a copy.`,
            `Stash this output as a template for future courses.`,
          ],
        });
      },
    },
  ];
}
