"""Pytest fixtures: load creds from .env, spin up MCP, build a test course."""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from mcp_client import McpClient

PKG_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PKG_ROOT / ".env"
SERVER_ENTRY = PKG_ROOT / "dist" / "index.js"
COURSE_ID_FILE = Path(__file__).parent / ".course-id.txt"

REQUIRED_VARS = ["FLOWLEARN_EMAIL", "FLOWLEARN_PASSWORD", "FLOWLEARN_TENANT_SLUG"]


def _parse_env(env_path: Path) -> dict[str, str]:
    if not env_path.exists():
        pytest.exit(
            f"Missing {env_path}. Copy .env.example to .env and fill in values.",
            returncode=2,
        )
    out: dict[str, str] = {}
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip().strip('"').strip("'")
    missing = [v for v in REQUIRED_VARS if not out.get(v)]
    if missing:
        pytest.exit(
            f"Missing values in {env_path}: {', '.join(missing)}",
            returncode=2,
        )
    return out


@pytest.fixture(scope="session")
def mcp() -> Any:
    """Spawn the MCP server subprocess for the whole test session."""
    env = _parse_env(ENV_PATH)
    client = McpClient(SERVER_ENTRY, env)
    yield client
    client.close()


@pytest.fixture(scope="session")
def course_structure(mcp: McpClient) -> dict[str, Any]:
    """Create a full course tree on flowlearn.io and return all created entities.

    Persists the course id to tests/.course-id.txt so the cleanup script can
    delete it after manual verification.
    """
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    course_title = f"MCP Test - {timestamp}"

    print(f"\n[setup] Creating test course: {course_title!r}")

    course_resp = mcp.call_tool("flowlearn_course_create", {
        "title": course_title,
        "topic": "MCP smoke test",
        "description": "Created automatically by flowlearn-mcp test suite.",
        "difficulty": "beginner",
        "language": "en",
    })
    course = course_resp["entity"]
    COURSE_ID_FILE.write_text(course["id"], encoding="utf-8")
    print(f"[setup] course.id={course['id']} (saved to {COURSE_ID_FILE.name})")

    module_a = mcp.call_tool("flowlearn_module_create", {
        "course_id": course["id"],
        "title": "Module A — Greetings",
        "description": "How to greet strangers.",
    })
    module_b = mcp.call_tool("flowlearn_module_create", {
        "course_id": course["id"],
        "title": "Module B — Farewells",
        "description": "How to say goodbye.",
    })

    lesson_a = mcp.call_tool("flowlearn_lesson_create", {
        "module_id": module_a["entity"]["id"],
        "title": "Lesson A1 — Hello",
        "description": "Saying hello at different times of day.",
    })
    lesson_b = mcp.call_tool("flowlearn_lesson_create", {
        "module_id": module_b["entity"]["id"],
        "title": "Lesson B1 — Goodbye",
        "description": "Saying goodbye.",
    })

    step_a1 = mcp.call_tool("flowlearn_flow_step_create", {
        "lesson_id": lesson_a["entity"]["id"],
        "title": "Morning",
        "content": "Buenos días means good morning.",
        "step_type": "message",
        "is_starting_step": True,
    })
    step_a2 = mcp.call_tool("flowlearn_flow_step_create", {
        "lesson_id": lesson_a["entity"]["id"],
        "title": "Afternoon",
        "content": "Buenas tardes means good afternoon.",
        "step_type": "message",
    })
    step_a3 = mcp.call_tool("flowlearn_flow_step_create", {
        "lesson_id": lesson_a["entity"]["id"],
        "title": "Quick check",
        "content": "Which one means good morning?",
        "step_type": "quiz",
    })

    step_b1 = mcp.call_tool("flowlearn_flow_step_create", {
        "lesson_id": lesson_b["entity"]["id"],
        "title": "Goodbye",
        "content": "Adiós means goodbye.",
        "step_type": "message",
        "is_starting_step": True,
    })
    step_b2 = mcp.call_tool("flowlearn_flow_step_create", {
        "lesson_id": lesson_b["entity"]["id"],
        "title": "See you later",
        "content": "Hasta luego means see you later.",
        "step_type": "message",
    })

    mcp.call_tool("flowlearn_connection_add", {
        "flow_step_id": step_a1["entity"]["id"],
        "to_step_id": step_a2["entity"]["id"],
        "button_text": "Next",
        "button_action": "next",
        "button_order": 1,
    })
    mcp.call_tool("flowlearn_connection_add", {
        "flow_step_id": step_a2["entity"]["id"],
        "to_step_id": step_a3["entity"]["id"],
        "button_text": "Next",
        "button_action": "next",
        "button_order": 1,
    })
    mcp.call_tool("flowlearn_connection_add", {
        "flow_step_id": step_b1["entity"]["id"],
        "to_step_id": step_b2["entity"]["id"],
        "button_text": "Next",
        "button_action": "next",
        "button_order": 1,
    })

    print("[setup] Course tree created.")

    return {
        "title": course_title,
        "course": course,
        "modules": [module_a["entity"], module_b["entity"]],
        "lessons": [lesson_a["entity"], lesson_b["entity"]],
        "steps_a": [step_a1["entity"], step_a2["entity"], step_a3["entity"]],
        "steps_b": [step_b1["entity"], step_b2["entity"]],
    }
