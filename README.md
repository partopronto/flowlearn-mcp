# flowlearn-mcp

MCP server that exposes Flowlearn course-creation actions to Claude Code (terminal) or Claude Desktop. The server signs in to a Flowlearn instance as a tenant admin via Better Auth email/password, caches the session cookie, and proxies tool calls to the public HTTP API.

## What it does

Surfaces 29 tools that mirror what a tenant admin can do in the course-creation UI, plus three setup helpers callable from inside a Claude session. Server-side AI is intentionally not exposed (no `createWithAI`, no `improve`, no interview tools); the calling agent generates content and persists it via the dedicated tools.

- **Setup (3)** — `setup.status`, `setup.switchTenant`, `setup.update`
- **Course (5)** — `course.list`, `course.get`, `course.create`, `course.update`, `course.delete`
- **Module (5)** — `module.list`, `module.create`, `module.update`, `module.delete`, `module.reorder`
- **Lesson (5)** — `lesson.list`, `lesson.get`, `lesson.create`, `lesson.update`, `lesson.delete`
- **FlowStep (7)** — `flowStep.list`, `flowStep.create`, `flowStep.update`, `flowStep.delete`, `flowStep.reorder`, `flowStep.uploadImage`, `flowStep.deleteImage`
- **Connection (4)** — `connection.list`, `connection.add`, `connection.replaceAll`, `connection.clear`

The base URL is hardcoded to `https://flowlearn.io`. Delete and replace-all tools are always exposed.

### Setup tools — what's possible from inside Claude

Initial registration must happen in the terminal (chicken-and-egg: Claude can't call tools on a server it hasn't loaded). Once the MCP is loaded, everything else is callable mid-session:

| Tool | Use it for |
|---|---|
| `setup.status` | "Who am I signed in as, what tenant am I on, and what other admin tenants do I have?" Returns email, active tenant, and the full list of admin-role memberships. Confirms auth still works. |
| `setup.switchTenant` | "Switch to tenant `acme` for the rest of this session." In-memory only — reverts on Claude restart. Useful for trying something without committing. |
| `setup.update` | "Persistently update my email / password / tenant." Validates the new creds by signing in, then writes them to BOTH `~/.claude.json` (for future Claude sessions) AND the package's `.env`. The current session also picks up the new values immediately — **no Claude restart required**. If validation fails, nothing is written. |

**Security note on `setup.update`:** passing your password as a tool argument means it appears in your Claude Code chat transcript. Acceptable if that's your call; if not, run `python scripts/register.py` in terminal — that uses a hidden prompt and never touches the transcript.

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
6. **Verifies end-to-end** — spawns the MCP, calls `course.list`, reports the course count (success) or the exact API error (failure).

Re-run any time to change credentials or switch tenants.

### Non-interactive mode (Claude-callable)

```bash
python scripts/register.py --email you@example.com --password '<pw>' -y
# add --slug acme if you admin multiple tenants
# add --no-verify to skip the post-registration course.list call
```

WARNING: passing `--password` exposes it in shell history and the process list. Use the interactive prompt unless you have a specific automation reason.

### Roles

The account must have role `tenant_admin`, `creator`, or `super_admin` on at least one tenant. ("creator" is a Better Auth role name, not a job title.) The script tells you exactly which of your memberships qualify.

### Verify and use

```bash
claude mcp list           # should show 'flowlearn ✓ Connected'
claude mcp get flowlearn  # shows config including env values
```

Inside a Claude Code session, `/mcp` shows the server status and 29 tools. If you change credentials, restart any open session.

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

Restart Claude Desktop. The 29 tools appear under the `flowlearn` server.

## For Claude / AI agents — how to use this MCP

This section is written for an AI agent (you) that has the `flowlearn` MCP loaded and is being asked to do work in a Flowlearn tenant. Follow these patterns; they encode every gotcha learned during the build.

### Always start with `setup.status`

Before any other tool call in a fresh session, call `setup.status`. It returns the signed-in email, the active tenant slug, and the user's full list of admin-role tenants. Use it to:

- Confirm the MCP is healthy (auth works) before doing real work.
- Verify the user is on the tenant they expect — slug names sometimes look right but aren't.
- Enumerate options if you'll need to ask the user "which tenant?" later.

If `setup.status` fails, do not try to recover by guessing — report the exact error to the user and ask them to run `python scripts/register.py` in their terminal.

