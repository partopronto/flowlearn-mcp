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
    assert stats == {"modules": 1, "lessons": 1, "flow_steps": 2, "connections": 1}
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
        "connections": 1,
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
