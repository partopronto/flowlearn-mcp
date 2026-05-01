import { z } from "zod";
import type { FlowlearnClient } from "../client.js";
import { entityResult, errorResult, type ToolDef } from "./common.js";

/**
 * Tier 2.5 — Quality & Lint: five deterministic read-only audit tools.
 *
 *  1. flowlearn_course_audit_objectives   — lesson ↔ objective coverage (Jaccard)
 *  2. flowlearn_course_estimate_duration  — estimated reading/watch time
 *  3. flowlearn_course_dead_link_scan     — HTTP HEAD scan of outbound URLs
 *  4. flowlearn_course_readability_check  — Flesch-Kincaid grade vs declared difficulty
 *  5. flowlearn_course_audit_bloom        — Bloom's taxonomy verb distribution
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type Severity = "error" | "warning" | "info";

type Issue = {
  severity: Severity;
  code: string;
  message: string;
  fix_hint: string;
  location: Record<string, string>;
};

const IssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
  message: z.string(),
  fix_hint: z.string(),
  location: z.record(z.string()),
});

// ---------------------------------------------------------------------------
// Helpers — tree-walk (shared across multiple audit tools)
// ---------------------------------------------------------------------------

type StepRecord = Record<string, unknown>;
type LessonRecord = Record<string, unknown> & { _steps?: StepRecord[] };
type ModuleRecord = Record<string, unknown> & { _lessons?: LessonRecord[] };

/**
 * Fetch the full course tree (modules → lessons → steps). Each module entry
 * gets `_lessons`, each lesson entry gets `_steps` — keyed with leading
 * underscore to avoid colliding with upstream field names.
 */
async function fetchCourseTree(
  client: FlowlearnClient,
  course_id: string,
): Promise<{
  course: Record<string, unknown>;
  modules: ModuleRecord[];
}> {
  const courseResp = await client.request<{ course?: Record<string, unknown> }>(
    `/api/courses/${course_id}`,
  );
  const course = (courseResp.course ?? courseResp) as Record<string, unknown>;

  const modulesArr: ModuleRecord[] =
    (course.modules as ModuleRecord[] | undefined) ??
    (await client
      .request<{ modules?: unknown[] }>(`/api/courses/${course_id}/modules`)
      .then(
        (d) =>
          (Array.isArray(d) ? d : ((d as { modules?: unknown[] }).modules ?? [])) as ModuleRecord[],
      )) ??
    [];

  for (const m of modulesArr) {
    const moduleId = String(m.id);
    const lessonsResp = await client.request<unknown>(`/api/modules/${moduleId}/lessons`);
    const lessons = (
      Array.isArray(lessonsResp)
        ? lessonsResp
        : ((lessonsResp as { lessons?: unknown[] }).lessons ?? [])
    ) as LessonRecord[];

    for (const l of lessons) {
      const lessonId = String(l.id);
      const stepsResp = await client.request<unknown>(`/api/lessons/${lessonId}/flow-steps`);
      const steps = (
        Array.isArray(stepsResp)
          ? stepsResp
          : ((stepsResp as { flow_steps?: unknown[] }).flow_steps ?? [])
      ) as StepRecord[];
      l._steps = steps;
    }

    m._lessons = lessons;
  }

  return { course, modules: modulesArr };
}

// ---------------------------------------------------------------------------
// Helper — text extraction
// ---------------------------------------------------------------------------

