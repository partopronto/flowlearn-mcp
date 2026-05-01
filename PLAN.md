# Master plan — making `flowlearn-mcp` the best MCP on the internet

Distilled from research on the MCP spec, top servers in the wild (Linear, Stripe, Notion, GitHub, Sentry, Supabase, Figma), Anthropic's "writing tools for agents" guidance, and instructional-design + headless-CMS literature.

The plan is layered. Tier 0 is fix-the-foundations (cheap, mandatory). Tiers 1-2 are where most servers stop. Tiers 3-5 are where you become the reference implementation.

---

## Tier 0 — Foundations (do these first, before adding any feature)

These showed up in every research thread. They're the difference between "works" and "agents love it."

- **Rename all 29 tools to `flowlearn_{resource}_{verb}` snake_case.** Namespace prevents collisions; resource-first ordering measurably improves selection. (`flowStep_create` → `flowlearn_flow_step_create`.)
- **Audit tool count.** Selection accuracy collapses past ~25 tools. Either trim or split into toggleable sub-toolsets (Supabase pattern).
- **Rewrite every tool description with a 5-part template:** one-liner + when-to-use + when-NOT-to-use + 1 inline JSON example + error modes. Top of every description: state the `tenant → course → module → lesson → flow_step` hierarchy.
- **Set MCP `annotations` on every tool** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Lets clients auto-approve safe ops and gate destructive ones.
- **Add `outputSchema` to every tool** — JSON Schema for return values. Enables strict validation and gives agents type-awareness without trial-and-error.
- **Structured errors:** `{ isError: true, code, message, suggestion: "call X to recover", retriable: bool }`. Never throw protocol errors for tool failures.
- **Always return `{ entity, summary, url, next_actions[] }`** on every tool. The `next_actions` hint is the single biggest lever for agent autonomy.
- **Paginate every `*_list`** with `limit`, `cursor`, default `limit=50`. Add `response_format: "concise" | "detailed"`.
- **Idempotency key on every create.** Lets agents safely retry after a network blip.
- **`dry_run: bool` on every destructive tool** (`course_delete`, `connection_clear`, `connection_replaceAll`).
- **Ship `flowlearn_help(topic?)`** — returns the data model, hierarchy, and worked example. Replaces a system prompt.
- **Beef up `setup_status`** to return active tenant + course summaries + suggested next action — make it the canonical entry point.

## Tier 1 — Protocol features beyond tools (most servers leave these on the table)

- **Resources** — expose `flowlearn://course/{id}`, `flowlearn://lesson/{id}`, `flowlearn://docs/{topic}` as readable resources. Course tree as one fetchable doc. Subscribe-capable so clients see edits live.
- **Resource templates with completion** — autocomplete for course IDs / module IDs as the user types.
- **Prompts → slash commands** — ship `/flowlearn:scaffold-course-from-outline`, `/flowlearn:audit-course-quality`, `/flowlearn:import-from-markdown`, `/flowlearn:translate-course`. Pre-chains your tools.
- **Progress notifications** — stream "generating module 2/5..." for long ops.
- **Tasks (long-running)** — return a task ID + poll for course bulk-imports and AI-assisted generation.
- **Elicitation** — server asks the user for missing fields ("which tenant?") instead of failing.
- **Sampling** — for premium features, ask the *client's* model to do the LLM work, server pays nothing.
- **Logging capability** — structured `info`/`notice`/`error` levels client can filter.
- **Embedded resource links in tool results** — `course_create` returns `{type: "resource_link", uri: "flowlearn://course/123"}` so the agent can dereference later.
- **`_meta` for tracing** — traceparent IDs, user locale, session correlation.
- **Icons + MIME types + server metadata** — polish that makes the `/mcp` UI look first-party.

## Tier 2 — Authoring superpowers (the real differentiators)

These are tools no flowlearn competitor has, and they make agents 5-10× faster.

