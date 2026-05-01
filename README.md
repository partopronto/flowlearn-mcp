# flowlearn-mcp

MCP server that exposes Flowlearn course-creation actions to Claude Code (terminal) or Claude Desktop. The server signs in to a Flowlearn instance as a tenant admin via Better Auth email/password, caches the session cookie, and proxies tool calls to the public HTTP API.

## What it does

A full MCP surface — 33 tools, 3 resource templates, 4 user-invokable prompts (slash commands), completion, and structured logging. Mirrors what a tenant admin can do in the course-creation UI. Server-side AI is intentionally not exposed (no `createWithAI`, no `improve`, no interview tools); the calling agent generates content and persists it via the dedicated tools.

### Tools (33)

- **Help (1)** — `flowlearn_help`
- **Setup (3)** — `flowlearn_setup_status`, `flowlearn_setup_switch_tenant`, `flowlearn_setup_update`
- **Course (5)** — `flowlearn_course_list`, `flowlearn_course_get`, `flowlearn_course_create`, `flowlearn_course_update`, `flowlearn_course_delete`
- **Course authoring & quality (3)** — `flowlearn_course_outline_apply` (one-shot course creation from a nested outline), `flowlearn_course_lint` (publish-readiness audit), `flowlearn_course_export_outline` (round-trip an existing course back to outline shape — backups, templates, offline edits)
- **Module (5)** — `flowlearn_module_list`, `flowlearn_module_create`, `flowlearn_module_update`, `flowlearn_module_delete`, `flowlearn_module_reorder`
- **Lesson (5)** — `flowlearn_lesson_list`, `flowlearn_lesson_get`, `flowlearn_lesson_create`, `flowlearn_lesson_update`, `flowlearn_lesson_delete`
- **FlowStep (7)** — `flowlearn_flow_step_list`, `flowlearn_flow_step_create`, `flowlearn_flow_step_update`, `flowlearn_flow_step_delete`, `flowlearn_flow_step_reorder`, `flowlearn_flow_step_upload_image`, `flowlearn_flow_step_delete_image`
- **Connection (4)** — `flowlearn_connection_list`, `flowlearn_connection_add`, `flowlearn_connection_replace_all`, `flowlearn_connection_clear`

### Resources

Cheap reads with no tool-call round trip; supports completion on `{id}`/`{topic}`.

- `flowlearn://course/{id}` — full course tree as JSON
- `flowlearn://lesson/{id}` — lesson + flow steps + connections as one JSON
- `flowlearn://docs/{topic}` — `overview` / `publishing` / `enums` / `troubleshooting` (markdown)
- `flowlearn://tenant/current` — active tenant identity + memberships

Mutating tools also embed a `resource_link` content block in their response (`course_create` → `flowlearn://course/<new_id>`) so clients that support it can dereference without a follow-up call.

### Prompts (slash commands)

In Claude Code, type `/` and pick under the `flowlearn` group:

- `scaffold_course` — Build a course from a free-form outline. Args: `outline`, `title?`, `language?`.
- `audit_course` — Lint a course for publish-blockers. Args: `course_id`.
- `import_markdown` — Convert a markdown doc to a course tree. Args: `markdown`, `title_override?`.
- `author_review` — Editorial pass on an existing course (image-references-without-images, quiz-answer leaks, copyrighted/promotional images, weak descriptions, last-lesson navigation loops). Args: `course_id`. Read-only — reports findings; you decide what to fix.

The base URL is hardcoded to `https://flowlearn.io`. Delete and replace-all tools are always exposed but support `dry_run: true` for previews.

### Conventions (every tool)

Adopted in v0.2.0 across all tools:

- **Names** — `flowlearn_<resource>_<verb>` snake_case. Old dotted names (`course.list`) are gone.
- **Annotations** — every tool declares MCP `readOnlyHint` / `destructiveHint` / `idempotentHint` so clients can auto-approve safe ops.
- **Output schemas** — every tool publishes a JSON Schema for its return shape.
- **Mutating tools** return `{ entity, summary, url?, next_actions? }`.
- **List tools** return `{ items, total, next_cursor, has_more, summary }`. All accept `limit`, `cursor`, and `response_format: "concise" | "detailed"`.
- **Create tools** accept an optional `client_request_id` — same key on retry returns the cached result instead of creating a duplicate (per-process, resets on MCP restart).
- **Destructive tools** accept `dry_run: true` to preview the cascade without mutating.
- **Errors** — tool-level failures return structured `{ isError: true, code, message, suggestion?, retriable, details? }` instead of unstructured text.

