#!/usr/bin/env python3
"""Delete every test course this MCP suite has ever left behind.

Lists all courses on the active tenant, filters those whose title starts with
"MCP Test - " (the prefix used by tests/conftest.py), and deletes them in one
pass. Idempotent — safe to run with no orphans. Replaces the previous
single-id .course-id.txt approach which only cleaned the most recent run.

Usage:
    python tests/cleanup.py            # delete all matching test courses
    python tests/cleanup.py --dry-run  # list candidates without deleting
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mcp_client import McpClient  # noqa: E402

PKG_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PKG_ROOT / ".env"
SERVER_ENTRY = PKG_ROOT / "dist" / "index.js"
COURSE_ID_FILE = Path(__file__).resolve().parent / ".course-id.txt"
TEST_TITLE_PREFIX = "MCP Test - "

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
    parser = argparse.ArgumentParser(
        description="Delete every test course this MCP suite has left behind."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List candidates without deleting.",
    )
    args = parser.parse_args()

    env = parse_env(ENV_PATH)
    client = McpClient(SERVER_ENTRY, env)
    try:
        # Pull a wide page; production tenants rarely have >200 test orphans.
        list_resp = client.call_tool(
            "flowlearn_course_list",
            {"limit": 200, "response_format": "concise"},
        )
        items = list_resp.get("items", [])
        candidates = [
            c for c in items
            if str(c.get("title", "")).startswith(TEST_TITLE_PREFIX)
        ]

        if not candidates:
            print(
                f"No test courses to clean up "
                f"(looked for title prefix {TEST_TITLE_PREFIX!r})."
            )
            return 0

        print(f"Found {len(candidates)} test course(s):")
        for c in candidates:
            print(f"  - {c['title']}  (id={c['id']})")

        if args.dry_run:
            print("\nDry-run; nothing deleted.")
            return 0

        print()
        deleted = 0
        for c in candidates:
            try:
                client.call_tool(
                    "flowlearn_course_delete", {"course_id": c["id"]}
                )
                deleted += 1
                print(f"  deleted  {c['id']}")
            except Exception as exc:
                print(f"  FAILED   {c['id']}: {exc}")

        # Drop the legacy hint file if present — no longer used.
        if COURSE_ID_FILE.exists():
            COURSE_ID_FILE.unlink()

        print(f"\nDeleted {deleted}/{len(candidates)} test course(s).")
    finally:
        client.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
