"""End-to-end tests for slim Tier 2 authoring tools: outline_apply + lint.

These tests build a small course with flowlearn_course_outline_apply, lint it,
and clean up — all in one test function so the production-data footprint is
predictable. The test course is NOT shared with the workflow fixture.
"""
from __future__ import annotations

import datetime as dt

import pytest
from mcp_client import McpClient, McpToolError


def _outline(title: str) -> dict:
    return {
        "course": {
            "title": title,
            "topic": "Outline-apply smoke",
            "description": "Created by flowlearn_course_outline_apply tests.",
            "language": "en",
            "modules": [
                {
                    "title": "Module 1",
                    "objectives": ["Demonstrate one-shot creation"],
                    "lessons": [
                        {
                            "title": "Lesson 1.1",
                            "description": "Single lesson with two steps.",
                            "steps": [
                                {"title": "Intro", "content": "Welcome."},
                                {"title": "Outro", "content": "Goodbye."},
                            ],
                        },
                    ],
                },
            ],
        },
    }


def test_outline_apply_dry_run_returns_plan_no_mutation(mcp: McpClient) -> None:
    """dry_run must return a plan without creating the course."""
    payload = _outline(f"DRYRUN-{dt.datetime.now(dt.timezone.utc).isoformat()}")
    payload["dry_run"] = True

    resp = mcp.call_tool("flowlearn_course_outline_apply", payload)

    assert resp["summary"].startswith("[dry-run]")
    stats = resp["entity"]["stats"]
    # 2-step lesson → 1 chain edge (step0→step1) + 1 terminal (step1→null) = 2.
    assert stats == {"modules": 1, "lessons": 1, "flow_steps": 2, "connections": 2}
    # The course in the response is the INPUT shape, not a server response;
    # there should be no `id` field because nothing was created.
    assert "id" not in resp["entity"]["course"]


def test_outline_apply_then_lint_then_cleanup(mcp: McpClient) -> None:
    """Build a course with outline_apply, lint it, verify publish_ready=true, delete."""
    payload = _outline(f"OUTLINE-{dt.datetime.now(dt.timezone.utc).isoformat()}")
    # Default mark_flow_completed=true → course should be publish-ready immediately.

    create_resp = mcp.call_tool("flowlearn_course_outline_apply", payload)
    course = create_resp["entity"]["course"]
    course_id = course["id"]
    assert create_resp["entity"]["stats"] == {
        "modules": 1,
        "lessons": 1,
        "flow_steps": 2,
        # 1 chain edge + 1 terminal "Complete lesson" button = 2.
        "connections": 2,
    }
    assert create_resp["entity"]["flow_completed_marked"] is True
    assert create_resp["entity"]["published"] is False

    try:
        # Lint the freshly-built course.
        lint_resp = mcp.call_tool("flowlearn_course_lint", {"course_id": course_id})
        ent = lint_resp["entity"]
        assert ent["course_id"] == course_id
        assert ent["counts"]["errors"] == 0, f"unexpected errors: {ent['issues']}"
        assert ent["publish_ready"] is True, f"not publish-ready: {ent['issues']}"
    finally:
        # Always clean up — leaving a test course around clutters the tenant.
        mcp.call_tool("flowlearn_course_delete", {"course_id": course_id})


def test_outline_apply_no_mark_flow_completed_warns(mcp: McpClient) -> None:
    """With mark_flow_completed=false, lint must surface LESSON_NOT_FLOW_COMPLETED warnings and publish_ready=false."""
    payload = _outline(f"NOFLOW-{dt.datetime.now(dt.timezone.utc).isoformat()}")
    payload["mark_flow_completed"] = False

    create_resp = mcp.call_tool("flowlearn_course_outline_apply", payload)
    course_id = create_resp["entity"]["course"]["id"]

    try:
        lint_resp = mcp.call_tool("flowlearn_course_lint", {"course_id": course_id})
        ent = lint_resp["entity"]
        assert ent["publish_ready"] is False
        codes = {i["code"] for i in ent["issues"]}
        assert "LESSON_NOT_FLOW_COMPLETED" in codes
    finally:
        mcp.call_tool("flowlearn_course_delete", {"course_id": course_id})


def test_outline_apply_invalid_outline_rejects(mcp: McpClient) -> None:
    """Zod schema must reject a course with no modules."""
    bad = {
        "course": {
            "title": "should-fail",
            "topic": "should-fail",
            "modules": [],  # min(1) violation
        },
    }
    with pytest.raises(McpToolError):
        mcp.call_tool("flowlearn_course_outline_apply", bad)


def test_export_outline_roundtrips(mcp: McpClient) -> None:
    """Build a course via outline_apply, export it, verify the export shape
    matches outline_apply's input contract. Real round-trip safety net."""
    payload = _outline(f"EXPORT-{dt.datetime.now(dt.timezone.utc).isoformat()}")
    create_resp = mcp.call_tool("flowlearn_course_outline_apply", payload)
    course_id = create_resp["entity"]["course"]["id"]

    try:
        export = mcp.call_tool("flowlearn_course_export_outline", {"course_id": course_id})
        outline = export["entity"]["outline"]
        stats = export["entity"]["stats"]

        # Stats must match what outline_apply created (1 module, 1 lesson,
        # 2 steps, 2 connections — chain + terminal).
        assert stats == {"modules": 1, "lessons": 1, "flow_steps": 2, "connections": 2}

        # The exported outline must mirror the input shape.
        assert outline["course"]["title"] == payload["course"]["title"]
        assert outline["course"]["topic"] == payload["course"]["topic"]

        modules = outline["course"]["modules"]
        assert len(modules) == 1
        assert modules[0]["title"] == "Module 1"

        lessons = modules[0]["lessons"]
        assert len(lessons) == 1
        assert lessons[0]["title"] == "Lesson 1.1"
        assert lessons[0]["flow_completed"] is True  # default mark_flow_completed=true

        steps = lessons[0]["steps"]
        assert len(steps) == 2
        assert steps[0]["title"] == "Intro"
        assert steps[0]["content"] == "Welcome."
        assert steps[0]["is_starting_step"] is True

        # Connections must be position-based, not id-based.
        conns = lessons[0]["connections"]
        assert len(conns) == 2
        # Chain edge: step 0 → step 1.
        chain = next(c for c in conns if c["to_index"] == 1)
        assert chain["from_index"] == 0
        assert chain["button_text"] == "Next"
        # Terminal: step 1 → null.
        terminal = next(c for c in conns if c["to_index"] is None)
        assert terminal["from_index"] == 1
        assert terminal["button_text"] == "Complete lesson"
    finally:
        mcp.call_tool("flowlearn_course_delete", {"course_id": course_id})