### Read before you write

Always call a `*.list` or `*.get` tool to find IDs before you call `*.update` or `*.delete`. Never construct an ID, never reuse an ID from a previous turn without re-listing — the user may have changed things in the UI in between.

Recommended discovery sequence: `course.list` → pick course id → `course.get` (shows modules) → pick module id → `lesson.list` → pick lesson id → `flowStep.list` (shows steps + connections in one call).

### Creating a course from scratch — canonical sequence

This is the only correct order. Skipping a step or reordering will produce silently broken courses.

1. `course.create` — `{title, topic}`. Both required. Returns `{course: {id, ...}}`.
2. `module.create` — once per module. Returns `{module: {id, order_index}}`.
3. `lesson.create` — once per lesson, scoped to a module. Returns `{lesson: {id}}`.
4. `flowStep.create` — once per step. The **first** step in each lesson MUST have `is_starting_step: true`; the others omit it. Returns `{flow_step: {id}}`.
5. `connection.add` — wires steps together. Each connection lives **on the source step**, points `to_step_id` at the target. Use `button_order: 1` for the first button on a step, 2 for the second, etc. `to_step_id: null` for terminal buttons.
6. `lesson.update` — set `flow_completed: true` on every lesson. **Without this, publishing will fail.**
7. `course.update` — `{status: "published"}`. If you get `requiresConfirmation: true`, re-call with `forcePublish: true`.

### Editing an existing course

- To rename / change description / change topic: `course.update`.
- To rewrite a step's text: `flowStep.update` with `content`. Note that `flowStep.update` also accepts a `buttons` array that REPLACES outgoing connections — for clarity, prefer the `connection.*` tools when only touching edges.
- To reorder modules / steps: use the dedicated `*.reorder` tools, passing the FULL list of ids in the new order. Partial lists are not supported.
- To change which step starts a lesson: include all steps in `flowStep.reorder` with the new starting step first; the API auto-sets `is_starting_step` based on order.

### Publishing — what the validator actually checks

Reject conditions (return 400 unless overridden):
- Course has zero modules.
- No lesson anywhere has `flow_completed: true`.
- A module has lesson-completion gaps (later complete, earlier not) while later modules have content.
- A module is empty while later modules have completed content.

Warning conditions (return 200 with `requiresConfirmation: true` — pass `forcePublish: true` to override):
- Trailing modules are empty.
- A module is partially complete.

Recipe to reliably publish: every module has ≥1 lesson with `flow_completed: true`, in order, no gaps. Set `flow_completed` with `lesson.update`.

### Common errors and what they mean

| Error | Likely cause | Fix |
|---|---|---|
| `403 USER_NOT_IN_TENANT` | Active tenant slug doesn't match any of your admin memberships | Call `setup.status` to see your tenants, then `setup.switchTenant` (or `setup.update` to persist) |
| `403 InsufficientPermissions` | Your role on this tenant isn't `tenant_admin` / `creator` / `super_admin` | Ask a tenant admin to upgrade your role |
| `401` on first call | Session cookie expired (the MCP auto-retries once) | If repeated: bad credentials. Use `setup.update` to fix |
| `400` on `course.update status=published` | Validation failed — see "Publishing rules" above | Set `flow_completed` on all lessons, or pass `forcePublish: true` if you got `requiresConfirmation` |
| `400 ValidationError on file` (uploadImage) | Wrong format or > 10 MB | PNG / JPEG / WebP / GIF only; MCP reduces to WebP server-side |
| `404 NotFound` on a resource | Wrong id, or another agent / human deleted it | Re-list to get a current id |
| Tool returns weird shape | API responses vary per route — most wrap as `{course: {...}}` or `{module: {...}}`; some return arrays | Don't assume — `JSON.parse` and probe |

### Anti-patterns — don't do these