function stepText(step: StepRecord): string {
  const parts: string[] = [];
  if (typeof step.content === "string") parts.push(step.content);
  if (typeof step.description === "string") parts.push(step.description);
  if (typeof step.title === "string") parts.push(step.title);
  return parts.join(" ");
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// ---------------------------------------------------------------------------
// 1. Objective coverage (Jaccard similarity)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "for", "in", "on", "with", "and", "or",
  "is", "are", "be", "by", "at", "it", "as", "was", "this", "that", "from",
  "not", "but", "have", "has", "had", "do", "does", "did", "will", "would",
  "can", "could", "should", "may", "might", "shall", "been", "being",
  "their", "they", "you", "your", "we", "our", "its", "also",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const JACCARD_THRESHOLD = 0.2;

const ObjectivesEnvelope = z.object({
  entity: z.object({
    course_id: z.string(),
    modules: z.array(
      z.object({
        module_id: z.string(),
        module_title: z.string(),
        unmapped_lessons: z.array(z.string()),
        unsupported_objectives: z.array(z.string()),
        coverage_ratio: z.number(),
      }),
    ),
    issues: z.array(IssueSchema),
  }),
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// 2. Duration estimation
// ---------------------------------------------------------------------------

const DurationEnvelope = z.object({
  entity: z.object({
    course_id: z.string(),
    course_minutes: z.number(),
    modules: z.array(
      z.object({
        title: z.string(),
        minutes: z.number(),
        lessons: z.array(
          z.object({
            title: z.string(),
            minutes: z.number(),
            steps_count: z.number().int(),
            words: z.number().int(),
          }),
        ),
      }),
    ),
    assumptions: z.array(z.string()),
  }),
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
});

const WPM = 200;

function estimateStepMinutes(step: StepRecord): { minutes: number; words: number } {
  const text = [step.content, step.description, step.title]
    .filter((v) => typeof v === "string")
    .join(" ");
  const words = countWords(text);
  let minutes = words / WPM;
  if (step.image_url) minutes += 0.5;
  if (step.step_type === "quiz") minutes += 0.5;
  if (step.video_url) {
    // video_duration_min is unlikely on the entity; default 1.0 min.
    const videoDur =
      typeof step.video_duration_min === "number" ? step.video_duration_min : 1.0;
    minutes += videoDur;
  }
  return { minutes, words };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// 3. Dead link scan
// ---------------------------------------------------------------------------

const DeadLinkEnvelope = z.object({
  entity: z.object({
    course_id: z.string(),
    scanned: z.number().int(),
    truncated: z.boolean(),
    ok: z.number().int(),
    broken: z.number().int(),
    unreachable: z.number().int(),
    issues: z.array(IssueSchema),
  }),
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
});

const URL_RE = /(https?:\/\/[^\s)"'>[\]]+)/g;
const TRAILING_PUNCT = /[.,)}\]>'"!?]+$/;

function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  return matches.map((u) => u.replace(TRAILING_PUNCT, ""));
}

type LinkResult =
  | { status: "ok"; code: number }
  | { status: "broken"; code: number }
  | { status: "server_error"; code: number }
  | { status: "unreachable"; error: string };

async function checkUrl(url: string): Promise<LinkResult> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
    });
    if (res.status >= 200 && res.status < 400) return { status: "ok", code: res.status };
    if (res.status >= 400 && res.status < 500) return { status: "broken", code: res.status };
    return { status: "server_error", code: res.status };
  } catch (e) {
    return { status: "unreachable", error: String(e) };
  }
}

/** Run `tasks` with at most `concurrency` in-flight at a time. */
async function pooledMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// 4. Readability check (Flesch-Kincaid)
// ---------------------------------------------------------------------------

const ReadabilityEnvelope = z.object({
  entity: z.object({
    course_id: z.string(),
    difficulty: z.string().nullable(),
    target_grade_min: z.number().nullable(),
    target_grade_max: z.number().nullable(),
    issues: z.array(IssueSchema),
  }),
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
});

/** Count vowel groups in a word as a syllable approximation. */
export function countSyllables(word: string): number {
  const lower = word.toLowerCase().replace(/[^a-z]/g, "");
  if (lower.length === 0) return 0;
  // Count vowel groups
  const groups = lower.match(/[aeiouy]+/g) ?? [];
  let count = groups.length;
  // Trailing silent 'e' (unless only vowel group)
  if (lower.endsWith("e") && count > 1) count--;
  return Math.max(1, count);
}

function fleschKincaidGrade(text: string): number | null {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const wordCount = words.length;
  const sentenceCount = sentences.length;
  if (wordCount < 10 || sentenceCount === 0) return null; // too short to be reliable

  const syllableCount = words.reduce((sum, w) => sum + countSyllables(w), 0);

  const grade =
    0.39 * (wordCount / sentenceCount) + 11.8 * (syllableCount / wordCount) - 15.59;
  return round1(grade);
}

type DifficultyTarget = { min: number | null; max: number | null };

