"""Regression tests for Tier 1 protocol surfaces: resources, prompts, completion.

These do NOT mutate flowlearn.io. They cover read paths and template metadata
only — safe to run repeatedly.
"""
from __future__ import annotations

import json

from mcp_client import McpClient


# -------------------------------------------------------------------------
# Resources
# -------------------------------------------------------------------------

def test_resources_list_includes_docs_and_tenant(mcp: McpClient) -> None:
    """resources/list must surface every help topic + the active tenant."""
    resp = mcp.request("resources/list")
    uris = {r["uri"] for r in resp["resources"]}
    assert "flowlearn://docs/overview" in uris
    assert "flowlearn://docs/publishing" in uris
    assert "flowlearn://docs/enums" in uris
    assert "flowlearn://docs/troubleshooting" in uris
    assert "flowlearn://tenant/current" in uris


def test_resource_templates_list(mcp: McpClient) -> None:
    """resources/templates/list must surface the 3 URI templates."""
    resp = mcp.request("resources/templates/list")
    templates = {t["uriTemplate"] for t in resp["resourceTemplates"]}
    assert templates == {
        "flowlearn://docs/{topic}",
        "flowlearn://course/{id}",
        "flowlearn://lesson/{id}",
    }


def test_read_docs_overview(mcp: McpClient) -> None:
    """Reading flowlearn://docs/overview must return markdown that mentions the tool naming convention."""
    resp = mcp.request("resources/read", {"uri": "flowlearn://docs/overview"})
    contents = resp["contents"]
    assert len(contents) == 1
    assert contents[0]["mimeType"] == "text/markdown"
    text = contents[0]["text"]
    assert "flowlearn_<resource>_<verb>" in text
    assert "tenant → course → module → lesson → flow_step" in text


def test_read_tenant_current(mcp: McpClient) -> None:
    """flowlearn://tenant/current must return JSON with email + active_tenant_slug."""
    resp = mcp.request("resources/read", {"uri": "flowlearn://tenant/current"})
    payload = json.loads(resp["contents"][0]["text"])
    assert "email" in payload
    assert "active_tenant_slug" in payload
    assert "memberships" in payload


def test_read_unknown_topic_errors(mcp: McpClient) -> None:
    """Unknown docs topic must raise a JSON-RPC error, not return junk."""
    import pytest
    from mcp_client import McpServerError
    with pytest.raises(McpServerError):
        mcp.request("resources/read", {"uri": "flowlearn://docs/nonsense"})


# -------------------------------------------------------------------------
# Prompts
# -------------------------------------------------------------------------

def test_prompts_list(mcp: McpClient) -> None:
    """prompts/list must surface the 4 slash-command prompts."""
    resp = mcp.request("prompts/list")
    names = {p["name"] for p in resp["prompts"]}
    assert names == {"scaffold_course", "audit_course", "import_markdown", "author_review"}


def test_prompt_get_author_review(mcp: McpClient) -> None:
    """prompts/get author_review must echo the course_id into the rendered message."""
    resp = mcp.request("prompts/get", {
        "name": "author_review",
        "arguments": {"course_id": "crs_xyz123"},
    })
    text = resp["messages"][0]["content"]["text"]
    assert "crs_xyz123" in text
    # Must surface every editorial check code so the agent knows what to look for.
    for code in [
        "IMAGE_REFERENCE_NO_IMAGE",
        "QUIZ_ANSWER_LEAKED",
        "IMAGE_LOOKS_LIKE_AD",
        "IMAGE_COPYRIGHTED",
        "MISSING_DESCRIPTION",
        "LAST_LESSON_NAVIGATION_LOOP",
    ]:
        assert code in text, f"author_review prompt missing check code {code}"


def test_prompt_get_scaffold_course(mcp: McpClient) -> None:
    """prompts/get scaffold_course must echo the outline into the rendered message."""
    resp = mcp.request("prompts/get", {
        "name": "scaffold_course",
        "arguments": {
            "outline": "Module 1: Greetings\nModule 2: Farewells",
            "language": "es",
        },
    })
    text = resp["messages"][0]["content"]["text"]
    assert "Module 1: Greetings" in text
    assert "Module 2: Farewells" in text
    assert "language: es" in text.lower() or 'language: "es"' in text or "Language: es" in text


def test_prompt_get_unknown_errors(mcp: McpClient) -> None:
    """prompts/get on unknown name must raise."""
    import pytest
    from mcp_client import McpServerError
    with pytest.raises(McpServerError):
        mcp.request("prompts/get", {"name": "bogus", "arguments": {}})


# -------------------------------------------------------------------------
# Completion
# -------------------------------------------------------------------------

def test_complete_docs_topic(mcp: McpClient) -> None:
    """Argument completion on flowlearn://docs/{topic} must return matching topics."""
    resp = mcp.request("completion/complete", {
        "ref": {"type": "ref/resource", "uri": "flowlearn://docs/{topic}"},
        "argument": {"name": "topic", "value": "pub"},
    })
    assert "publishing" in resp["completion"]["values"]


def test_complete_docs_topic_empty_returns_all(mcp: McpClient) -> None:
    """Empty value must return every topic."""
    resp = mcp.request("completion/complete", {
        "ref": {"type": "ref/resource", "uri": "flowlearn://docs/{topic}"},
        "argument": {"name": "topic", "value": ""},
    })
    values = set(resp["completion"]["values"])
    assert values == {"overview", "publishing", "enums", "troubleshooting"}
