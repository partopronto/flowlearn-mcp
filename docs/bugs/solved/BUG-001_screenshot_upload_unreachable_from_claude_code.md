# BUG-001 — flowlearn_flow_step_upload_image is unreachable from Claude Code (screenshot paste)

**Severity:** P2 (High) — Major feature broken, no in-tool workaround
**Status:** Solved
**Effort:** Small — `src/tools/flowStep.ts` only, plus permanent regression tests

## Reproduction

1. Run flowlearn-mcp in Claude Code (claude.exe in a Windows terminal).
2. Paste a screenshot into the prompt with `Ctrl+V`.
3. Ask the agent: "upload this screenshot to flow step `stp_xxx` using the flowlearn MCP".
4. Agent calls `flowlearn_flow_step_upload_image` and either (a) refuses, (b) hallucinates a base64 string, or (c) attempts to base64-encode the file via PowerShell and overflows the tool-argument size budget.

End result: the user cannot get a pasted screenshot into a flow step via Claude Code.

### Expected

User pastes a screenshot (or hands the agent a path) and the upload completes.

### Actual (before fix)

The tool's only input was `image_data: string` (base64). MCP tool parameters are JSON scalars; pasted screenshots in Claude Code reach the model as multimodal vision blocks that **cannot be serialized back to base64** by the model. The PowerShell escape hatch (`[Convert]::ToBase64String(...)`) works mechanically but a typical screenshot encodes to 2–5 MB of text, blowing tool-argument budgets and context.

## Root Cause Trace

1. **Tool definition** at `src/tools/flowStep.ts:264` (pre-fix) declared `inputSchema = { flow_step_id, image_data }` — only base64 string accepted.
2. **MCP protocol constraint**: tool parameters are typed JSON (string, number, boolean, object). The MCP spec defines image *outputs* (`{type:"image", data, mimeType}`) but no equivalent for image *inputs*. See [MCP spec — Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
3. **Claude Code paste behaviour**: a `Ctrl+V` of a screenshot becomes a multimodal content block injected into the model's context. The model can *see* the pixels but has no programmatic handle to the bytes (no `image.toBase64()`-equivalent surface). Confirmed in [anthropics/claude-code#26679](https://github.com/anthropics/claude-code/issues/26679) and [#12644](https://github.com/anthropics/claude-code/issues/12644).
4. **Practical consequence**: the only string parameter in the tool is unreachable from the dominant client. The Bash/PowerShell base64 workaround is technically possible but fails on real screenshots due to tool-argument size limits and context bloat.

The MCP server itself does NO image preprocessing — confirmed by full sweep of `src/` and `package.json` (no `sharp`, `jimp`, etc.). The user's initial hypothesis ("we process images before upload") was incorrect; the issue is that the tool never has bytes to forward in the first place.

### Industry pattern

Surveyed MCP servers that accept images all expose a multi-source input or split tools (`*_from_path`, `*_from_url`, `*_from_base64`). Examples: `mcp-image-extractor`, `IA-Programming/mcp-images`, `champierre/image-mcp-server`. None rely on base64 alone.

## Fix

`src/tools/flowStep.ts:264` — `flowlearn_flow_step_upload_image` now accepts **exactly one** of:

| Source | Type | Behaviour |
|---|---|---|
| `image_path` | absolute filesystem path | MCP server reads the file via `fs/promises`, validates, base64-encodes |
| `image_url` | http(s) URL | MCP server fetches via `fetch()`, validates Content-Length and bytes, base64-encodes |
| `image_data` | base64 string | Forwarded as-is (programmatic callers) |

Validation runs **before** the Flowlearn API call:

- Exactly one source required (zero or multiple → `INVALID_ARGUMENTS`)
- `image_path` must be absolute (relative → `INVALID_ARGUMENTS`; CWD is not assumed)
- `image_url` must be `http(s)` scheme (`ftp://`, `file://` → `INVALID_ARGUMENTS`)
- Size ≤ 10 MB (`IMAGE_TOO_LARGE`)
- Magic-byte sniff for PNG/JPEG/WebP/GIF (`IMAGE_INVALID_FORMAT`) — extension is not trusted
- File-read errors → `IMAGE_READ_FAILED` (retriable)
- URL-fetch errors → `IMAGE_FETCH_FAILED` (retriable)

The Flowlearn HTTP API contract is unchanged — the MCP layer always sends `{ imageData: <base64> }`.

## Verification

| Test | Coverage |
|---|---|
| `tests/test_image_upload.py` | 11 validation tests covering every error path (zero/multi sources, relative path, missing file, non-image bytes via path AND data, ftp URL, whitespace base64, tools/list metadata, valid-PNG-passes-validation). All pass in 2 s without hitting the Flowlearn API. |
| Live happy-path (one-shot, deleted post-verification) | Uploaded a 64×64 PNG via all three sources to a real flow step on flowlearn.io. Each upload returned `image_url` + dimensions. Image deleted between attempts and finally. |

Live verification output (2026-05-01):

```
[live] (1/3) uploading via image_path=...\tiny.png
[live] OK — Uploaded png image (373 bytes, source=image_path) ... URL: /api/files/e609e8e4-...
[live] (2/3) uploading via image_data (500 chars base64)
[live] OK — Uploaded png image (373 bytes, source=image_data) ... URL: /api/files/92fd8158-...
[live] (3/3) uploading via image_url=http://127.0.0.1:58696/test.png
[live] OK — Uploaded png image (373 bytes, source=image_url) ... URL: /api/files/42fbcedf-...
[live] image deleted — flow step is back to image-less state.
[live] ALL THREE SOURCES VERIFIED.
```

## Resolution

Verified 2026-05-01. Pasted screenshots from Claude Code are now uploadable in two clicks: save the screenshot to disk (Snipping Tool / Win+Shift+S → save, or drag-drop a file into the terminal so its path is pasted), then ask the agent to upload — the agent passes the absolute path via `image_path` and the MCP server handles read + encode + forward. Programmatic callers can still use `image_data`; URL-hosted images can use `image_url`.

### Files changed

- `src/tools/flowStep.ts` — added `loadAndValidateImage` helper (path read, URL fetch, magic-byte sniff, size cap, base64) and rewrote the `flowlearn_flow_step_upload_image` tool definition with the multi-source schema.
- `tests/test_image_upload.py` — new file, 11 validation tests (permanent).