### Setup tools — what's possible from inside Claude

Initial registration must happen in the terminal (chicken-and-egg: Claude can't call tools on a server it hasn't loaded). Once the MCP is loaded, everything else is callable mid-session:

| Tool | Use it for |
|---|---|
| `flowlearn_setup_status` | Canonical entry point: who am I, what tenant am I on, what other admin tenants do I have, what are my recent courses, what should I do next? Confirms auth still works. |
| `flowlearn_setup_switch_tenant` | "Switch to tenant `acme` for the rest of this session." In-memory only — reverts on Claude restart. Useful for trying something without committing. |
| `flowlearn_setup_update` | "Persistently update my email / password / tenant." Validates the new creds by signing in, then writes them to BOTH `~/.claude.json` (for future Claude sessions) AND the package's `.env`. The current session also picks up the new values immediately — **no Claude restart required**. If validation fails, nothing is written. |

**Security note on `flowlearn_setup_update`:** passing your password as a tool argument means it appears in your Claude Code chat transcript. Acceptable if that's your call; if not, run `python scripts/register.py` in terminal — that uses a hidden prompt and never touches the transcript.

## Setup — one command

```bash
cd flowlearn-mcp
npm install && npm run build       # one-time: build the server
python scripts/register.py         # interactive setup
```

`register.py` walks you through:

1. **Prompts for email + password only.** No need to know your tenant slug.
2. **Signs in to flowlearn.io** and fetches the tenants you're an admin on.
3. **Auto-picks your tenant** if you admin exactly one. Otherwise shows a numbered list and asks.
4. **Writes `.env`** — gitignored, never leaves the package directory.
5. **Registers with Claude Code** at `--scope user` so the MCP is available from any project.
6. **Verifies end-to-end** — spawns the MCP, calls a list endpoint, reports the course count (success) or the exact API error (failure).

Re-run any time to change credentials or switch tenants.

### Non-interactive mode (Claude-callable)

```bash
python scripts/register.py --email you@example.com --password '<pw>' -y
# add --slug acme if you admin multiple tenants
# add --no-verify to skip the post-registration verification call
```

WARNING: passing `--password` exposes it in shell history and the process list. Use the interactive prompt unless you have a specific automation reason.

### Roles

The account must have role `tenant_admin`, `creator`, or `super_admin` on at least one tenant. ("creator" is a Better Auth role name, not a job title.) The script tells you exactly which of your memberships qualify.

### Verify and use

```bash
claude mcp list           # should show 'flowlearn ✓ Connected'
claude mcp get flowlearn  # shows config including env values
```

Inside a Claude Code session, `/mcp` shows the server status and 33 tools. If you change credentials, restart any open session.

### Alternative — manual `claude mcp add`

If you'd rather not use the helper:

```bash
claude mcp add flowlearn --scope user --transport stdio \
  --env FLOWLEARN_EMAIL=admin@acme.com \
  --env FLOWLEARN_PASSWORD=YOUR_PASSWORD \
  --env FLOWLEARN_TENANT_SLUG=acme \
  -- node /absolute/path/to/flowlearn-mcp/dist/index.js
```

### Use with Claude Desktop instead

