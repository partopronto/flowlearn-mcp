/**
 * Prompts (user-invokable templates) for flowlearn-mcp.
 *
 * Surfaced as slash commands in Claude Code: e.g. `/mcp__flowlearn__scaffold_course`.
 * Each prompt expands to one or more chat messages that steer the agent
 * through a multi-tool workflow without re-explaining conventions per session.
 */

export type PromptArgument = {
  name: string;
  description?: string;
  required?: boolean;
};

export type PromptDef = {
  name: string;
  description: string;
  arguments?: PromptArgument[];
};

export type PromptMessage = {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
};

export type PromptResponse = {
  description?: string;
  messages: PromptMessage[];
};

const SCAFFOLD_COURSE: PromptDef = {
  name: "scaffold_course",
  description:
    "Build an entire flowlearn course from a free-form outline. Creates course → modules → lessons → flow steps → connections, and marks every lesson flow_completed=true so it's ready to publish.",
  arguments: [
    {
      name: "outline",
      description:
        "Free-form course outline. Any structured form works: bullet list, indented headings, plain prose. Bigger items become modules, smaller items lessons, leaves become flow steps.",
      required: true,
    },
    {
      name: "title",
      description: "Course title. If omitted, infer from the outline.",
      required: false,
    },
    {
      name: "language",
      description: "ISO language code (e.g. 'en', 'es'). Default 'en'.",
      required: false,
    },
  ],
};

const AUDIT_COURSE: PromptDef = {
  name: "audit_course",
  description:
    "Run a publish-readiness audit on a flowlearn course: missing flow_completed, lessons without a starting step, orphan flow steps, dead-end connections, empty modules. Reports findings; offers fixes.",
  arguments: [
    {
      name: "course_id",
      description: "ID of the course to audit. Use flowlearn_course_list to find one.",
      required: true,
    },
  ],
};

const IMPORT_MARKDOWN: PromptDef = {
  name: "import_markdown",
  description:
    "Convert a markdown document into a flowlearn course tree. H1 → course title, H2 → modules, H3 → lessons, paragraphs/list-items → flow steps. Wires linear next-button connections.",
  arguments: [
    {
      name: "markdown",
      description: "The markdown document to import.",
      required: true,
    },
    {
      name: "title_override",
      description: "Course title to use instead of the markdown's H1.",
      required: false,
    },
  ],
};

export const PROMPTS: PromptDef[] = [SCAFFOLD_COURSE, AUDIT_COURSE, IMPORT_MARKDOWN];

export function getPrompt(
  name: string,
  args: Record<string, string | undefined>,
): PromptResponse {
  switch (name) {
    case "scaffold_course":
      return scaffoldCoursePrompt(args);
    case "audit_course":
      return auditCoursePrompt(args);
    case "import_markdown":
      return importMarkdownPrompt(args);
    default:
      throw new PromptNotFoundError(`Unknown prompt: ${name}`);
  }
}

