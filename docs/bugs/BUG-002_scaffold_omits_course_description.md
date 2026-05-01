# BUG-002 — `/flowlearn:scaffold_course` ships courses with no description

**Severity:** P3 (Medium)
**Status:** Open
**Effort:** Small — schema tweak + tool description + prompt example

## Summary

A course built end-to-end via `/flowlearn:scaffold_course` (e.g. "Bollinger Bands Decoded: Statistics for Smarter Trading") renders in the catalog with **"No description provided"**. The agent never set `course.description`.

## Reproduction

1. Invoke `/flowlearn:scaffold_course` with any outline.
2. Let the agent run `flowlearn_course_outline_apply`.
3. Open the catalog page for the new course.
4. Observe: course card reads "No description provided".

## Expected vs Actual

- Expected: every scaffolded course has a 1–2 sentence description visible in the catalog.
- Actual: description is empty / null / absent.

## Root Cause

Three reinforcing signals tell the agent description is optional:

1. **Schema marks it optional.** [src/tools/courseOutline.ts:79](../../src/tools/courseOutline.ts#L79) — `description: z.string().optional()` in `CourseInput`. Validation passes when absent.
2. **The inline tool example omits it.** [src/tools/courseOutline.ts:131](../../src/tools/courseOutline.ts#L131) — example call is `{ "course": { "title": "Spanish Greetings", "topic": "Greetings in Spanish", "modules": [...] } }`. Agents pattern-match on examples.
3. **The prompt's "REQUIRED" tag is plain English, not enforcement.** [src/prompts.ts:169](../../src/prompts.ts#L169) — the prompt uses `"<REQUIRED: 1-2 sentence summary…>"` inside an example JSON. Plain text loses to the schema and example.

The schema is the strongest signal; the example is the second strongest; the prompt's English narration is the weakest. The signals contradict, schema wins, description is dropped.

## Fix Plan

1. Make `description` required in `CourseInput`: `z.string().min(20).describe("1–2 sentence learner-outcome summary; required (catalog renders 'No description provided' otherwise).")`.
2. Update the inline example in the tool description ([courseOutline.ts:131](../../src/tools/courseOutline.ts#L131)) to include a real `description`.
3. Update the scaffold prompt's example JSON ([prompts.ts:165-180](../../src/prompts.ts#L165-L180)) to inline a real description string instead of the placeholder note.
4. Bump version to v0.5.1; note in commit message.

## Notes

- A min length of ~20 characters prevents the agent from satisfying the schema with `"course"` or similar one-word filler.
- The same pattern (description optional in schema while prompt says required) likely affects modules and lessons; this bug only addresses the course-level case the user observed. A follow-up audit should sweep module/lesson description requirements.