Add to `claude_desktop_config.json` (Mac: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "flowlearn": {
      "command": "node",
      "args": ["/absolute/path/to/flowlearn-mcp/dist/index.js"],
      "env": {
        "FLOWLEARN_EMAIL": "admin@acme.com",
        "FLOWLEARN_PASSWORD": "...",
        "FLOWLEARN_TENANT_SLUG": "acme"
      }
    }
  }
}
```

Restart Claude Desktop. The 33 tools appear under the `flowlearn` server.

## For Claude / AI agents — how to use this MCP

This section is written for an AI agent (you) that has the `flowlearn` MCP loaded and is being asked to do work in a Flowlearn tenant. Follow these patterns; they encode every gotcha learned during the build.

### Always start with `flowlearn_setup_status`

Before any other tool call in a fresh session, call `flowlearn_setup_status`. It returns the signed-in email, the active tenant slug, the user's full list of admin-role tenants, the 10 most-recent courses on the active tenant, and a `suggested_next_action` string. Use it to:

- Confirm the MCP is healthy (auth works) before doing real work.
- Verify the user is on the tenant they expect — slug names sometimes look right but aren't.
- Skip the `flowlearn_course_list` round-trip when you only need recent course ids.

For a refresher on the data model and conventions, call `flowlearn_help` (topics: `overview`, `publishing`, `enums`, `troubleshooting`).

If `flowlearn_setup_status` fails, do not try to recover by guessing — report the exact error to the user and ask them to run `python scripts/register.py` in their terminal.

### Read before you write

Always call a `*_list` or `*_get` tool to find IDs before you call `*_update` or `*_delete`. Never construct an ID, never reuse an ID from a previous turn without re-listing — the user may have changed things in the UI in between.

Recommended discovery sequence: `flowlearn_course_list` → pick course id → `flowlearn_course_get` (shows modules) → pick module id → `flowlearn_lesson_list` → pick lesson id → `flowlearn_flow_step_list` (shows steps + connections in one call).

### Creating a course in one call — `flowlearn_course_outline_apply`

For greenfield courses, prefer this over the per-entity sequence below. Pass a nested outline and the MCP creates the course, modules, lessons, flow steps, connections, and marks every lesson `flow_completed=true` in a single call. If anything fails partway through, the partial course is rolled back (cascade-deleted) so the tenant stays clean.

```json
{
  "course": {
    "title": "Spanish Greetings",
    "topic": "Greetings in Spanish",
    "language": "en",
    "modules": [
      {
        "title": "Hellos",
        "objectives": ["Say hello at any time of day"],
        "lessons": [
          {
            "title": "Saying Hello",
            "steps": [
              {"title": "Buenos días", "content": "Good morning."},
              {"title": "Hola", "content": "Most common, any time."}
            ]
          }
        ]
      }
    ]
  }
}
```

By default, steps in a lesson are wired in a linear chain with "Next" buttons; supply explicit `connections` per lesson to override (branching, terminal buttons). After it returns, call `flowlearn_course_lint` and then publish via `flowlearn_course_update status: "published"`.

### Linting before publish — `flowlearn_course_lint`

Read-only audit. Returns `publish_ready: boolean`, plus `issues[]` with `severity` (`error`/`warning`), `code`, `message`, and `fix_hint` per problem. Errors are publish-blockers (e.g., `NO_STARTING_STEP`, `DANGLING_CONNECTION`); warnings flag quality issues (`UNREACHABLE_STEP`, `EMPTY_STEP_CONTENT`, `LESSON_NOT_FLOW_COMPLETED`). Designed to be run in a fix-loop: lint → apply top-error fix → re-lint until publish_ready.

### Creating a course manually — canonical sequence

For surgical edits or when you need fine control. This is the only correct order; skipping a step will produce silently broken courses.

1. `flowlearn_course_create` — `{title, topic}`. Both required. Returns `{entity: {id, ...}, summary, url, next_actions}`.
2. `flowlearn_module_create` — once per module. Returns `{entity: {id, order_index, ...}, ...}`.
3. `flowlearn_lesson_create` — once per lesson, scoped to a module.
4. `flowlearn_flow_step_create` — once per step. The **first** step in each lesson MUST have `is_starting_step: true`; the others omit it.
5. `flowlearn_connection_add` — wires steps together. Each connection lives **on the source step**, points `to_step_id` at the target. Use `button_order: 1` for the first button on a step, 2 for the second, etc. `to_step_id: null` for terminal buttons.
6. `flowlearn_lesson_update` — set `flow_completed: true` on every lesson. **Without this, publishing will fail.**
7. `flowlearn_course_update` — `{status: "published"}`. If you get `requiresConfirmation: true` inside `entity`, re-call with `force_publish: true`.

### Editing an existing course

- To rename / change description / change topic: `flowlearn_course_update`.
- To rewrite a step's text: `flowlearn_flow_step_update` with `content`. Note that this tool also accepts a `buttons` array that REPLACES outgoing connections — for clarity, prefer the `flowlearn_connection_*` tools when only touching edges.
- To reorder modules / steps: use the dedicated `*_reorder` tools, passing the FULL list of ids in the new order. Partial lists are not supported.
- To change which step starts a lesson: include all steps in `flowlearn_flow_step_reorder` with the new starting step first; the API auto-sets `is_starting_step` based on order.

### Publishing — what the validator actually checks

Reject conditions (return 400 unless overridden):
- Course has zero modules.
- No lesson anywhere has `flow_completed: true`.
- A module has lesson-completion gaps (later complete, earlier not) while later modules have content.
- A module is empty while later modules have completed content.

Warning conditions (return 200 with `requiresConfirmation: true` — pass `force_publish: true` to override):
- Trailing modules are empty.
- A module is partially complete.

Recipe to reliably publish: every module has ≥1 lesson with `flow_completed: true`, in order, no gaps. Set `flow_completed` with `flowlearn_lesson_update`.

### Common errors and what they mean

| Error code | Likely cause | Fix |
|---|---|---|
| `FLOWLEARN_API_403` | Active tenant slug doesn't grant write access (no admin role) | Call `flowlearn_setup_status`; switch with `flowlearn_setup_switch_tenant` (or `flowlearn_setup_update` to persist) |
| `FLOWLEARN_API_401` | Credentials invalid (after one auto-retry) | Use `flowlearn_setup_update` to fix |
| `FLOWLEARN_API_400` on `flowlearn_course_update status=published` | Validation failed — see "Publishing rules" above | Set `flow_completed` on all lessons, or pass `force_publish: true` if you got `requiresConfirmation` |
| `FLOWLEARN_API_400` on `flowlearn_flow_step_upload_image` | Wrong format or > 10 MB | PNG / JPEG / WebP / GIF only; MCP reduces to WebP server-side |
| `FLOWLEARN_API_404` on a resource | Wrong id, or another agent / human deleted it | Re-list to get a current id |
| `INVALID_ARGUMENTS` | Zod validation failed | Read `details.issues` for path-level violations |
| `INVALID_TENANT` / `NOT_ADMIN` | Slug not in your memberships, or role insufficient | Use the slugs in `details.available_slugs` |

### Anti-patterns — don't do these

- **Don't try to call `course.createWithAI`, `course.improve`, `module.improve`, `interview.questions`, or `interview.validate`.** They don't exist by design — server-side AI is intentionally not exposed. You generate content yourself, then persist it via the dedicated tools.
- **Don't hand-craft IDs.** They're UUIDs returned by create calls. Always store and reuse the returned id from `entity.id`.
- **Don't call `flowlearn_course_delete` without confirming with the user first** — it cascades to everything underneath (modules, lessons, steps, connections, uploaded images). Same for the other `*_delete` tools. Use `dry_run: true` to preview first.
- **Don't pass `goal` to `flowlearn_course_create`.** The schema does not include it. (Historical reason: server-side that field triggered AI auto-generation, which we don't want.)
- **Don't forget `is_starting_step: true` on the first step of each lesson.** The lesson will render but the learner will hit a dead end.
- **Don't use the old dotted tool names** (`course.list`, `flowStep.create`, etc.). They were removed in v0.2.0 and now return `UNKNOWN_TOOL`.

### When to use the setup tools

| Situation | Tool | Why |
|---|---|---|
| Fresh session, first action | `flowlearn_setup_status` | Confirm where you are, see recent courses, get a suggested next action |
| User has multiple tenants and wants to do work on a specific one for one task | `flowlearn_setup_switch_tenant` | Session-only switch, reverts on Claude restart |
| User says "from now on, default to tenant X" or "change my password" | `flowlearn_setup_update` | Persists to `~/.claude.json` AND `.env`; current session also picks up immediately |
| User says "what are my Flowlearn tenants?" | `flowlearn_setup_status` (read `all_admin_tenants`) | One call, no extra round trip |

## Example workflow — building a small course

A creator types this in Claude Code:

> "Make a course called 'Beginner Spanish for Travelers' with three modules: Greetings, Ordering Food, Asking Directions. For Greetings, add one lesson 'Hola and Hello' with four steps: morning greeting, afternoon, evening, then a quiz."

The agent's call sequence (the agent generates the actual Spanish content; the MCP only persists):

| # | Tool | Args (abridged) | Returns |
|---|---|---|---|
| 1 | `flowlearn_course_create` | `{ title: "Beginner Spanish for Travelers", topic: "Spanish for travel" }` | `entity.id = c1` |
| 2 | `flowlearn_module_create` | `{ course_id: c1, title: "Greetings" }` ×3 | `m1`, `m2`, `m3` |
| 3 | `flowlearn_lesson_create` | `{ module_id: m1, title: "Hola and Hello" }` | `l1` |
| 4 | `flowlearn_flow_step_create` | `{ lesson_id: l1, title: "Morning", content: "Buenos días means…", step_type: "message", is_starting_step: true }` | `s1` |
| 5 | `flowlearn_flow_step_create` ×2 | `{ lesson_id: l1, title: "Afternoon" / "Evening", step_type: "message" }` | `s2`, `s3` |
| 6 | `flowlearn_flow_step_create` | `{ lesson_id: l1, title: "Quick check", step_type: "quiz" }` | `s4` |
| 7 | `flowlearn_connection_add` | `{ flow_step_id: s1, to_step_id: s2, button_text: "Next", button_order: 1 }` ×3 | wires `s1→s2→s3→s4` |
| 8 | `flowlearn_lesson_update` | `{ lesson_id: l1, flow_completed: true }` | required for publish |
| 9 | `flowlearn_course_update` | `{ course_id: c1, status: "published" }` | live |

**Where do IDs come from?** Either from `entity.id` of the previous create call, or from `flowlearn_course_list` / `flowlearn_module_list` / `flowlearn_lesson_list` / `flowlearn_flow_step_list` when working against an existing course.

## Reference — enum values and JSON shapes

Pulled from the Flowlearn codebase, not invented. Also available at runtime via `flowlearn_help { topic: "enums" }`.

### `flow_step.step_type`
`"message" | "quiz" | "exercise"` — enforced by a DB CHECK constraint. Defaults to `"message"` server-side.

### `connection.button_action`
`"next" | "help" | "skip" | "custom" | "branch"` — no DB constraint, but these are the values the renderer and types understand. Defaults to `"next"` server-side.

### `module.content` shape
```ts
{ objectives: string[] }
```
Only field the rest of the codebase reads.

### `lesson.content` shape
```ts
{ steps: any[] }
```
The live flow lives in `flow_steps` + `flow_connections` (managed via `flowlearn_flow_step_*` and `flowlearn_connection_*` tools); the lesson's `content.steps` is a legacy/snapshot field. Usually leave it empty.

## Publishing rules

`flowlearn_course_update` with `status: "published"` is rejected unless the course meets the publishing rules. The API returns either `400` (blocked) or `200` with `requiresConfirmation: true` (warning) inside `entity`.

**Hard blocks:**
- The course has zero modules.
- No lesson anywhere in the course has `flow_completed = true`.
- A module has gaps in lesson completion (later lessons complete, earlier ones not) while later modules have content.
- A module is empty while later modules have completed lessons.

**Warnings (require `force_publish: true` to override):**
- Trailing modules are empty.
- A module is partially complete (some lessons done, some not).

**To publish cleanly:** every module has at least one lesson with `flow_completed = true`, in order, no gaps. Set `flow_completed` on a lesson with `flowlearn_lesson_update`.

## Tests

A pytest suite under [`tests/`](tests/) drives the MCP over stdio JSON-RPC against `https://flowlearn.io` and exercises a full create → edit → publish workflow. The suite intentionally **does not delete** the course it creates so you can verify the result in the prod app; a separate `python tests/cleanup.py` script removes it when you're done.