function difficultyTarget(difficulty: string | null | undefined): DifficultyTarget {
  switch (difficulty) {
    case "beginner":
      return { min: null, max: 8 };
    case "intermediate":
      return { min: 8, max: 12 };
    case "advanced":
      return { min: 12, max: null };
    default:
      return { min: null, max: null };
  }
}

// ---------------------------------------------------------------------------
// 5. Bloom's taxonomy
// ---------------------------------------------------------------------------

const BLOOM_VERBS: Record<string, string[]> = {
  remember: [
    "define", "describe", "identify", "label", "list", "name", "recall",
    "recognize", "repeat", "state",
  ],
  understand: [
    "classify", "compare", "explain", "illustrate", "interpret", "paraphrase",
    "summarize", "translate",
  ],
  apply: ["apply", "calculate", "demonstrate", "execute", "implement", "solve", "use"],
  analyze: [
    "analyze", "contrast", "deconstruct", "differentiate", "examine", "organize",
  ],
  evaluate: ["appraise", "argue", "critique", "defend", "evaluate", "judge", "justify", "rate"],
  create: [
    "assemble", "compose", "construct", "design", "develop", "formulate",
    "generate", "plan", "produce",
  ],
};

// Build a reverse lookup: verb → category
const VERB_TO_BLOOM = new Map<string, string>();
for (const [category, verbs] of Object.entries(BLOOM_VERBS)) {
  for (const v of verbs) {
    VERB_TO_BLOOM.set(v, category);
  }
}

