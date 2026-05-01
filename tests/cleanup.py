#!/usr/bin/env python3
"""Delete the course created by the test suite.

Reads the course id from `tests/.course-id.txt` (written by the fixture)
and calls course.delete via the MCP. Cascade kills modules, lessons,
flow steps, connections, and uploaded images.

Usage:
    python tests/cleanup.py
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make `mcp_client` importable when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from mcp_client import McpClient  # noqa: E402

PKG_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PKG_ROOT / ".env"
SERVER_ENTRY = PKG_ROOT / "dist" / "index.js"
COURSE_ID_FILE = Path(__file__).resolve().parent / ".course-id.txt"

REQUIRED_VARS = ["FLOWLEARN_EMAIL", "FLOWLEARN_PASSWORD", "FLOWLEARN_TENANT_SLUG"]


def parse_env(env_path: Path) -> dict[str, str]:
    if not env_path.exists():
        sys.exit(f"Missing {env_path}. Cannot authenticate without creds.")
    out: dict[str, str] = {}
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip('"').strip("'")
    missing = [v for v in REQUIRED_VARS if not out.get(v)]
    if missing:
        sys.exit(f"Missing values in {env_path}: {', '.join(missing)}")
    return out


def main() -> int:
    if not COURSE_ID_FILE.exists():
        sys.exit(
            f"No saved course id at {COURSE_ID_FILE}.\n"
            "Run the test suite first, or there is nothing to clean up."
        )

    course_id = COURSE_ID_FILE.read_text(encoding="utf-8").strip()
    if not course_id:
        sys.exit(f"{COURSE_ID_FILE} is empty.")

    env = parse_env(ENV_PATH)
    client = McpClient(SERVER_ENTRY, env)
    try:
        print(f"Deleting course {course_id}...")
        result = client.call_tool("course.delete", {"courseId": course_id})
        print(f"course.delete result: {result}")
    finally:
        client.close()

    COURSE_ID_FILE.unlink()
    print(f"Removed {COURSE_ID_FILE.name}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
