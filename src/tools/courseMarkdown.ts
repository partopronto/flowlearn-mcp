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
 * Markdown round-trip tools for flowlearn courses.
 *
 * flowlearn_course_export_markdown — walk an existing course tree and emit a
 *   human-readable markdown document that can be edited offline.
 *
 * flowlearn_course_import_markdown — parse that document back into an outline
 *   and either return a preview (dry_run=true) or build the full course tree
 *   (dry_run=false) by replicating the outline_apply build logic.
 *
 * The markdown format is intentionally regular so it can be parsed with a
 * hand-rolled state-machine (no external deps). Every heading level has a
 * unique role:
 *   # Course title
 *   ## Module N: <title>
 *   ### Lesson N.M: <title>
 *   #### Step K: <title> (<step_type>)
 *
 * Connections are serialised as:
 *   **Connections:**
 *   - 1 → 2 [Next]
 *   - 2 → end [Complete lesson]
 */

// ---------------------------------------------------------------------------
// Shared Zod shapes (mirror courseExport.ts / courseOutline.ts as needed)
// ---------------------------------------------------------------------------

const StepTypeEnum = z.enum(["message", "quiz", "exercise"]);
const ButtonActionEnum = z.enum(["next", "help", "skip", "custom", "branch"]);

const MdExportOutputSchema = z.object({
  entity: z.object({
    source_course_id: z.string(),
    exported_at: z.string(),
    markdown: z.string(),
    stats: z.object({
      modules: z.number().int(),
      lessons: z.number().int(),
      flow_steps: z.number().int(),
      connections: z.number().int(),
      characters: z.number().int(),
    }),
    warnings: z.array(z.string()).optional(),
  }),
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

const MdImportOutputSchema = z.object({
  entity: z.union([
    // dry_run shape
    z.object({
      dry_run: z.literal(true),
      parsed_outline: z.unknown(),
      validation: z.object({
        ok: z.boolean(),
        errors: z.array(z.string()),
      }),
      stats: z.object({
        modules: z.number().int(),
        lessons: z.number().int(),
        flow_steps: z.number().int(),
        connections: z.number().int(),
      }),
    }),
    // live build shape (mirrors outline_apply)
    z.object({
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
  ]),
  summary: z.string(),
  url: z.string().optional(),
  resource_uri: z.string().optional(),
  next_actions: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Internal parsed-outline types
// ---------------------------------------------------------------------------

type ParsedConnection = {
  from_index: number; // 0-based
  to_index: number | null; // 0-based or null for terminal
  button_text: string;
  button_action?: "next" | "help" | "skip" | "custom" | "branch";
};

type ParsedStep = {
  title: string;
  content: string;
  step_type: "message" | "quiz" | "exercise";
  is_starting_step?: boolean;
};

type ParsedLesson = {
  title: string;
  description?: string;
  steps: ParsedStep[];
  connections?: ParsedConnection[];
};

type ParsedModule = {
  title: string;
  description?: string;
  objectives?: string[];
  lessons: ParsedLesson[];
};

type ParsedOutline = {
  title: string;
  description?: string;
  topic?: string;
  difficulty?: "beginner" | "intermediate" | "advanced";
  language?: string;
  tone?: string;
  modules: ParsedModule[];
};

// ---------------------------------------------------------------------------
// Markdown exporter
// ---------------------------------------------------------------------------

function exportToMarkdown(
  course: Record<string, unknown>,
  modules: Array<{
    title: string;
    description?: string;
    objectives?: string[];
    lessons: Array<{
      title: string;
      description?: string;
      steps: Array<{
        title: string;
        content: string;
        step_type?: string;
        is_starting_step?: boolean;
        image_url?: string | null;
      }>;
      connections: Array<{
        from_index: number;
        to_index: number | null;
        button_text: string;
        button_action?: string;
      }>;
    }>;
  }>,
): { markdown: string; warnings: string[] } {
  const warnings: string[] = [];
  const lines: string[] = [];

  // Course title + front-matter
  const courseTitle = String(course.title ?? "Untitled Course");
  lines.push(`# ${courseTitle}`);
  lines.push("");

  const description = (course.description as string | null | undefined);
  if (description) {
    lines.push(`> ${description.trim()}`);
    lines.push("");
  }

  // Metadata bullet block — skip null/empty values
  const metaLines: string[] = [];
  const topic = (course.topic as string | null | undefined);
  const difficulty = (course.difficulty as string | null | undefined);
  const language = (course.language as string | null | undefined);
  const tone = (course.tone as string | null | undefined);
  if (topic) metaLines.push(`- topic: ${topic}`);
  if (difficulty) metaLines.push(`- difficulty: ${difficulty}`);
  if (language) metaLines.push(`- language: ${language}`);
  if (tone) metaLines.push(`- tone: ${tone}`);
  if (metaLines.length > 0) {
    lines.push(...metaLines);
    lines.push("");
  }

  // Modules
  for (let mi = 0; mi < modules.length; mi++) {
    const m = modules[mi];
    lines.push(`## Module ${mi + 1}: ${m.title}`);
    lines.push("");
    if (m.description) {
      lines.push(`> ${m.description.trim()}`);
      lines.push("");
    }
    if (m.objectives && m.objectives.length > 0) {
      lines.push("**Objectives:**");
      for (const obj of m.objectives) {
        lines.push(`- ${obj}`);
      }
      lines.push("");
    }

    // Lessons
    for (let li = 0; li < m.lessons.length; li++) {
      const l = m.lessons[li];
      lines.push(`### Lesson ${mi + 1}.${li + 1}: ${l.title}`);
      lines.push("");
      if (l.description) {
        lines.push(`> ${l.description.trim()}`);
        lines.push("");
      }

      // Steps
      for (let si = 0; si < l.steps.length; si++) {
        const s = l.steps[si];
        const stepType = (s.step_type ?? "message") as string;
        const starFlag = s.is_starting_step === true ? " ★" : "";
        lines.push(`#### Step ${si + 1}: ${s.title}${starFlag} (${stepType})`);
        lines.push("");
        if (s.content) {
          lines.push(s.content.trim());
          lines.push("");
        }
        // Append image reference (for round-trip documentation only; importer ignores it)
        if (s.image_url) {
          lines.push(`![image](${s.image_url})`);
          lines.push("");
        }
      }

      // Connections block
      if (l.connections.length > 0) {
        lines.push("**Connections:**");
        for (const c of l.connections) {
          // from/to are already 0-based; convert to 1-based for the format
          const from1 = c.from_index + 1;
          const to1 = c.to_index === null ? "end" : String(c.to_index + 1);
          const action = c.button_action;
          // Only serialise action when non-default (≠ "next" and ≠ undefined)
          const actionSuffix =
            action && action !== "next" ? ` (${action})` : "";
          lines.push(`- ${from1} → ${to1} [${c.button_text}]${actionSuffix}`);
        }
        // Track cross-lesson edges that cannot round-trip (they were already
        // omitted by courseExport.ts; we detect them by out-of-range to_index
        // which in theory never happens here but keep as a guard).
        lines.push("");
      }
    }
  }

  return { markdown: lines.join("\n"), warnings };
}

// ---------------------------------------------------------------------------
// Markdown parser (hand-rolled state machine — no external deps)
// ---------------------------------------------------------------------------

type ParseError = { line: number; message: string };

type ParseResult =
  | { ok: true; outline: ParsedOutline }
  | { ok: false; errors: ParseError[] };

/**
 * Parse the flowlearn round-trip markdown format back into a ParsedOutline.
 * Returns all errors found (not just the first) so the caller can surface a
 * useful report.
 */
function parseMarkdown(markdown: string): ParseResult {
  const rawLines = markdown.split(/\r?\n/);
  const errors: ParseError[] = [];

  // State
  let courseTitle = "";
  let courseDescription: string | undefined;
  let courseTopic: string | undefined;
  let courseDifficulty: "beginner" | "intermediate" | "advanced" | undefined;
  let courseLanguage: string | undefined;
  let courseTone: string | undefined;

  const modules: ParsedModule[] = [];
  let currentModule: ParsedModule | null = null;
  let currentLesson: ParsedLesson | null = null;
  let currentStep: ParsedStep | null = null;
  let currentStepContentLines: string[] = [];

  // Parser phases
  type Phase =
    | "preamble"       // before ## headings, collecting course front-matter
    | "module"         // inside a module, before first lesson
    | "lesson"         // inside a lesson, before first step
    | "step_body"      // collecting step content lines
    | "connections";   // after **Connections:** marker

  let phase: Phase = "preamble";

  // Helpers: flush current step
  function flushStep() {
    if (currentStep) {
      currentStep.content = currentStepContentLines.join("\n").trim();
      currentStepContentLines = [];
      if (currentLesson) {
        currentLesson.steps.push(currentStep);
      }
      currentStep = null;
    }
  }

  // Helpers: flush current lesson
  function flushLesson() {
    flushStep();
    if (currentLesson) {
      if (currentModule) {
        currentModule.lessons.push(currentLesson);
      }
      currentLesson = null;
    }
  }

  // Helpers: flush current module
  function flushModule() {
    flushLesson();
    if (currentModule) {
      modules.push(currentModule);
      currentModule = null;
    }
  }

  // Connection line regex: - from → to [text] optional(action)
  const connRe =
    /^- (\d+) → (\d+|end) \[([^\]]+)\](?: \((next|help|skip|custom|branch)\))?$/;

  // Step heading regex: #### Step K: title (step_type) optional ★
  // The ★ may appear inside the title portion or just before the parens.
  const stepHeadingRe =
    /^#### Step \d+: (.+?) ★? *\((message|quiz|exercise)\) *★?$/;

  // Preamble state: track whether we've seen the blockquote description
  let inMetaBullets = false;
  let inPreambleBlockquote = false;

  for (let li = 0; li < rawLines.length; li++) {
    const lineNum = li + 1;
    const line = rawLines[li];

    // -----------------------------------------------------------------------
    // H1: course title (must be first non-empty line)
    // -----------------------------------------------------------------------
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      if (phase !== "preamble") {
        errors.push({
          line: lineNum,
          message: `Unexpected H1 heading after course preamble: "${line}"`,
        });
        continue;
      }
      courseTitle = line.slice(2).trim();
      continue;
    }

    // -----------------------------------------------------------------------
    // H2: module
    // -----------------------------------------------------------------------
    if (line.startsWith("## ")) {
      flushModule();
      phase = "module";
      inMetaBullets = false;
      inPreambleBlockquote = false;
      // Strip "Module N: " prefix if present
      const raw = line.slice(3).trim();
      const modPrefixRe = /^Module \d+:\s*/;
      const title = raw.replace(modPrefixRe, "");
      if (!title) {
        errors.push({ line: lineNum, message: `Module heading has no title: "${line}"` });
        continue;
      }
      currentModule = { title, lessons: [] };
      continue;
    }

    // -----------------------------------------------------------------------
    // H3: lesson
    // -----------------------------------------------------------------------
    if (line.startsWith("### ")) {
      flushLesson();
      phase = "lesson";
      const raw = line.slice(4).trim();
      const lessonPrefixRe = /^Lesson \d+\.\d+:\s*/;
      const title = raw.replace(lessonPrefixRe, "");
      if (!title) {
        errors.push({ line: lineNum, message: `Lesson heading has no title: "${line}"` });
        continue;
      }
      if (!currentModule) {
        errors.push({ line: lineNum, message: `Lesson heading found outside any module: "${line}"` });
        continue;
      }
      currentLesson = { title, steps: [] };
      continue;
    }

    // -----------------------------------------------------------------------
    // H4: step
    // -----------------------------------------------------------------------
    if (line.startsWith("#### ")) {
      flushStep();
      if (phase === "connections") {
        // Connections block ended implicitly
        phase = "step_body";
      }
      phase = "step_body";
      if (!currentLesson) {
        errors.push({ line: lineNum, message: `Step heading found outside any lesson: "${line}"` });
        continue;
      }
      const m = stepHeadingRe.exec(line);
      if (!m) {
        errors.push({
          line: lineNum,
          message: `Malformed step heading (expected "#### Step N: <title> (<type>)"): "${line}"`,
        });
        continue;
      }
      const rawTitle = m[1].trim();
      // Strip ★ from title if present (importer restores the flag)
      const isStarting = rawTitle.includes("★") || line.includes("★");
      const cleanTitle = rawTitle.replace(/★/g, "").trim();
      const stepType = m[2] as "message" | "quiz" | "exercise";
      currentStep = {
        title: cleanTitle,
        content: "",
        step_type: stepType,
        is_starting_step: isStarting ? true : undefined,
      };
      currentStepContentLines = [];
      continue;
    }

    // -----------------------------------------------------------------------
    // H5+: not used by the format — treat as content if inside a step
    // -----------------------------------------------------------------------
    if (line.startsWith("#####")) {
      if (phase === "step_body" && currentStep) {
        currentStepContentLines.push(line);
      }
      // Otherwise ignore silently (could be user's own markdown)
      continue;
    }

    // -----------------------------------------------------------------------
    // **Connections:** marker
    // -----------------------------------------------------------------------
    if (line.trim() === "**Connections:**") {
      if (phase === "step_body") {
        flushStep();
      }
      phase = "connections";
      if (!currentLesson) {
        errors.push({ line: lineNum, message: `"**Connections:**" found outside any lesson.` });
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // **Objectives:** marker (inside a module, before first lesson)
    // -----------------------------------------------------------------------
    if (line.trim() === "**Objectives:**" && phase === "module" && currentModule) {
      // Objectives follow as bullet lines until blank line or non-bullet
      // We handle them inline in the main loop; set a flag
      // (We'll collect them as plain bullets in the module's accumulator)
      // The next lines that start with "- " are objectives
      // We handle them by checking the module context in the bullet section below
      continue;
    }

    // -----------------------------------------------------------------------
    // Connection lines
    // -----------------------------------------------------------------------
    if (phase === "connections" && line.startsWith("- ")) {
      if (!currentLesson) continue;
      const cm = connRe.exec(line);
      if (!cm) {
        errors.push({
          line: lineNum,
          message: `Malformed connection line: "${line}"`,
        });
        continue;
      }
      const from1 = parseInt(cm[1], 10);
      const to1Raw = cm[2];
      const btnText = cm[3];
      const btnAction = (cm[4] as "next" | "help" | "skip" | "custom" | "branch" | undefined) ?? undefined;
      if (!currentLesson.connections) currentLesson.connections = [];
      currentLesson.connections.push({
        from_index: from1 - 1, // convert to 0-based
        to_index: to1Raw === "end" ? null : parseInt(to1Raw, 10) - 1,
        button_text: btnText,
        button_action: btnAction,
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // Preamble: blockquote description (> ...)
    // -----------------------------------------------------------------------
    if (phase === "preamble" && line.startsWith("> ")) {
      if (!inMetaBullets) {
        // First blockquote in preamble = description
        courseDescription = (courseDescription ? courseDescription + " " : "") + line.slice(2).trim();
        inPreambleBlockquote = true;
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Module/Lesson description (blockquote)
    // -----------------------------------------------------------------------
    if (line.startsWith("> ") && (phase === "module" || phase === "lesson")) {
      const text = line.slice(2).trim();
      if (phase === "module" && currentModule && !currentModule.description) {
        currentModule.description = text;
      } else if (phase === "lesson" && currentLesson && !currentLesson.description) {
        currentLesson.description = text;
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Step body: blockquote (treated as content)
    // -----------------------------------------------------------------------
    if (line.startsWith("> ") && phase === "step_body") {
      currentStepContentLines.push(line);
      continue;
    }

    // -----------------------------------------------------------------------
    // Bullet lines
    // -----------------------------------------------------------------------
    if (line.startsWith("- ")) {
      const rest = line.slice(2).trim();

      // Preamble metadata bullets
      if (phase === "preamble") {
        inMetaBullets = true;
        inPreambleBlockquote = false;
        if (rest.startsWith("topic: ")) {
          courseTopic = rest.slice(7).trim();
        } else if (rest.startsWith("difficulty: ")) {
          const d = rest.slice(12).trim();
          if (d === "beginner" || d === "intermediate" || d === "advanced") {
            courseDifficulty = d;
          } else {
            errors.push({
              line: lineNum,
              message: `Invalid difficulty value "${d}" (must be beginner|intermediate|advanced).`,
            });
          }
        } else if (rest.startsWith("language: ")) {
          courseLanguage = rest.slice(10).trim();
        } else if (rest.startsWith("tone: ")) {
          courseTone = rest.slice(6).trim();
        }
        // Unknown metadata keys are silently ignored
        continue;
      }

      // Module objectives bullets (only if inside module phase, before first lesson)
      if (phase === "module" && currentModule) {
        if (!currentModule.objectives) currentModule.objectives = [];
        currentModule.objectives.push(rest);
        continue;
      }

      // Step body bullets
      if (phase === "step_body" && currentStep) {
        currentStepContentLines.push(line);
        continue;
      }

      // Connection phase bullets not starting with digit — fall through to content
      if (phase === "connections") {
        // Non-matching bullet in connections context is silently skipped
        // (already handled above)
        continue;
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Step body: all other lines accumulate as content
    // -----------------------------------------------------------------------
    if (phase === "step_body" && currentStep) {
      // Skip markdown image lines (they're for reference only during export)
      if (/^!\[image\]\(/.test(line)) {
        continue;
      }
      currentStepContentLines.push(line);
      continue;
    }

    // -----------------------------------------------------------------------
    // Blank lines — reset some state flags
    // -----------------------------------------------------------------------
    if (line.trim() === "") {
      if (phase === "connections") {
        // End of connections block — next non-blank will be a new step or heading
        phase = currentLesson ? "lesson" : "module";
      }
      // Otherwise just ignore blank lines
      continue;
    }

    // -----------------------------------------------------------------------
    // Remaining lines in lesson / module body (non-step text)
    // -----------------------------------------------------------------------
    // e.g. descriptive text between headings — collect into current step if
    // we somehow have one open; otherwise silently ignore.
    if (phase === "step_body" && currentStep) {
      currentStepContentLines.push(line);
    }
  }

  // Flush trailing state
  flushModule();

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (!courseTitle) {
    return {
      ok: false,
      errors: [{ line: 1, message: "No H1 course title found." }],
    };
  }

  const outline: ParsedOutline = {
    title: courseTitle,
    description: courseDescription,
    topic: courseTopic,
    difficulty: courseDifficulty,
    language: courseLanguage,
    tone: courseTone,
    modules,
  };

  return { ok: true, outline };
}

// ---------------------------------------------------------------------------
// Validation pass on parsed outline
// ---------------------------------------------------------------------------

function validateOutline(outline: ParsedOutline): string[] {
  const errs: string[] = [];
  const validDifficulties = ["beginner", "intermediate", "advanced"];
  if (outline.difficulty && !validDifficulties.includes(outline.difficulty)) {
    errs.push(
      `Course difficulty "${outline.difficulty}" is not valid (must be beginner|intermediate|advanced).`,
    );
  }
  const validStepTypes = ["message", "quiz", "exercise"];
  for (const m of outline.modules) {
    for (const l of m.lessons) {
      for (const s of l.steps) {
        if (!validStepTypes.includes(s.step_type)) {
          errs.push(
            `Lesson "${l.title}", step "${s.title}": step_type "${s.step_type}" is invalid (must be message|quiz|exercise).`,
          );
        }
      }
      if (l.connections) {
        const stepCount = l.steps.length;
        for (const c of l.connections) {
          if (c.from_index < 0 || c.from_index >= stepCount) {
            errs.push(
              `Lesson "${l.title}": connection from_index=${c.from_index + 1} out of range (lesson has ${stepCount} step(s)).`,
            );
          }
          if (c.to_index !== null && (c.to_index < 0 || c.to_index >= stepCount)) {
            errs.push(
              `Lesson "${l.title}": connection to_index=${c.to_index + 1} out of range (lesson has ${stepCount} step(s)).`,
            );
          }
        }
      }
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Default linear chain (mirrors courseOutline.ts exactly)
// ---------------------------------------------------------------------------

function defaultLinearChain(stepCount: number): ParsedConnection[] {
  const conns: ParsedConnection[] = [];
  for (let i = 0; i < stepCount - 1; i++) {
    conns.push({
      from_index: i,
      to_index: i + 1,
      button_text: "Next",
      button_action: "next",
    });
  }
  if (stepCount > 0) {
    conns.push({
      from_index: stepCount - 1,
      to_index: null,
      button_text: "Complete lesson",
      button_action: "next",
    });
  }
  return conns;
}

function countOutline(outline: ParsedOutline) {
  let lessons = 0;
  let flow_steps = 0;
  let connections = 0;
  for (const m of outline.modules) {
    lessons += m.lessons.length;
    for (const l of m.lessons) {
      flow_steps += l.steps.length;
      connections += (l.connections ?? defaultLinearChain(l.steps.length)).length;
    }
  }
  return { modules: outline.modules.length, lessons, flow_steps, connections };
}

// ---------------------------------------------------------------------------
// Build-course logic (mirrors outline_apply; no shared import by design)
// ---------------------------------------------------------------------------

type CreatedTree = {
  course: Record<string, unknown> | null;
  modules: Record<string, unknown>[];
  lessons: Record<string, unknown>[];
  flow_steps: Record<string, unknown>[];
  connections: Record<string, unknown>[];
};

class MarkdownBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownBuildError";
  }
}

async function buildFromOutline(
  client: FlowlearnClient,
  outline: ParsedOutline,
  opts: {
    mark_flow_completed: boolean;
    publish: boolean;
    rollback_on_error: boolean;
  },
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: Record<string, unknown> }
> {
  const created: CreatedTree = {
    course: null,
    modules: [],
    lessons: [],
    flow_steps: [],
    connections: [],
  };

  try {
    // 1. Create course
    const courseResp = await client.request<{ course?: Record<string, unknown> }>(
      "/api/courses",
      {
        method: "POST",
        body: {
          title: outline.title,
          topic: outline.topic ?? outline.title,
          description: outline.description,
          tone: outline.tone,
          difficulty: outline.difficulty,
          language: outline.language,
        },
      },
    );
    const courseEntity = (courseResp.course ?? courseResp) as Record<string, unknown>;
    created.course = courseEntity;
    const courseId = String(courseEntity.id);

    // 2. Modules → lessons → steps → connections
    for (const m of outline.modules) {
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

        // Decide starting step
        const explicitStarter = l.steps.findIndex((s) => s.is_starting_step === true);
        const starterIdx = explicitStarter >= 0 ? explicitStarter : 0;

        const stepIds: string[] = [];
        for (let si = 0; si < l.steps.length; si++) {
          const s = l.steps[si];
          const stepResp = await client.request<{ flow_step?: Record<string, unknown> }>(
            `/api/lessons/${lessonId}/flow-steps`,
            {
              method: "POST",
              body: {
                title: s.title,
                content: s.content,
                step_type: s.step_type ?? "message",
                is_starting_step: si === starterIdx,
              },
            },
          );
          const stepEntity = (stepResp.flow_step ?? stepResp) as Record<string, unknown>;
          created.flow_steps.push(stepEntity);
          stepIds.push(String(stepEntity.id));
        }

        // Wire connections
        const conns = l.connections ?? defaultLinearChain(l.steps.length);
        for (const c of conns) {
          if (c.from_index >= stepIds.length || c.from_index < 0) {
            throw new MarkdownBuildError(
              `connection.from_index=${c.from_index} out of range (lesson '${l.title}' has ${stepIds.length} steps).`,
            );
          }
          if (c.to_index !== null && (c.to_index >= stepIds.length || c.to_index < 0)) {
            throw new MarkdownBuildError(
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
                button_order: 1,
              },
            },
          );
          const connEntity = (connResp.connection ?? connResp) as Record<string, unknown>;
          created.connections.push(connEntity);
        }

        // Mark flow_completed
        if (opts.mark_flow_completed) {
          await client.request(`/api/lessons/${lessonId}`, {
            method: "PUT",
            body: { flow_completed: true },
          });
        }
      }
    }

    // 3. Optional publish
    let published = false;
    if (opts.publish) {
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

    return {
      ok: true,
      result: {
        course: courseEntity,
        stats,
        modules: created.modules,
        lessons: created.lessons,
        flow_steps: created.flow_steps,
        connections: created.connections,
        flow_completed_marked: opts.mark_flow_completed,
        published,
      },
    };
  } catch (err) {
    const partial = {
      course_id: created.course
        ? String((created.course as Record<string, unknown>).id)
        : null,
      modules_created: created.modules.length,
      lessons_created: created.lessons.length,
      flow_steps_created: created.flow_steps.length,
      connections_created: created.connections.length,
    };

    let rolledBackOk = false;
    let rollbackError: string | undefined;
    if (opts.rollback_on_error && created.course) {
      try {
        await client.request(
          `/api/courses/${partial.course_id}`,
          { method: "DELETE" },
        );
        rolledBackOk = true;
      } catch (rbErr) {
        rolledBackOk = false;
        rollbackError = rbErr instanceof Error ? rbErr.message : String(rbErr);
      }
    }

    const message = err instanceof Error ? err.message : String(err);
    const details: Record<string, unknown> = {
      partial_tree: partial,
      rolled_back: rolledBackOk,
    };
    if (rollbackError !== undefined) details.rollback_error = rollbackError;

    let suggestion: string;
    if (!opts.rollback_on_error) {
      suggestion =
        "Course was NOT rolled back (rollback_on_error=false). Use flowlearn_course_get or flowlearn_course_delete to clean up.";
    } else if (rolledBackOk) {
      suggestion = "Partial course was rolled back. See details.partial_tree.";
    } else if (created.course) {
      suggestion = `Rollback DELETE failed (see details.rollback_error). Partial course id=${partial.course_id} still exists; call flowlearn_course_delete manually.`;
    } else {
      suggestion = "No course was created before failure — nothing to roll back.";
    }

    return {
      ok: false,
      error: {
        code: "MARKDOWN_BUILD_FAILED",
        message: `import_markdown build failed: ${message}`,
        suggestion,
        retriable: false,
        details,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildCourseMarkdownTools(client: FlowlearnClient): ToolDef[] {
  const cfg = () => client.getConfig();

  return [
    // -----------------------------------------------------------------------
    // flowlearn_course_export_markdown
    // -----------------------------------------------------------------------
    {
      name: "flowlearn_course_export_markdown",
      description:
        "Read-only export of an existing course as a human-editable, SELF-PARSING markdown document. The output can be edited offline and re-applied via flowlearn_course_import_markdown to create a new course (round-trip).\n\n" +
        "Format: H1 = course title; front-matter blockquote + metadata bullets; H2 = modules; H3 = lessons; H4 = steps with type annotation in parens. Connections are serialised as a **Connections:** bullet block per lesson. Image URLs are appended as `![image](url)` lines for reference (importer ignores them — re-attach images separately).\n\n" +
        "When to use: offline editing of a course; backing up before restructure; cloning/forking via edit-then-import; sharing a human-readable draft for review.\n" +
        "When NOT to use: just wanting course metadata (use flowlearn_course_get); needing JSON for programmatic processing (use flowlearn_course_export_outline).\n\n" +
        "Cross-lesson connections cannot round-trip (positional index format is per-lesson). They are OMITTED and surfaced in `warnings[]`.\n\n" +
        'Example call: { "course_id": "crs_abc" }\n\n' +
        "Errors: FLOWLEARN_API_404 if course_id is invalid.",
      inputSchema: {
        course_id: z.string().min(1),
      },
      outputSchema: MdExportOutputSchema,
      annotations: {
        title: "Export course as markdown",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id }) => {
        const warnings: string[] = [];

        // --- Walk the course tree (mirrors courseExport.ts) ---
        const courseResp = await client.request<{ course?: Record<string, unknown> }>(
          `/api/courses/${course_id}`,
        );
        const course = (courseResp.course ?? courseResp) as Record<string, unknown>;

        const modulesArr: Record<string, unknown>[] =
          (course.modules as Record<string, unknown>[] | undefined) ??
          (await client
            .request<{ modules?: unknown[] }>(`/api/courses/${course_id}/modules`)
            .then(
              (d) =>
                (Array.isArray(d) ? d : (d.modules ?? [])) as Record<string, unknown>[],
            ));

        type MdModuleData = {
          title: string;
          description?: string;
          objectives?: string[];
          lessons: Array<{
            title: string;
            description?: string;
            steps: Array<{
              title: string;
              content: string;
              step_type?: string;
              is_starting_step?: boolean;
              image_url?: string | null;
            }>;
            connections: Array<{
              from_index: number;
              to_index: number | null;
              button_text: string;
              button_action?: string;
            }>;
          }>;
        };

        const mdModules: MdModuleData[] = [];
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
            : (lessonsResp as { lessons?: unknown[] })?.lessons ?? []) as Record<
            string,
            unknown
          >[];

          const mdLessons: MdModuleData["lessons"] = [];

          for (const l of lessons) {
            const lessonId = String(l.id);
            const stepsResp = await client.request<unknown>(
              `/api/lessons/${lessonId}/flow-steps`,
            );
            const steps = (Array.isArray(stepsResp)
              ? stepsResp
              : (stepsResp as { flow_steps?: unknown[] })?.flow_steps ?? []) as Record<
              string,
              unknown
            >[];

            steps.sort(
              (a, b) =>
                Number(a.order_index ?? 0) - Number(b.order_index ?? 0),
            );

            const stepIdToIndex = new Map<string, number>();
            const mdSteps: MdModuleData["lessons"][0]["steps"] = [];
            steps.forEach((s, i) => {
              stepIdToIndex.set(String(s.id), i);
              mdSteps.push({
                title: String(s.title ?? ""),
                content: String(s.content ?? ""),
                step_type: (s.step_type as string | undefined) ?? "message",
                is_starting_step: s.is_starting_step === true ? true : undefined,
                image_url: (s.image_url as string | null | undefined) ?? null,
              });
            });

            const mdConns: MdModuleData["lessons"][0]["connections"] = [];
            for (const s of steps) {
              const fromIdx = stepIdToIndex.get(String(s.id));
              if (fromIdx === undefined) continue;
              const fromTitle = String(s.title ?? "");
              const conns = (s.connections as Record<string, unknown>[] | undefined) ?? [];
              for (const c of conns) {
                const target = c.to_step_id;
                let toIdx: number | null;
                if (target === null || target === undefined) {
                  toIdx = null;
                } else {
                  const localIdx = stepIdToIndex.get(String(target));
                  if (localIdx === undefined) {
                    warnings.push(
                      `Lesson '${String(l.title ?? "")}' (id=${lessonId}): connection from step '${fromTitle}' targets step ${String(target)} in a different lesson — cross-lesson edges cannot round-trip; this connection was OMITTED.`,
                    );
                    continue;
                  }
                  toIdx = localIdx;
                }
                mdConns.push({
                  from_index: fromIdx,
                  to_index: toIdx,
                  button_text: String(c.button_text ?? "Next"),
                  button_action: (c.button_action as string | undefined) ?? undefined,
                });
              }
            }

            mdLessons.push({
              title: String(l.title ?? ""),
              description: (l.description as string | undefined) ?? undefined,
              steps: mdSteps,
              connections: mdConns,
            });

            totalLessons += 1;
            totalSteps += mdSteps.length;
            totalConnections += mdConns.length;
          }

          mdModules.push({
            title: String(m.title ?? ""),
            description: (m.description as string | undefined) ?? undefined,
            objectives:
              (m.content as { objectives?: string[] } | null | undefined)
                ?.objectives ?? undefined,
            lessons: mdLessons,
          });
        }

        const { markdown, warnings: exportWarnings } = exportToMarkdown(course, mdModules);
        warnings.push(...exportWarnings);

        return entityResult({
          entity: {
            source_course_id: String(course_id),
            exported_at: new Date().toISOString(),
            markdown,
            stats: {
              modules: mdModules.length,
              lessons: totalLessons,
              flow_steps: totalSteps,
              connections: totalConnections,
              characters: markdown.length,
            },
            warnings: warnings.length > 0 ? warnings : undefined,
          },
          summary:
            `Exported course '${course.title}' (id=${course_id}) as markdown: ${mdModules.length} modules, ${totalLessons} lessons, ${totalSteps} steps, ${totalConnections} connections, ${markdown.length} chars.` +
            (warnings.length > 0
              ? ` ${warnings.length} cross-lesson edge(s) omitted — see warnings.`
              : ""),
          next_actions: [
            `Edit the markdown offline, then call flowlearn_course_import_markdown with { markdown: <edited-text>, dry_run: true } to preview before building.`,
            `Call flowlearn_course_import_markdown with dry_run: false to build a new course from the edited markdown.`,
          ],
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      },
    },

    // -----------------------------------------------------------------------
    // flowlearn_course_import_markdown
    // -----------------------------------------------------------------------
    {
      name: "flowlearn_course_import_markdown",
      description:
        "Parse a flowlearn round-trip markdown document (produced by flowlearn_course_export_markdown or hand-authored in the same format) and either preview the parsed outline (dry_run=true, the safe default) or build the full course tree on flowlearn.io (dry_run=false).\n\n" +
        "Expected format: H1 course title; optional blockquote description + metadata bullet list; H2 modules (prefix 'Module N:' stripped); H3 lessons (prefix 'Lesson N.M:' stripped); H4 steps with type in parens — e.g. `#### Step 1: Title (message)`; **Connections:** bullet block per lesson with `- from → to [button text]` syntax. Full grammar documented in flowlearn_course_export_markdown's output.\n\n" +
        "Dry-run (default true): parse + validate + return outline. No course is created. Use this first — it's cheap and catches format errors early.\n\n" +
        "Live build (dry_run=false): replicates flowlearn_course_outline_apply build logic — POST course → modules → lessons → steps → connections. Rollback on error if rollback_on_error=true (default).\n\n" +
        "Idempotent retry: pass client_request_id; same key returns cached result.\n\n" +
        "Image re-attachment: image URLs embedded in the markdown (![image](url) lines) are IGNORED during import. Re-attach images separately with flowlearn_flow_step_upload_image after the course is built.\n\n" +
        "Errors: MARKDOWN_PARSE_FAILED with line number pointer on format violations. OUTLINE_VALIDATION on out-of-range connection indices. MARKDOWN_BUILD_FAILED if upstream API calls fail during live build.",
      inputSchema: {
        markdown: z.string().min(1),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Default true (preview only — does NOT create a course). Pass false to actually build. Matches import_markdown safety convention: preview first.",
          ),
        mark_flow_completed: z
          .boolean()
          .optional()
          .describe(
            "Default true. After each lesson is built, mark flow_completed=true so the course is publish-ready.",
          ),
        publish: z
          .boolean()
          .optional()
          .describe(
            "Default false. If true, publish the course after building.",
          ),
        rollback_on_error: z
          .boolean()
          .optional()
          .describe(
            "Default true. If a sub-call fails partway through, delete the course (cascade kills children).",
          ),
        ...IdempotencyField,
      },
      outputSchema: MdImportOutputSchema,
      annotations: {
        title: "Import markdown as course",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (args) => {
        const {
          markdown,
          dry_run = true,
          mark_flow_completed = true,
          publish = false,
          rollback_on_error = true,
          client_request_id,
        } = args as {
          markdown: string;
          dry_run?: boolean;
          mark_flow_completed?: boolean;
          publish?: boolean;
          rollback_on_error?: boolean;
          client_request_id?: string;
        };

        // --- Parse ---
        const parseResult = parseMarkdown(markdown);
        if (!parseResult.ok) {
          const firstError = parseResult.errors[0];
          return errorResult({
            code: "MARKDOWN_PARSE_FAILED",
            message: `Markdown parse failed at line ${firstError.line}: ${firstError.message}`,
            suggestion:
              "Check the markdown format. Use flowlearn_course_export_markdown to see a valid example. Errors found: " +
              parseResult.errors.map((e) => `line ${e.line}: ${e.message}`).join("; "),
            retriable: true,
            details: {
              errors: parseResult.errors,
            },
          });
        }

        const { outline } = parseResult;

        // --- Validate ---
        const validationErrors = validateOutline(outline);

        // --- Dry-run ---
        if (dry_run) {
          const stats = countOutline(outline);
          return entityResult({
            entity: {
              dry_run: true as const,
              parsed_outline: outline,
              validation: {
                ok: validationErrors.length === 0,
                errors: validationErrors,
              },
              stats,
            },
            summary:
              `[dry-run] Parsed markdown: course '${outline.title}', ${stats.modules} modules, ${stats.lessons} lessons, ${stats.flow_steps} steps, ${stats.connections} connections.` +
              (validationErrors.length > 0
                ? ` ${validationErrors.length} validation error(s) — fix before building.`
                : " Validation OK."),
            next_actions:
              validationErrors.length === 0
                ? [
                    `Call flowlearn_course_import_markdown with dry_run=false (and optionally client_request_id) to build the course.`,
                  ]
                : [
                    `Fix the validation errors listed in entity.validation.errors, then retry with dry_run=true to confirm.`,
                  ],
          });
        }

        // --- Live build: bail if validation failed ---
        if (validationErrors.length > 0) {
          return errorResult({
            code: "OUTLINE_VALIDATION",
            message: `Cannot build: ${validationErrors.length} validation error(s) in parsed outline.`,
            suggestion:
              "Run with dry_run=true first to see the full validation report, then fix the markdown and retry.",
            retriable: true,
            details: { validation_errors: validationErrors },
          });
        }

        // --- Idempotency cache check ---
        const cached = getIdempotent(client_request_id);
        if (cached) return cached;

        // --- Build ---
        const buildResult = await buildFromOutline(client, outline, {
          mark_flow_completed,
          publish,
          rollback_on_error,
        });

        if (!buildResult.ok) {
          return errorResult(buildResult.error as Parameters<typeof errorResult>[0]);
        }

        const { result } = buildResult;
        const courseId = String(
          (result.course as Record<string, unknown> | null)?.id ?? "",
        );
        const stats = result.stats as {
          modules: number;
          lessons: number;
          flow_steps: number;
          connections: number;
        };

        const toolResult: ToolResult = entityResult({
          entity: result,
          summary:
            `Imported markdown as course '${outline.title}' (id=${courseId}): ${stats.modules} modules, ${stats.lessons} lessons, ${stats.flow_steps} steps, ${stats.connections} connections` +
            (mark_flow_completed ? ", all flow_completed=true" : "") +
            (result.published ? ", status=published" : "") +
            ".",
          url: editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", courseId),
          resource_uri: `flowlearn://course/${courseId}`,
          next_actions: (result.published as boolean)
            ? [
                `Course is live at ${editorUrl(cfg().baseUrl, cfg().tenantSlug, "course", courseId)}`,
              ]
            : [
                `flowlearn_course_lint with course_id="${courseId}" to verify publish-readiness`,
                `flowlearn_course_update with course_id="${courseId}" + status="published" to publish`,
                `flowlearn_flow_step_upload_image to re-attach any images (markdown image references were ignored during import)`,
              ],
        });

        setIdempotent(client_request_id, toolResult);
        return toolResult;
      },
    },
  ];
}