const BloomEnvelope = z.object({
  entity: z.object({
    course_id: z.string(),
    distribution: z.record(
      z.object({ count: z.number().int(), percent: z.number() }),
    ),
    total_verbs_matched: z.number().int(),
    total_verbs_unmatched: z.number().int(),
    issues: z.array(IssueSchema),
  }),
  summary: z.string(),
  next_actions: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildCourseAuditTools(client: FlowlearnClient): ToolDef[] {
  return [

    // ------------------------------------------------------------------
    // 1. Objective coverage
    // ------------------------------------------------------------------
    {
      name: "flowlearn_course_audit_objectives",
      description:
        "READ-ONLY audit that checks whether each lesson maps to at least one of its module's stated learning objectives. Uses Jaccard similarity (≥0.2 threshold) on tokenized lesson titles/descriptions vs objective text.\n\n" +
        "When to use: after building a course — to ensure every lesson has clear pedagogical purpose and every objective is supported by at least one lesson.\n" +
        "When NOT to use: as a substitute for manual curriculum review; Jaccard similarity is a heuristic, not an authoritative judgment.\n\n" +
        'Example call: { "course_id": "crs_abc" }\n\n' +
        "Issue codes: LESSON_NOT_MAPPED_TO_OBJECTIVE, OBJECTIVE_NOT_SUPPORTED_BY_LESSON, MODULE_NO_OBJECTIVES.\n" +
        "Errors: FLOWLEARN_API_404 if course_id invalid.",
      inputSchema: {
        course_id: z.string().min(1),
      },
      outputSchema: ObjectivesEnvelope,
      annotations: {
        title: "Audit objective coverage",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id }) => {
        const { modules } = await fetchCourseTree(client, String(course_id));
        const issues: Issue[] = [];

        const moduleResults: Array<{
          module_id: string;
          module_title: string;
          unmapped_lessons: string[];
          unsupported_objectives: string[];
          coverage_ratio: number;
        }> = [];

        for (const m of modules) {
          const moduleId = String(m.id);
          const moduleTitle = String(m.title ?? "(untitled module)");
          const lessons = m._lessons ?? [];

          // Objectives live in module.content.objectives
          const objectives: string[] =
            (m.content as { objectives?: string[] } | null | undefined)?.objectives ??
            [];

          if (objectives.length === 0) {
            issues.push({
              severity: "warning",
              code: "MODULE_NO_OBJECTIVES",
              message: `Module '${moduleTitle}' has no objectives defined — coverage cannot be measured.`,
              fix_hint:
                "Call flowlearn_module_update with content.objectives = [\"...\"] to add objectives.",
              location: { module_id: moduleId },
            });
            moduleResults.push({
              module_id: moduleId,
              module_title: moduleTitle,
              unmapped_lessons: [],
              unsupported_objectives: [],
              coverage_ratio: 0,
            });
            continue;
          }

          const objTokens = objectives.map(tokenize);

          const unmappedLessons: string[] = [];
          const supportedObjectiveIdxs = new Set<number>();

          for (const l of lessons) {
            const lessonTitle = String(l.title ?? "(untitled lesson)");
            const lessonDesc = String(l.description ?? "");
            const lessonTokens = tokenize(`${lessonTitle} ${lessonDesc}`);

            let maxSim = 0;
            let bestObjIdx = -1;
            for (let i = 0; i < objTokens.length; i++) {
              const sim = jaccard(lessonTokens, objTokens[i]);
              if (sim > maxSim) {
                maxSim = sim;
                bestObjIdx = i;
              }
            }

            if (maxSim >= JACCARD_THRESHOLD && bestObjIdx >= 0) {
              supportedObjectiveIdxs.add(bestObjIdx);
            } else {
              unmappedLessons.push(lessonTitle);
              issues.push({
                severity: "warning",
                code: "LESSON_NOT_MAPPED_TO_OBJECTIVE",
                message: `Lesson '${lessonTitle}' in module '${moduleTitle}' does not clearly map to any objective (max Jaccard=${round1(maxSim)}).`,
                fix_hint:
                  "Rename the lesson to reflect the objective it teaches, or add a matching objective to the module.",
                location: { module_id: moduleId, lesson_title: lessonTitle },
              });
            }
          }

          const unsupportedObjectives: string[] = [];
          for (let i = 0; i < objectives.length; i++) {
            if (!supportedObjectiveIdxs.has(i)) {
              unsupportedObjectives.push(objectives[i]);
              issues.push({
                severity: "warning",
                code: "OBJECTIVE_NOT_SUPPORTED_BY_LESSON",
                message: `Objective '${objectives[i]}' in module '${moduleTitle}' is not supported by any lesson.`,
                fix_hint:
                  "Add a lesson that covers this objective, or remove it from the module's objectives.",
                location: { module_id: moduleId },
              });
            }
          }

          const mappedCount = lessons.length - unmappedLessons.length;
          const coverageRatio = lessons.length > 0 ? round1(mappedCount / lessons.length) : 0;

          moduleResults.push({
            module_id: moduleId,
            module_title: moduleTitle,
            unmapped_lessons: unmappedLessons,
            unsupported_objectives: unsupportedObjectives,
            coverage_ratio: coverageRatio,
          });
        }

        const totalWarnings = issues.filter((i) => i.severity === "warning").length;

        return entityResult({
          entity: {
            course_id: String(course_id),
            modules: moduleResults,
            issues,
          },
          summary:
            totalWarnings === 0
              ? "All lessons map to at least one objective and all objectives are supported."
              : `Objective coverage audit found ${totalWarnings} issue(s). See issues[] for details.`,
          next_actions:
            totalWarnings > 0
              ? [
                  "Fix lesson titles/descriptions to match objectives, or update module objectives to reflect actual lesson content.",
                  "Re-run flowlearn_course_audit_objectives after changes.",
                ]
              : ["Course objective coverage looks good — consider running flowlearn_course_lint for structural checks."],
        });
      },
    },

    // ------------------------------------------------------------------
    // 2. Duration estimation
    // ------------------------------------------------------------------
    {
      name: "flowlearn_course_estimate_duration",
      description:
        "READ-ONLY tool that estimates total course reading/watching time. Sums per-step word counts (at 200 wpm), adds 30 s per image, 30 s per quiz step, and 1 min per video step (video_duration_min field used if present, else defaults to 1.0).\n\n" +
        "When to use: to check whether a course is appropriately sized before publishing; to communicate estimated effort to learners.\n" +
        "When NOT to use: as a substitute for user-testing actual time-on-task — the model is a rough heuristic.\n\n" +
        'Example call: { "course_id": "crs_abc" }\n\n' +
        "No issue codes — this is a pure metric tool.\n" +
        "Errors: FLOWLEARN_API_404 if course_id invalid.",
      inputSchema: {
        course_id: z.string().min(1),
      },
      outputSchema: DurationEnvelope,
      annotations: {
        title: "Estimate course duration",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id }) => {
        const { course, modules } = await fetchCourseTree(client, String(course_id));

        type LessonStat = { title: string; minutes: number; steps_count: number; words: number };
        type ModuleStat = { title: string; minutes: number; lessons: LessonStat[] };

        const moduleStats: ModuleStat[] = [];
        let courseTotalMinutes = 0;

        for (const m of modules) {
          const moduleTitle = String(m.title ?? "(untitled module)");
          let moduleMinutes = 0;
          const lessonStats: LessonStat[] = [];

          for (const l of m._lessons ?? []) {
            const lessonTitle = String(l.title ?? "(untitled lesson)");
            let lessonMinutes = 0;
            let lessonWords = 0;
            const steps = l._steps ?? [];

            for (const s of steps) {
              const { minutes, words } = estimateStepMinutes(s);
              lessonMinutes += minutes;
              lessonWords += words;
            }

            lessonStats.push({
              title: lessonTitle,
              minutes: round1(lessonMinutes),
              steps_count: steps.length,
              words: lessonWords,
            });

            moduleMinutes += lessonMinutes;
          }

          moduleStats.push({
            title: moduleTitle,
            minutes: round1(moduleMinutes),
            lessons: lessonStats,
          });

          courseTotalMinutes += moduleMinutes;
        }

        const courseMinutes = round1(courseTotalMinutes);

        return entityResult({
          entity: {
            course_id: String(course_id),
            course_minutes: courseMinutes,
            modules: moduleStats,
            assumptions: [
              "200 words/min reading speed",
              "30 s (0.5 min) per step image",
              "30 s (0.5 min) extra per quiz step for answering",
              "1.0 min default per video step (uses video_duration_min if present on step)",
              "Word count from title + description + content fields of each step",
            ],
          },
          summary: `Estimated course duration: ${courseMinutes} min across ${modules.length} module(s) for '${String(course.title ?? course_id)}'.`,
          next_actions: [
            courseMinutes < 5
              ? "Course is very short (<5 min). Consider adding more content or detail."
              : courseMinutes > 120
                ? "Course exceeds 2 hours. Consider splitting into a series or adding a summary module."
                : "Duration looks reasonable. Use flowlearn_course_lint to check structural readiness.",
          ],
        });
      },
    },

    // ------------------------------------------------------------------
    // 3. Dead link scan
    // ------------------------------------------------------------------
    {
      name: "flowlearn_course_dead_link_scan",
      description:
        "READ-ONLY tool that extracts outbound URLs from all step content/description fields and checks each with an HTTP HEAD request (5-second timeout). Duplicate URLs are deduplicated before checking.\n\n" +
        "When to use: before publishing a course, or when a learner reports a broken link.\n" +
        "When NOT to use: on courses with many URLs behind authentication or WAF that blocks HEAD requests — false positives are possible for server_error results.\n\n" +
        'Example call: { "course_id": "crs_abc" }\n\n' +
        "Input: max_urls (default 200) — URLs above this limit are sampled and truncated=true is set in the response.\n\n" +
        "Issue codes: DEAD_LINK_4XX, DEAD_LINK_5XX, DEAD_LINK_UNREACHABLE.\n" +
        "Errors: FLOWLEARN_API_404 if course_id invalid.",
      inputSchema: {
        course_id: z.string().min(1),
        max_urls: z.number().int().min(1).max(1000).optional(),
      },
      outputSchema: DeadLinkEnvelope,
      annotations: {
        title: "Scan for dead links",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id, max_urls }) => {
        const { modules } = await fetchCourseTree(client, String(course_id));
        const maxUrls = typeof max_urls === "number" ? max_urls : 200;

        // Collect: url → first location found
        const urlLocations = new Map<string, Record<string, string>>();

        for (const m of modules) {
          for (const l of m._lessons ?? []) {
            const lessonId = String(l.id ?? "");
            for (const s of l._steps ?? []) {
              const stepId = String(s.id ?? "");
              const text = [s.content, s.description]
                .filter((v) => typeof v === "string")
                .join(" ");
              for (const url of extractUrls(text)) {
                if (!urlLocations.has(url)) {
                  urlLocations.set(url, {
                    flow_step_id: stepId,
                    lesson_id: lessonId,
                    module_id: String(m.id ?? ""),
                  });
                }
              }
            }
          }
        }

        let allUrls = Array.from(urlLocations.keys());
        const truncated = allUrls.length > maxUrls;
        if (truncated) {
          allUrls = allUrls.slice(0, maxUrls);
        }

        const results = await pooledMap(allUrls, checkUrl, 5);

        const issues: Issue[] = [];
        let okCount = 0;
        let brokenCount = 0;
        let unreachableCount = 0;

        for (let i = 0; i < allUrls.length; i++) {
          const url = allUrls[i];
          const result = results[i];
          const location = urlLocations.get(url) ?? {};

          switch (result.status) {
            case "ok":
              okCount++;
              break;
            case "broken":
              brokenCount++;
              issues.push({
                severity: "error",
                code: "DEAD_LINK_4XX",
                message: `URL returned HTTP ${result.code}: ${url}`,
                fix_hint: "Remove or replace the link in the step content.",
                location: { ...location, url },
              });
              break;
            case "server_error":
              issues.push({
                severity: "warning",
                code: "DEAD_LINK_5XX",
                message: `URL returned HTTP ${result.code} (server error, may be transient): ${url}`,
                fix_hint: "Verify the URL manually — server errors may be temporary.",
                location: { ...location, url },
              });
              unreachableCount++;
              break;
            case "unreachable":
              unreachableCount++;
              issues.push({
                severity: "warning",
                code: "DEAD_LINK_UNREACHABLE",
                message: `URL unreachable (timeout or network error): ${url}`,
                fix_hint:
                  "Check the URL manually. Timeout may indicate the server blocks HEAD requests.",
                location: { ...location, url },
              });
              break;
          }
        }

        const scanned = allUrls.length;

        return entityResult({
          entity: {
            course_id: String(course_id),
            scanned,
            truncated,
            ok: okCount,
            broken: brokenCount,
            unreachable: unreachableCount,
            issues,
          },
          summary:
            `Scanned ${scanned} URL(s)${truncated ? ` (truncated at ${maxUrls})` : ""}. OK: ${okCount}, Broken (4xx): ${brokenCount}, Unreachable/5xx: ${unreachableCount}.`,
          next_actions:
            brokenCount > 0
              ? [
                  `Fix the ${brokenCount} broken link(s) in the issues array, then re-run the scan.`,
                ]
              : unreachableCount > 0
                ? ["Verify the unreachable URLs manually — they may be behind auth or block HEAD."]
                : ["All scanned URLs responded with 2xx/3xx — no broken links found."],
        });
      },
    },

    // ------------------------------------------------------------------
    // 4. Readability check (Flesch-Kincaid)
    // ------------------------------------------------------------------
    {
      name: "flowlearn_course_readability_check",
      description:
        "READ-ONLY tool that computes the Flesch-Kincaid Grade Level for each lesson's combined step content and flags lessons that are too hard or too easy for the course's declared difficulty level.\n\n" +
        "Targets: beginner → grade ≤ 8; intermediate → 8–12; advanced → 12+.\n\n" +
        "When to use: to ensure reading level is appropriate for the intended audience; to catch jargon-heavy lessons in a beginner course.\n" +
        "When NOT to use: for courses in non-English languages — the Flesch-Kincaid formula was calibrated for English only.\n\n" +
        'Example call: { "course_id": "crs_abc" }\n\n' +
        "Issue codes: LESSON_TOO_HARD, LESSON_TOO_EASY, COURSE_NO_DIFFICULTY.\n" +
        "Errors: FLOWLEARN_API_404 if course_id invalid.",
      inputSchema: {
        course_id: z.string().min(1),
      },
      outputSchema: ReadabilityEnvelope,
      annotations: {
        title: "Readability check",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id }) => {
        const { course, modules } = await fetchCourseTree(client, String(course_id));
        const issues: Issue[] = [];

        const difficulty = (course.difficulty as string | null | undefined) ?? null;

        if (!difficulty) {
          issues.push({
            severity: "warning",
            code: "COURSE_NO_DIFFICULTY",
            message: "Course has no difficulty set — readability targets cannot be applied.",
            fix_hint:
              "Call flowlearn_course_update with difficulty='beginner'|'intermediate'|'advanced'.",
            location: { course_id: String(course_id) },
          });
          return entityResult({
            entity: {
              course_id: String(course_id),
              difficulty: null,
              target_grade_min: null,
              target_grade_max: null,
              issues,
            },
            summary: "Cannot run readability check — course difficulty is not set.",
            next_actions: [
              "Set course difficulty via flowlearn_course_update, then re-run this check.",
            ],
          });
        }

        const target = difficultyTarget(difficulty);

        for (const m of modules) {
          const moduleId = String(m.id);
          for (const l of m._lessons ?? []) {
            const lessonId = String(l.id ?? "");
            const lessonTitle = String(l.title ?? "(untitled lesson)");
            const steps = l._steps ?? [];

            const combinedText = steps
              .map((s) =>
                [s.content, s.description]
                  .filter((v) => typeof v === "string")
                  .join(" "),
              )
              .join(" ");

            const grade = fleschKincaidGrade(combinedText);
            if (grade === null) continue; // insufficient text

            const tooHard = target.max !== null && grade > target.max;
            const tooEasy = target.min !== null && grade < target.min;

            if (tooHard) {
              issues.push({
                severity: "warning",
                code: "LESSON_TOO_HARD",
                message: `Lesson '${lessonTitle}' has FK grade ${grade} (target ≤ ${target.max} for ${difficulty}).`,
                fix_hint:
                  "Simplify sentence structure and replace technical jargon with plain language.",
                location: {
                  lesson_id: lessonId,
                  module_id: moduleId,
                  grade: String(grade),
                  target: `max ${target.max}`,
                },
              });
            } else if (tooEasy) {
              issues.push({
                severity: "info",
                code: "LESSON_TOO_EASY",
                message: `Lesson '${lessonTitle}' has FK grade ${grade} (target ≥ ${target.min} for ${difficulty}).`,
                fix_hint:
                  "Consider adding more nuanced explanations or domain-specific terminology appropriate for the audience.",
                location: {
                  lesson_id: lessonId,
                  module_id: moduleId,
                  grade: String(grade),
                  target: `min ${target.min}`,
                },
              });
            }
          }
        }

        const hardCount = issues.filter((i) => i.code === "LESSON_TOO_HARD").length;
        const easyCount = issues.filter((i) => i.code === "LESSON_TOO_EASY").length;

        return entityResult({
          entity: {
            course_id: String(course_id),
            difficulty,
            target_grade_min: target.min,
            target_grade_max: target.max,
            issues,
          },
          summary:
            hardCount + easyCount === 0
              ? `All lessons are within the ${difficulty} readability target (FK grade ${target.min ?? "—"}–${target.max ?? "—"}).`
              : `Readability check: ${hardCount} lesson(s) too hard, ${easyCount} lesson(s) too easy for ${difficulty} target.`,
          next_actions:
            hardCount > 0
              ? [
                  "Revise the flagged lessons to use shorter sentences and simpler vocabulary.",
                  "Re-run flowlearn_course_readability_check after edits.",
                ]
              : easyCount > 0
                ? ["Consider enriching content for the flagged lessons to match the declared audience."]
                : ["Readability is on target — run flowlearn_course_lint for structural checks."],
        });
      },
    },

    // ------------------------------------------------------------------
    // 5. Bloom's taxonomy coverage
    // ------------------------------------------------------------------
    {
      name: "flowlearn_course_audit_bloom",
      description:
        "READ-ONLY tool that scans objectives and step titles for Bloom's taxonomy verbs and reports their distribution across six cognitive levels (remember, understand, apply, analyze, evaluate, create). Flags gaps and shallow coverage.\n\n" +
        "When to use: when building a course that targets higher-order thinking (apply, analyze, evaluate, create) — to ensure the content goes beyond recall.\n" +
        "When NOT to use: as a substitute for instructional design review; the verb-matching is lexical and does not capture context.\n\n" +
        'Example call: { "course_id": "crs_abc" }\n\n' +
        "Issue codes: BLOOM_GAP_REMEMBER, BLOOM_GAP_UNDERSTAND, BLOOM_GAP_APPLY, BLOOM_GAP_ANALYZE, BLOOM_GAP_EVALUATE, BLOOM_GAP_CREATE, BLOOM_SHALLOW.\n" +
        "Errors: FLOWLEARN_API_404 if course_id invalid.",
      inputSchema: {
        course_id: z.string().min(1),
      },
      outputSchema: BloomEnvelope,
      annotations: {
        title: "Audit Bloom's taxonomy coverage",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async ({ course_id }) => {
        const { modules } = await fetchCourseTree(client, String(course_id));
        const issues: Issue[] = [];

        // Counts per category
        const counts: Record<string, number> = {
          remember: 0,
          understand: 0,
          apply: 0,
          analyze: 0,
          evaluate: 0,
          create: 0,
        };
        let totalMatched = 0;
        let totalUnmatched = 0;

        // Collect all tokens from objectives + step titles
        const allTokens: string[] = [];

        for (const m of modules) {
          // Objectives
          const objectives: string[] =
            (m.content as { objectives?: string[] } | null | undefined)?.objectives ?? [];
          for (const obj of objectives) {
            allTokens.push(
              ...obj
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter((w) => w.length > 0),
            );
          }

          // Step titles
          for (const l of m._lessons ?? []) {
            for (const s of l._steps ?? []) {
              if (typeof s.title === "string") {
                allTokens.push(
                  ...s.title
                    .toLowerCase()
                    .replace(/[^a-z0-9\s]/g, " ")
                    .split(/\s+/)
                    .filter((w) => w.length > 0),
                );
              }
            }
          }
        }

        for (const token of allTokens) {
          const category = VERB_TO_BLOOM.get(token);
          if (category) {
            counts[category]++;
            totalMatched++;
          } else {
            totalUnmatched++;
          }
        }

        // Build distribution
        type DistEntry = { count: number; percent: number };
        const distribution: Record<string, DistEntry> = {};
        for (const [cat, cnt] of Object.entries(counts)) {
          distribution[cat] = {
            count: cnt,
            percent: totalMatched > 0 ? round1((cnt / totalMatched) * 100) : 0,
          };
        }

        // Gap detection
        for (const cat of Object.keys(counts)) {
          if (counts[cat] === 0) {
            issues.push({
              severity: "warning",
              code: `BLOOM_GAP_${cat.toUpperCase()}`,
              message: `No verbs matched to the '${cat}' Bloom level in objectives or step titles.`,
              fix_hint: `Add objectives or step titles that start with verbs like: ${(BLOOM_VERBS[cat] ?? []).slice(0, 5).join(", ")}.`,
              location: { course_id: String(course_id) },
            });
          }
        }

        // Shallow detection: ≥80% of matched verbs in remember+understand
        const lowOrderCount = counts.remember + counts.understand;
        if (totalMatched > 0 && lowOrderCount / totalMatched >= 0.8) {
          issues.push({
            severity: "warning",
            code: "BLOOM_SHALLOW",
            message: `${round1((lowOrderCount / totalMatched) * 100)}% of matched verbs are in remember/understand (≥80%). Course may not develop higher-order thinking.`,
            fix_hint:
              "Add objectives or step titles that use apply, analyze, evaluate, or create verbs.",
            location: { course_id: String(course_id) },
          });
        }

        const issueCount = issues.length;

        return entityResult({
          entity: {
            course_id: String(course_id),
            distribution,
            total_verbs_matched: totalMatched,
            total_verbs_unmatched: totalUnmatched,
            issues,
          },
          summary:
            issueCount === 0
              ? `Bloom's taxonomy audit passed: ${totalMatched} verb(s) matched across all 6 levels.`
              : `Bloom's taxonomy audit: ${issueCount} issue(s). Matched ${totalMatched} verb(s) across objectives and step titles.`,
          next_actions:
            issueCount > 0
              ? [
                  "Update module objectives and step titles to include verbs at missing Bloom levels.",
                  "Re-run flowlearn_course_audit_bloom after changes.",
                ]
              : ["Bloom coverage looks healthy — all six cognitive levels are represented."],
        });
      },
    },
  ];
}