- **Don't try to call `course.createWithAI`, `course.improve`, `module.improve`, `interview.questions`, or `interview.validate`.** They don't exist by design — server-side AI is intentionally not exposed. You generate content yourself, then persist it via the dedicated tools.
- **Don't hand-craft IDs.** They're UUIDs returned by create calls. Always store and reuse the returned id.
- **Don't call `course.delete` without confirming with the user first** — it cascades to everything underneath (modules, lessons, steps, connections, uploaded images). Same for the other `*.delete` tools.
- **Don't pass `goal` to `course.create`.** The schema does not include it. (Historical reason: server-side that field triggered AI auto-generation, which we don't want.)
- **Don't forget `is_starting_step: true` on the first step of each lesson.** The lesson will render but the learner will hit a dead end.
- **Don't assume slugs are case-insensitive.** They aren't (server-side bug — see [BUG-017](../../Flowlearn/docs/bugs/BUG-017-tenant-slug-case-sensitive-lookup.md) in the parent project). The MCP normalizes for you, but if you're constructing slug-bearing requests outside this MCP, lowercase them.

### When to use the setup tools

| Situation | Tool | Why |
|---|---|---|
| Fresh session, first action | `setup.status` | Confirm where you are and that auth works |
| User has multiple tenants and wants to do work on a specific one for one task | `setup.switchTenant` | Session-only switch, reverts on Claude restart |
| User says "from now on, default to tenant X" or "change my password" | `setup.update` | Persists to `~/.claude.json` AND `.env`; current session also picks up immediately |
| User says "what are my Flowlearn tenants?" | `setup.status` (read `allAdminTenants`) | One call, no extra round trip |

## Example workflow — building a small course

A creator types this in Claude Code:

> "Make a course called 'Beginner Spanish for Travelers' with three modules: Greetings, Ordering Food, Asking Directions. For Greetings, add one lesson 'Hola and Hello' with four steps: morning greeting, afternoon, evening, then a quiz."

The agent's call sequence (the agent generates the actual Spanish content; the MCP only persists):

| # | Tool | Args (abridged) | Returns |
|---|---|---|---|
| 1 | `course.create` | `{ title: "Beginner Spanish for Travelers", topic: "Spanish for travel" }` | `course.id = c1` |
| 2 | `module.create` | `{ courseId: c1, title: "Greetings" }` ×3 | `m1`, `m2`, `m3` |
| 3 | `lesson.create` | `{ moduleId: m1, title: "Hola and Hello" }` | `l1` |
| 4 | `flowStep.create` | `{ lessonId: l1, title: "Morning", content: "Buenos días means…", step_type: "message", is_starting_step: true }` | `s1` |
| 5 | `flowStep.create` ×2 | `{ lessonId: l1, title: "Afternoon" / "Evening", step_type: "message" }` | `s2`, `s3` |
| 6 | `flowStep.create` | `{ lessonId: l1, title: "Quick check", step_type: "quiz" }` | `s4` |
| 7 | `connection.add` | `{ flowStepId: s1, to_step_id: s2, button_text: "Next", button_order: 1 }` ×3 | wires `s1→s2→s3→s4` |
| 8 | `lesson.update` | `{ lessonId: l1, flow_completed: true }` | required for publish |
| 9 | `course.update` | `{ courseId: c1, status: "published" }` | live |

**Where do IDs come from?** Either from the return value of the previous create call, or from `course.list` / `module.list` / `lesson.list` / `flowStep.list` when working against an existing course.

## Reference — enum values and JSON shapes

Pulled from the Flowlearn codebase, not invented.

### `flowStep.step_type`
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
The live flow lives in `flow_steps` + `flow_connections` (managed via `flowStep.*` and `connection.*` tools); the lesson's `content.steps` is a legacy/snapshot field. Usually leave it empty.

## Publishing rules

`course.update` with `status: "published"` is rejected unless the course meets the publishing rules from `lib/validations/course-publish.ts`. The API returns either `400` (blocked) or `200` with `requiresConfirmation: true` (warning).

**Hard blocks:**
- The course has zero modules.
- No lesson anywhere in the course has `flow_completed = true`.
- A module has gaps in lesson completion (later lessons complete, earlier ones not) while later modules have content.
- A module is empty while later modules have completed lessons.

**Warnings (require `forcePublish: true` to override):**
- Trailing modules are empty.
- A module is partially complete (some lessons done, some not).

**To publish cleanly:** every module has at least one lesson with `flow_completed = true`, in order, no gaps. Set `flow_completed` on a lesson with `lesson.update`.

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

Tool failures are returned as MCP tool errors (`isError: true`) with the upstream HTTP status, the failing path, and the response body. Connection failures and config errors are written to stderr and exit the process so Claude Desktop / Claude Code reports them in its server panel.
