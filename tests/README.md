# flowlearn-mcp tests

End-to-end test suite that drives the MCP server over stdio JSON-RPC and exercises a course-creation workflow against `https://flowlearn.io` with the credentials in `.env`.

> **The suite mutates real production data.** It creates one course, edits it, publishes it, and **leaves it alive** so you can verify the result in the prod app. Run `python tests/cleanup.py` when you're done verifying.

## Install

```bash
cd flowlearn-mcp
pip install -r tests/requirements.txt
npm run build  # tests need dist/index.js
```

`.env` must already exist with `FLOWLEARN_EMAIL`, `FLOWLEARN_PASSWORD`, `FLOWLEARN_TENANT_SLUG` (same file used by `register.py`).

## Run

```bash
cd flowlearn-mcp
pytest tests/ -v
```

Test order:

| # | Test prefix | What it checks |
|---|---|---|
| 1 | `test_01_creation_*` | Course → 2 modules → 2 lessons → 5 flow steps → 3 connections built. Round-trips via list endpoints. |
| 2 | `test_02_edit_*` | Updating course title, module description, and flow step content persists across re-fetch. |
| 3 | `test_03_publish_*` | Marking every lesson `flow_completed=true` then `flowlearn_course_update status=published` flips the status. |

The `course_structure` fixture in `conftest.py` builds the tree once per session. The created course's id is written to `tests/.course-id.txt` (gitignored).

## Manual verification

After `pytest` passes, log into `https://flowlearn.io/<tenant>/courses` and find the most recent course titled `MCP Test - <ISO timestamp> (edited)`. Confirm:

- Two modules with the right titles, second module description matches the edit
- Lesson A's "Afternoon" step content reads `"Buenas tardes is used from noon until ~7pm."`
- Course status is `published`
- All flow connections render (s_a1 → s_a2 → s_a3 in lesson A; s_b1 → s_b2 in lesson B)

## Clean up

```bash
python tests/cleanup.py
```

Reads `tests/.course-id.txt`, calls `flowlearn_course_delete` on that id, removes the file. The delete cascades to all child entities and uploaded images.

If `tests/.course-id.txt` was lost (e.g. you cleared the file manually) you'll need to delete the course from the UI.
