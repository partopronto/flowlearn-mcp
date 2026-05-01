"""End-to-end workflow against flowlearn.io: create, edit, publish.

Tests run in alphabetical order, sharing one course built by the
`course_structure` session fixture. The course is NOT deleted on teardown —
run `python tests/cleanup.py` after manual verification.
"""
from __future__ import annotations

from typing import Any

from mcp_client import McpClient


# -------------------------------------------------------------------------
# 1. Creation — sanity check that the fixture built what we expected
# -------------------------------------------------------------------------

def test_01_creation_course_returned_id(course_structure: dict[str, Any]) -> None:
    """course.create must return a course with a non-empty id and the title we sent."""
    course = course_structure["course"]
    assert course["id"], "course.id missing in create response"
    assert course["title"] == course_structure["title"]
    assert course["status"] == "draft", "new course must start as draft"


def test_01_creation_two_modules(course_structure: dict[str, Any]) -> None:
    """Both modules created with the expected titles, in order."""
    modules = course_structure["modules"]
    assert len(modules) == 2
    assert modules[0]["title"] == "Module A — Greetings"
    assert modules[1]["title"] == "Module B — Farewells"
    assert modules[0]["order_index"] < modules[1]["order_index"]


def test_01_creation_steps_round_trip(
    mcp: McpClient, course_structure: dict[str, Any]
) -> None:
    """flowStep.list must return the 3 steps we created in lesson A,
    with exactly one `is_starting_step` and the correct order."""
    lesson_a = course_structure["lessons"][0]
    resp = mcp.call_tool("flowStep.list", {"lessonId": lesson_a["id"]})
    steps = resp["flow_steps"] if "flow_steps" in resp else resp
    assert len(steps) == 3, f"expected 3 steps, got {len(steps)}"
    starters = [s for s in steps if s.get("is_starting_step")]
    assert len(starters) == 1, "exactly one step must be starting_step"
    assert starters[0]["title"] == "Morning"


def test_01_creation_connections_round_trip(
    mcp: McpClient, course_structure: dict[str, Any]
) -> None:
    """connection.list on step_a1 must return one outgoing edge to step_a2."""
    step_a1 = course_structure["steps_a"][0]
    step_a2 = course_structure["steps_a"][1]
    resp = mcp.call_tool("connection.list", {"flowStepId": step_a1["id"]})
    connections = resp.get("connections", resp)
    assert len(connections) == 1
    assert connections[0]["to_step_id"] == step_a2["id"]
    assert connections[0]["button_text"] == "Next"


# -------------------------------------------------------------------------
# 2. Edit — updates persist across re-fetch
# -------------------------------------------------------------------------

def test_02_edit_course_title(
    mcp: McpClient, course_structure: dict[str, Any]
) -> None:
    """course.update title persists; course.get returns the new value."""
    course_id = course_structure["course"]["id"]
    new_title = course_structure["title"] + " (edited)"

    mcp.call_tool("course.update", {
        "courseId": course_id,
        "title": new_title,
    })

    fetched = mcp.call_tool("course.get", {"courseId": course_id})
    course = fetched.get("course", fetched)
    assert course["title"] == new_title


def test_02_edit_module_description(
    mcp: McpClient, course_structure: dict[str, Any]
) -> None:
    """module.update description persists; module.list returns the new value."""
    module = course_structure["modules"][0]
    course_id = course_structure["course"]["id"]
    new_description = "How to greet strangers — politely."

    mcp.call_tool("module.update", {
        "moduleId": module["id"],
        "description": new_description,
    })

    resp = mcp.call_tool("module.list", {"courseId": course_id})
    modules = resp.get("modules", resp)
    found = next(m for m in modules if m["id"] == module["id"])
    assert found["description"] == new_description


def test_02_edit_flow_step_content(
    mcp: McpClient, course_structure: dict[str, Any]
) -> None:
    """flowStep.update content persists; flowStep.list returns the new value."""
    step = course_structure["steps_a"][1]  # the "Afternoon" step
    lesson_id = course_structure["lessons"][0]["id"]
    new_content = "Buenas tardes is used from noon until ~7pm."

    mcp.call_tool("flowStep.update", {
        "flowStepId": step["id"],
        "content": new_content,
    })

    resp = mcp.call_tool("flowStep.list", {"lessonId": lesson_id})
    steps = resp.get("flow_steps", resp)
    found = next(s for s in steps if s["id"] == step["id"])
    assert found["content"] == new_content


# -------------------------------------------------------------------------
# 3. Publish — flow_completed on every lesson, then status→published
# -------------------------------------------------------------------------

def test_03_publish_requires_flow_completed(
    mcp: McpClient, course_structure: dict[str, Any]
) -> None:
    """Mark every lesson flow_completed=true, then publish; status must flip."""
    course_id = course_structure["course"]["id"]

    for lesson in course_structure["lessons"]:
        mcp.call_tool("lesson.update", {
            "lessonId": lesson["id"],
            "flow_completed": True,
        })

    publish_resp = mcp.call_tool("course.update", {
        "courseId": course_id,
        "status": "published",
        "forcePublish": True,
    })

    # The PUT route returns either {success, course, validation} or
    # {success: true, requiresConfirmation, validation}; our forcePublish=true
    # should drive it through to a published course.
    if publish_resp.get("requiresConfirmation"):
        # forcePublish should have skipped this — fail loudly
        raise AssertionError(
            f"Publish unexpectedly returned requiresConfirmation despite "
            f"forcePublish=true: {publish_resp.get('validation')}"
        )

    fetched = mcp.call_tool("course.get", {"courseId": course_id})
    course = fetched.get("course", fetched)
    assert course["status"] == "published", (
        f"course did not publish; status={course['status']!r}"
    )