function scaffoldCoursePrompt(
  args: Record<string, string | undefined>,
): PromptResponse {
  const outline = args.outline ?? "";
  const title = args.title;
  const language = args.language ?? "en";

  const text = `You are scaffolding a flowlearn course from a free-form outline. Use the ONE-SHOT path below — do NOT chain individual create tools unless the user asks for that explicitly.

OUTLINE:
${outline.trim() || "(none provided — ask the user)"}

${title ? `Course title (provided): ${title}` : "Infer the course title from the outline."}
Language: ${language}

Steps:
1. Call flowlearn_setup_status. Confirm the active tenant is the one the user expects. If not, ASK before proceeding.
2. Read flowlearn://docs/overview if you haven't this session.
3. Parse the outline into a nested tree mapping:
   - Top-level groupings → modules
   - Sub-items → lessons (each lesson must have ≥1 step)
   - Leaf items / paragraphs → flow steps (each step needs title + content; default step_type: "message", use "quiz" for check-your-understanding leaves)
   If the outline is flat or ambiguous, propose a structure to the user FIRST. Don't guess silently.
4. Call flowlearn_course_outline_apply ONCE with the full tree:
     {
       "course": {
         "title": "...",
         "topic": "...",
         "language": "${language}",
         "modules": [
           { "title": "...", "objectives": ["..."], "lessons": [
             { "title": "...", "steps": [ {"title":"...","content":"..."}, ... ] }
           ]}
         ]
       },
       "client_request_id": "<random>",
       "dry_run": false
     }
   Defaults you DO NOT need to set: mark_flow_completed=true (good), publish=false (good — don't auto-publish), connections=linear-chain-with-Next-buttons (good for most outlines).
5. Inspect the response. If it errored, the partial course was rolled back; surface details.partial_tree to the user and propose a fix.
6. Call flowlearn_course_lint with the new course_id. If publish_ready=true and the user is happy, ASK whether to publish. If publish_ready=false, summarize the issues to the user.
7. Do NOT auto-publish. Report the course URL (entity.url in the response) and let the user trigger flowlearn_course_update status="published".

Override-only — call individual *_create tools instead if:
  - The user explicitly wants to add to an EXISTING course (outline_apply only creates new courses).
  - The outline has a complex non-linear flow (branching with multiple buttons per step) AND you need fine control. Even then, prefer outline_apply with explicit connections[] arrays per lesson.

If anything is ambiguous in the outline, ASK before creating. Cheap question vs. expensive cleanup.`;

  return {
    description: SCAFFOLD_COURSE.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

function auditCoursePrompt(
  args: Record<string, string | undefined>,
): PromptResponse {
  const courseId = args.course_id ?? "";

  const text = `Run a publish-readiness audit on flowlearn course id="${courseId}".

Steps:
1. Read the resource flowlearn://course/${courseId || "<COURSE_ID>"} to get the full tree (cheaper than multiple tool calls).
2. For each module, list its lessons via flowlearn_lesson_list.
3. For each lesson, fetch flowlearn://lesson/<lesson_id> to see flow steps + connections.
4. Check and report each of:
   - Course has at least one module.
   - Every module has at least one lesson with flow_completed: true.
   - No "completion gap" within a module (lesson 3 complete but lesson 1 isn't).
   - Every lesson has exactly one flow_step with is_starting_step: true.
   - No orphan flow steps (steps with no incoming OR outgoing connection except the starting step).
   - No dead-end connections (to_step_id pointing at an id that doesn't exist).
   - Course title and description present.
5. Output a checklist with PASS / FAIL per item, and for each FAIL: a one-line fix using the appropriate flowlearn_* tool.
6. Do NOT make any changes. This is read-only. After reporting, ask the user which fixes to apply.

If the course is publish-ready, say so explicitly and offer to call flowlearn_course_update with status: "published".`;

  return {
    description: AUDIT_COURSE.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

function importMarkdownPrompt(
  args: Record<string, string | undefined>,
): PromptResponse {
  const markdown = args.markdown ?? "";
  const titleOverride = args.title_override;

  const text = `Convert this markdown document into a flowlearn course tree.

Mapping rules:
- The first H1 becomes the course title (unless title_override is provided).
- Each H2 becomes a module.
- Each H3 becomes a lesson.
- Paragraphs / bullet items under an H3 become flow steps in order.
- Use the H1 paragraph (or the first paragraph) as the course description/topic.

${titleOverride ? `Title override: "${titleOverride}"` : ""}

MARKDOWN:
\`\`\`
${markdown.trim() || "(none provided — ask the user)"}
\`\`\`

Steps:
1. Call flowlearn_setup_status to confirm tenant.
2. Parse the markdown. If the structure doesn't fit the rules above, propose a mapping to the user before creating anything.
3. Call flowlearn_course_create with the inferred title + topic.
4. For each H2, call flowlearn_module_create.
5. For each H3, call flowlearn_lesson_create.
6. For each paragraph/bullet under an H3, call flowlearn_flow_step_create. The FIRST step in each lesson MUST have is_starting_step: true. Use step_type: "message" unless the paragraph contains "quiz" markers (?, "answer:", etc.) in which case use "quiz".
7. Wire flowlearn_connection_add between consecutive steps with button_text: "Next".
8. Mark every lesson flow_completed: true.
9. Report the course URL. Do NOT auto-publish.

Use client_request_id on every create call to make the operation idempotent. If the markdown is too ambiguous (e.g. only flat paragraphs, no headings), STOP and ask the user how they want it structured.`;

  return {
    description: IMPORT_MARKDOWN.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

export class PromptNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptNotFoundError";
  }
}