```bash
pip install -r tests/requirements.txt
npm run build
pytest tests/ -v
# verify the course in the UI, then:
python tests/cleanup.py
```

See [tests/README.md](tests/README.md) for what each test asserts.

## How auth works

Better Auth on the Flowlearn server only supports cookie-based sessions — there is no API-key path. On the first tool call, the MCP server POSTs `email` + `password` to `/api/auth/sign-in/email`, captures the `Set-Cookie` header, and reuses it for subsequent requests. If a request returns 401 (session expired or revoked), the server signs in once more and retries.

The session cookie is held in memory only and discarded when the process exits.

## Tenant resolution

Every request includes `x-tenant-slug: <FLOWLEARN_TENANT_SLUG>`. The Flowlearn middleware looks the slug up against the authenticated user's `tenant_users` rows; the call fails with 403 if the user is not a member of that tenant or lacks the required role.

## Errors

Tool failures are returned as MCP tool errors (`isError: true`) with a structured envelope: `{ code, message, suggestion?, retriable, details? }`. Common codes: `FLOWLEARN_API_4xx/5xx` (upstream), `INVALID_ARGUMENTS` (Zod), `INVALID_TENANT` / `NOT_ADMIN` (setup), `UNKNOWN_TOOL` (typo or pre-v0.2.0 dotted name). Connection failures and config errors are written to stderr and exit the process so Claude Desktop / Claude Code reports them in its server panel.
