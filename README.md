# flowlearn-mcp

MCP server that lets Claude build courses on [flowlearn.io](https://flowlearn.io). Claude generates the content; this server turns it into modules, lessons, flow steps, and connections through the flowlearn API.

Works with Claude Code (terminal), Claude Desktop, and any MCP-compatible client.

## What you can do

Once installed, you can ask Claude things like:

> *"Build me a 3-module course on Bollinger Bands. Difficulty intermediate. Quick check at the end of each module."*

> *"Lint course `crs_abc` for publish-readiness, then tell me what to fix."*

> *"Export course `crs_abc` to markdown so I can edit it offline. Re-import when I'm done."*

> *"Estimate how long this course takes to read, and check the reading level matches the declared difficulty."*

Behind the scenes Claude picks from **48 tools** the server exposes — you don't need to know which one does what. For the full catalog, type `flowlearn_help` inside Claude.

## Install

Requirements: Node 20+, Python 3, and a flowlearn.io account with an admin role on at least one tenant.

```bash
git clone <this repo> && cd flowlearn-mcp
npm install && npm run build
python scripts/register.py
```

`register.py` asks for your email + password, signs in to flowlearn.io, picks your tenant (or shows a list if you have several), writes a gitignored `.env`, and registers the MCP with Claude Code at the user scope so it's available from any project.

**Admin role required.** Your account needs `tenant_admin`, `creator`, or `super_admin` on at least one tenant. ("creator" is the Better Auth role name, not a job title.) The script tells you exactly which of your memberships qualify.

Verify:

```bash
claude mcp list   # should show 'flowlearn ✓ Connected'
```

For Claude Desktop or manual install, see "Manual install" below.

## What's in the box — by capability

| Family | What's in it |
|---|---|
| **Authoring** | Create / edit / delete courses, modules, lessons, flow steps, and connections. Upload images. Reorder things. |
| **One-shot** | `course_outline_apply` builds an entire course tree (modules + lessons + steps + connections) from a single nested outline. `outline_diff` + `outline_apply_diff` round-trip edits to an existing course. |
| **Quality** | `course_lint` catches structural problems before publish. Five pedagogy audits — objectives mapping, duration estimate, dead-link scan, readability vs declared difficulty, Bloom's-taxonomy verb distribution. |
| **Round-trip** | Export a course as JSON or markdown; re-import to recreate or fork. |
| **Atomic batches** | `course_transaction` for ad-hoc multi-step mutations with rollback; `connection_graph_replace` for whole-lesson edge edits. |
| **Setup** | Switch tenants mid-session, rotate credentials, check status. |

In-Claude reference: `flowlearn_help` (topics: `overview`, `publishing`, `enums`, `troubleshooting`). Same content is also addressable as MCP resources at `flowlearn://docs/{topic}`.

## Example: building a course

You ask Claude:

> *"Make a Spanish travel course with three modules: greetings, ordering food, asking directions. One lesson per module, three steps each, ending in a quick check."*

What happens:

| # | What Claude does |
|---|---|
| 1 | Calls `flowlearn_setup_status` to confirm the active tenant. |
| 2 | Drafts the outline tree — modules, lessons, step content. |
| 3 | Calls `flowlearn_course_outline_apply` once with the full tree. The server creates the course, all modules, lessons, steps, and default linear-chain connections in a single call. If anything fails partway, the partial course is rolled back. |
| 4 | Calls `flowlearn_course_lint` to confirm publish-readiness. |
| 5 | Reports the course URL and asks "ready to publish?". |
| 6 | On yes → `flowlearn_course_update status: "published"`. |

You see the course live in the flowlearn.io UI a few seconds later.

## Updating credentials or tenant

Re-run `python scripts/register.py` any time. It re-validates the new credentials before writing them and updates both `~/.claude.json` and `.env` atomically.

You can also do it from inside Claude:

> *"Switch my flowlearn tenant to acme."*

Claude calls `flowlearn_setup_switch_tenant` (session-only) or `flowlearn_setup_update` (persistent).

**Note on `flowlearn_setup_update`:** passing a password as a tool argument means it appears in the chat transcript. If you'd rather not, run `register.py` in a terminal — it uses a hidden prompt.

## Manual install

### Claude Code without the helper

```bash
claude mcp add flowlearn --scope user --transport stdio \
  --env FLOWLEARN_EMAIL=admin@acme.com \
  --env FLOWLEARN_PASSWORD=YOUR_PASSWORD \
  --env FLOWLEARN_TENANT_SLUG=acme \
  -- node /absolute/path/to/flowlearn-mcp/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

Restart Claude Desktop. The flowlearn tools appear under the `flowlearn` server.

## Tests

A pytest suite under [`tests/`](tests/) drives the MCP over stdio JSON-RPC against `https://flowlearn.io` and exercises a full create → edit → publish workflow. The suite intentionally **does not delete** the course it creates — verify it in the prod app, then run `python tests/cleanup.py` to remove.

```bash
pip install -r tests/requirements.txt
npm run build
pytest tests/ -v
```

See [tests/README.md](tests/README.md) for what each test covers.

## Limits

- The base URL is hardcoded to `https://flowlearn.io`. Self-hosted flowlearn instances aren't supported yet.
- Server-side AI is intentionally not exposed (no `createWithAI`, no `improve` tools). Claude generates content; this server only persists.
- The session cookie lives in memory only — restart the MCP to re-auth.

## Troubleshooting

- **`flowlearn ✗ Failed to connect`** in `claude mcp list` — the server crashed at startup. Run `node dist/index.js` directly to see the error.
- **`FLOWLEARN_API_403`** in a tool result — your active tenant slug doesn't grant write access. Re-run `register.py` and pick a tenant where you have an admin role.
- **`FLOWLEARN_API_401`** after working before — your password rotated or the session was revoked. Run `flowlearn_setup_update` from inside Claude, or `register.py` in a terminal.
- **Anything else** — `flowlearn_help { topic: "troubleshooting" }` inside Claude.