**Composite / atomic operations:**
- `course.outline_apply(tree)` — create entire course (modules + lessons + flow steps) in ONE call.
- `course.outline_diff(tree)` — preview structural changes before applying.
- `course.outline_apply_diff(diff_id)` — atomic apply of previously-previewed diff.
- `course.transaction([...mutations])` — all-or-nothing batch with rollback.
- `flow_step.bulk_create([])` — array of steps in one call. Eliminates N+1.
- `connection.graph_replace(graph)` — redraw branching logic atomically.
- `flow_step.move(from, to)` — preserve connections across hierarchy moves.
- `course.duplicate(id)` — deep-copy fork. Foundation for templates and A/B.

**Drafts & versioning:**
- `course.draft_branch` — copy-on-write environment (Contentful pattern). Edit aggressively, merge later.
- `course.publish` / `course.unpublish` — separate authoring from release.
- `course.snapshot` / `course.restore` / `course.diff_versions` — versioned history with restore.
- **Soft-delete buffer** + `course.restore(deletedId)` — 24h undo on any delete.

## Tier 2.5 — Quality & lint (the "premium" feel)

This is what an instructional designer would do. Letting the agent run these in a loop = courses that don't suck.

- `course.lint` — orphan steps, dangling connections, missing quiz answers, unreachable branches, empty lessons. Categorized + severity.
- `course.publish_blockers` — minimum issues blocking publish right now.
- `course.audit_bloom_coverage` — Bloom's-taxonomy distribution per lesson.
- `course.readability_check` — Flesch-Kincaid vs declared audience.
- `course.prerequisite_check` — terminology used before introduced.
- `course.estimate_duration` — minutes per lesson from word/image/video count.
- `course.objectives_alignment` — every lesson maps to a stated objective.
- `course.dead_link_scan` — outbound URL crawl.
- `lesson.suggest_retrieval_practice` — gaps where spaced repetition would help.
- `flow_step.estimate_cognitive_load` — Mayer's multimedia principles violations.

## Tier 3 — Templates, import/export, content portability

- `course.export_markdown` / `course.import_markdown` — round-trip via flat files for human collaboration.
- `course.import_from_url` — scrape an article/PDF into a course skeleton.
- `course.import_from_youtube_playlist` — transcripts + chapter markers → draft lessons.
- `course.import_from_notion` / `import_from_gdocs` — heading map.
- `template.list` / `template.instantiate` — curated gallery (5-day challenge, bootcamp, micro-credential).
- `course.export_scorm` / `export_xapi` — LMS portability. Unlocks B2B without leaving flowlearn.

## Tier 3.5 — Pedagogy primitives (course-platform parity)

- First-class quizzes: `quiz.create`, `quizBank.create`, `assessment.rubric_create` (MCQ, multi-select, fill-blank, ordering, matching, open-with-rubric).
- `certificate.template_create` with merge fields.
- `drip.schedule_set` — time-released or progress-released unlocks.
- `prerequisite.set` — declarative learning gates.
- `learningPath.create` — cross-course paths (curricula).
- `cohort.create` / `cohort.schedule_event` — Maven/Coursera parity.
- `discussion.thread_create` — per-lesson discussion.
- `assignment.create` with peer-review.
- `gamification.badge_create` / `points_rule_set`.
- `practice.spaced_repetition_deck` — flashcards from quiz items.

## Tier 4 — i18n, a11y, SEO

- `course.locale_add` + `course.translate` (status-tracked: untranslated / MT / human-reviewed).
- `glossary.create` / `glossary.lock_terms` — protect technical vocab from translation.
- `course.a11y_audit` — WCAG 2.2 AA: alt text, heading order, contrast, captions, link text.
- `flow_step.alt_text_suggest` — agent generates, MCP persists.
- `course.caption_check` — hard publish blocker option.
- `course.seo_audit` — title/meta/slug/structured-data per lesson.
- `course.sitemap_export`.

## Tier 4.5 — Search & content model

- `course.search` — full-text + structured filters (locale, status, tag, audience).
- `flow_step.find_by` — predicate query across whole course (mass refactor).
- `course.bulk_replace` — regex find/replace with dry-run.
- `course.embedding_index` + `flow_step.semantic_search` — find "the lesson where I explained X" without exact match.
- `schema.field_add` — typed custom fields (Contentful-style content modeling).
- `tag.create` / `tag.assign` — hierarchical taxonomy.
- `reference.link` — typed cross-references between entities.
- `assets.bulk_upload` + `assets.dedupe` (hash-based).

