import { z } from "zod";
import { entityResult, type ToolDef } from "./common.js";

const TOPICS = {
  overview: `# Flowlearn MCP — overview

Hierarchy (top-down):
  tenant → course → module → lesson → flow_step
                                    └── connection (button edge)

A *course* is the unit you publish. It contains ordered *modules*. Each module contains ordered *lessons*. Each lesson has a *flow* — a graph of *flow_steps* connected by *connections* (button edges).

Tool naming: every tool is \`flowlearn_<resource>_<verb>\`. Resources: course, module, lesson, flow_step, connection, setup. Verbs: list, get, create, update, delete, reorder, switch_tenant, status, etc.

Common envelopes:
- Mutating tools return  { entity, summary, url?, next_actions? }
- List tools return      { items, total, next_cursor, has_more, summary }
- Errors return          { isError: true, code, message, suggestion?, retriable, details? }

Cross-cutting features:
- Pagination: every *_list takes { limit, cursor, response_format } where format=concise → {id, title} only.
- Idempotency: every *_create takes optional client_request_id; same key → cached result.
- Dry-run: every destructive tool takes optional dry_run=true to preview without mutating.

Authoring quickstart:
  1. flowlearn_setup_status                                    → orient
  2. flowlearn_course_create   { title, topic }                → c1
  3. flowlearn_module_create   { course_id: c1, title }        → m1
  4. flowlearn_lesson_create   { module_id: m1, title }        → l1
  5. flowlearn_flow_step_create { lesson_id: l1, title, content, is_starting_step: true }  → s1
  6. flowlearn_flow_step_create { lesson_id: l1, title, content }                          → s2
  7. flowlearn_connection_add  { flow_step_id: s1, to_step_id: s2, button_text: "Next", button_order: 1 }
  8. flowlearn_lesson_update   { lesson_id: l1, flow_completed: true }   ← REQUIRED before publish
  9. flowlearn_course_update   { course_id: c1, status: "published" }
`,

  publishing: `# Publishing rules

course.status='published' is REJECTED unless:
- The course has at least one module.
- At least one lesson has flow_completed=true.
- No module has gaps in lesson completion (later lessons complete, earlier ones not).
- No empty modules followed by completed modules.

Soft warnings (require force_publish: true):
- Trailing modules empty.
- Module partially complete.

Clean publish recipe: every module has at least one lesson with flow_completed=true, in order, no gaps. Set flow_completed via flowlearn_lesson_update.`,

  enums: `# Enum reference

flow_step.step_type: "message" | "quiz" | "exercise"     (DB CHECK constraint)
connection.button_action: "next" | "help" | "skip" | "custom" | "branch"   (no DB constraint, but these are what the renderer understands)
course.difficulty: "beginner" | "intermediate" | "advanced"
course.status: "draft" | "published" | "archived"
membership.role: "tenant_admin" | "creator" | "super_admin"   (admin roles — only these can write)

module.content shape: { objectives: string[] }     (only field rest of codebase reads)
lesson.content shape: { steps: any[] }              (legacy snapshot — live flow is in flow_steps + connections)`,

  troubleshooting: `# Troubleshooting

FLOWLEARN_API_401  → credentials invalid. Call flowlearn_setup_update.
FLOWLEARN_API_403  → tenant role insufficient. Check flowlearn_setup_status.active_tenant_is_admin.
FLOWLEARN_API_404  → entity id wrong. Call the matching *_list to enumerate valid ids.
FLOWLEARN_API_400  → request body invalid. The details.body usually contains the upstream complaint.
FLOWLEARN_API_5xx  → Flowlearn upstream issue. Retriable=true; back off and retry.

Tools renamed in v0.2.0: dotted names ('course.list') → snake_case ('flowlearn_course_list'). camelCase params ('flowStepId') → snake_case ('flow_step_id'). Existing scripts using dotted names will get UNKNOWN_TOOL.`,
};

const TopicEnum = z.enum([
  "overview",
  "publishing",
  "enums",
  "troubleshooting",
]);

export function buildHelpTools(): ToolDef[] {
  return [
    {
      name: "flowlearn_help",
      description:
        "Self-documenting reference: data model, hierarchy, enums, publishing rules, troubleshooting, and a worked authoring example.\n\n" +
        "When to use: at session start (load 'overview' once instead of guessing tool semantics); when you hit an unfamiliar error code; before publishing.\n" +
        "When NOT to use: as a substitute for inspecting actual data — call the *_list and *_get tools for current state.\n\n" +
        "Topics: overview (default), publishing, enums, troubleshooting.\n\n" +
        'Example call: { "topic": "publishing" }\n\n' +
        "Always succeeds; no error modes.",
      inputSchema: {
        topic: TopicEnum
          .optional()
          .describe(
            "Which reference page to return. Default 'overview'. Other: 'publishing', 'enums', 'troubleshooting'.",
          ),
      },
      outputSchema: z.object({
        entity: z.object({
          topic: TopicEnum,
          markdown: z.string(),
        }),
        summary: z.string(),
      }),
      annotations: {
        title: "Help / reference",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async ({ topic }) => {
        const t = (topic as keyof typeof TOPICS | undefined) ?? "overview";
        const markdown = TOPICS[t];
        return entityResult({
          entity: { topic: t, markdown },
          summary: `flowlearn_help: ${t} (${markdown.split("\n").length} lines).`,
        });
      },
    },
  ];
}