## Tier 5 — Collaboration & ops

- **Multi-tenant elegance:** every tool returns active tenant; `flowlearn://tenant/current` resource; toggleable per-role toolsets (author / reviewer / translator / admin).
- **OAuth + scoped tokens** (Stripe pattern): `rk_*` read-only keys, role-restricted tokens, browser-based consent.
- **Hosted remote server** at `mcp.flowlearn.io` — no local install, OAuth + confirmation prompts surfaced.
- `webhook.subscribe` — Slack/Zapier/marketing on publish/update/comment.
- `course.share_link` — tokenized SME review URL.
- `comment.create` / `comment.resolve` — inline collaboration.
- `role.assign` per course.
- `activityLog.list` — audit trail with diffs.
- `lock.acquire` / `lock.release` — optimistic locks once humans + agents co-edit.
- **Observability:** OpenTelemetry spans per tool, `flowlearn_health` self-diagnosis, `rateLimit: {remaining, resetAt}` in every response.

## Tier 5+ — Moonshots (best-on-internet territory)

- **Lesson preview rendering** — `lesson.render_preview` returns a PNG of how learners see a flow step (Playwright pattern). Closes the design-vs-reality loop.
- **Code-execution MCP variant** (per Anthropic's Nov 2025 paper): expose tools as a TS API the agent can compose with code, instead of one-shot calls. Cuts token usage 5-10×.
- **Conversational interview prompt** — `/flowlearn:interview-me-about-my-course` chains elicitation + sampling to build a course from 5 questions.
- **AI-native generation tools that use flowlearn's domain knowledge** (without exposing server-side AI you've explicitly excluded): `lesson.suggest_flow_step_structure(topic)` returns *structural* recommendations — branching shapes, quiz placements — not content.
- **Round-trip "course-as-code"** — full course as a single typed TS file in a git repo, with `course.sync(repo_url)` for GitOps-style course management. Best-in-class for technical creators.

---

## If you only ship 10 things this week

1. Rename to `flowlearn_{resource}_{verb}` snake_case + add namespace.
2. Add `annotations` to every tool.
3. Rewrite descriptions with 5-part template.
4. Add `next_actions` + `url` to every response.
5. Structured errors with recovery suggestions.
6. Paginate all lists.
7. `flowlearn_help` tool.
8. `course.outline_apply` + `course.outline_diff` (single biggest authoring win).
9. `course.lint` + `course.publish_blockers`.
10. Idempotency keys + `dry_run` on destructives.

Items 8 and 9 alone put you past 90% of MCP servers in the wild — they're the move from "thin CRUD wrapper" to "agent-native authoring runtime."

---

## Sources

**MCP protocol & Claude Code:**
- [Model Context Protocol Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Tool Annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
- [MCP Prompts and Resources: The Primitives You're Not Using](https://dev.to/aws-heroes/mcp-prompts-and-resources-the-primitives-youre-not-using-3oo1)

**Tool design for agents:**
- [Writing effective tools for AI agents — Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Effective context engineering for AI agents — Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Code execution with MCP — Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [MCP best practices — anthropics/skills](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/reference/mcp_best_practices.md)
- [MCP Tool Overload](https://dev.to/nebulagg/mcp-tool-overload-why-more-tools-make-your-agent-worse-5a49)

**Top MCP servers studied:**
- [54 Patterns for Building Better MCP Tools — Arcade](https://www.arcade.dev/blog/mcp-tool-patterns)
- [The Linear Team Made a Good MCP — Fiberplane](https://blog.fiberplane.com/blog/mcp-server-analysis-linear/)
- [Stripe MCP](https://docs.stripe.com/mcp)
- [Notion MCP supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
- [Sentry MCP](https://docs.sentry.io/product/sentry-mcp/)
- [Supabase MCP server](https://supabase.com/blog/mcp-server)
- [Figma MCP tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [GitHub official MCP server](https://github.com/github/github-mcp-server)
- [Less is More: 4 design patterns — Klavis](https://www.klavis.ai/blog/less-is-more-mcp-design-patterns-for-ai-agents)
