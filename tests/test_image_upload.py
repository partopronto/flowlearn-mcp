"""Validation tests for flowlearn_flow_step_upload_image.

Exercises the multi-source input layer (image_path / image_url / image_data)
without ever calling the Flowlearn HTTP API. Each adversarial input must
return a structured `errorResult` envelope BEFORE the MCP server makes a
network round-trip.

Live happy-path upload is verified separately (see _verify_image_upload_live.py
or run the workflow suite). The point of this file is to lock down the
validation contract so future refactors can't silently weaken it.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from mcp_client import McpClient


# A minimal valid PNG — 1x1 transparent pixel. Magic bytes intact, total 67 B.
TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6300010000000500010d0a2db40000000049454e44"
    "ae426082"
)


def _call_upload_raw(mcp: McpClient, **arguments) -> dict:
    """Send tools/call directly so we can inspect isError without raising."""
    return mcp.request("tools/call", {
        "name": "flowlearn_flow_step_upload_image",
        "arguments": {"flow_step_id": "stp_validation_only", **arguments},
    })


def _expect_error(result: dict) -> dict:
    """Pull the structured error envelope from a failed tool call."""
    assert result.get("isError") is True, (
        f"expected isError=true, got: {json.dumps(result, indent=2)}"
    )
    return json.loads(result["content"][0]["text"])


# -------------------------------------------------------------------------
# Multi-source contract: exactly one of path/url/data must be provided.
# Real-world failure: agent calls with no image source → API hit fails
# without context, instead of a clean validation error.
# -------------------------------------------------------------------------

def test_rejects_zero_sources(mcp: McpClient) -> None:
    """No image source → INVALID_ARGUMENTS, never reaches the network."""
    err = _expect_error(_call_upload_raw(mcp))
    assert err["code"] == "INVALID_ARGUMENTS"
    assert "image_path" in err["message"]
    assert err["retriable"] is False


def test_rejects_two_sources(mcp: McpClient) -> None:
    """Two sources at once → INVALID_ARGUMENTS. Prevents ambiguous behaviour."""
    err = _expect_error(_call_upload_raw(
        mcp, image_path="C:\\nonexistent.png", image_data="aGVsbG8="
    ))
    assert err["code"] == "INVALID_ARGUMENTS"
    assert "Only one image source" in err["message"]


def test_rejects_three_sources(mcp: McpClient) -> None:
    """All three sources → INVALID_ARGUMENTS, lists what was provided."""
    err = _expect_error(_call_upload_raw(
        mcp,
        image_path="C:\\nonexistent.png",
        image_url="https://example.com/x.png",
        image_data="aGVsbG8=",
    ))
    assert err["code"] == "INVALID_ARGUMENTS"
    assert "image_path" in err["message"]
    assert "image_url" in err["message"]
    assert "image_data" in err["message"]


# -------------------------------------------------------------------------
# image_path validation: absolute paths only, file must exist.
# Real-world failure: agent passes a relative path; MCP server's CWD differs
# from the user's; file is silently looked up in the wrong place.
# -------------------------------------------------------------------------

def test_rejects_relative_path(mcp: McpClient) -> None:
    """Relative path → INVALID_ARGUMENTS. The MCP server's CWD is not assumed."""
    err = _expect_error(_call_upload_raw(mcp, image_path="screenshots/img.png"))
    assert err["code"] == "INVALID_ARGUMENTS"
    assert "absolute" in err["message"].lower()


def test_rejects_missing_file(mcp: McpClient, tmp_path: Path) -> None:
    """Absolute path that doesn't exist → IMAGE_READ_FAILED, retriable=true."""
    missing = tmp_path / "does-not-exist.png"
    err = _expect_error(_call_upload_raw(mcp, image_path=str(missing)))
    assert err["code"] == "IMAGE_READ_FAILED"
    assert err["retriable"] is True


# -------------------------------------------------------------------------
# Magic-byte sniff: extension is not trusted, real bytes are checked.
# Real-world failure: a .png file that's actually JSON or HTML (download
# hiccup, save-as mistake) — extension lies, content sniff catches it.
# -------------------------------------------------------------------------

def test_rejects_non_image_bytes_via_path(mcp: McpClient, tmp_path: Path) -> None:
    """File exists but bytes don't match PNG/JPEG/WebP/GIF → IMAGE_INVALID_FORMAT."""
    fake = tmp_path / "lying.png"
    fake.write_text("Not a PNG. Just some text.\n", encoding="utf-8")
    err = _expect_error(_call_upload_raw(mcp, image_path=str(fake)))
    assert err["code"] == "IMAGE_INVALID_FORMAT"
    assert err["retriable"] is False


def test_rejects_non_image_bytes_via_data(mcp: McpClient) -> None:
    """Base64 of plain text → IMAGE_INVALID_FORMAT (sniff runs after decode)."""
    junk = base64.b64encode(b"Not a PNG. Just some text.\n").decode("ascii")
    err = _expect_error(_call_upload_raw(mcp, image_data=junk))
    assert err["code"] == "IMAGE_INVALID_FORMAT"


# -------------------------------------------------------------------------
# image_url validation: scheme must be http(s); ftp/file/etc rejected.
# Real-world failure: agent passes file:// URL — without scheme check this
# would let the server read arbitrary local files via fetch's URL handler.
# -------------------------------------------------------------------------

def test_rejects_non_http_url(mcp: McpClient) -> None:
    """ftp:// URL → INVALID_ARGUMENTS at the scheme-check layer."""
    err = _expect_error(_call_upload_raw(mcp, image_url="ftp://example.com/x.png"))
    # Zod's .url() accepts the URL; our http(s)-only regex must still reject it.
    # Either the schema (Zod) catches it or our handler does — both are acceptable.
    assert err["code"] in {"INVALID_ARGUMENTS"}


# -------------------------------------------------------------------------
# image_data validation: must decode to non-zero bytes.
# Real-world failure: agent passes whitespace or invalid base64; without
# this check we'd pass an empty string to the API and get an opaque 400.
# -------------------------------------------------------------------------

def test_rejects_whitespace_base64(mcp: McpClient) -> None:
    """Whitespace-only base64 decodes to 0 bytes → INVALID_ARGUMENTS."""
    err = _expect_error(_call_upload_raw(mcp, image_data="    "))
    assert err["code"] == "INVALID_ARGUMENTS"


# -------------------------------------------------------------------------
# Tools/list metadata — agent-discoverability of the new inputs.
# Real-world failure: schema fields exist in code but aren't surfaced to
# clients — the agent can't see image_path is an option.
# -------------------------------------------------------------------------

def test_tools_list_advertises_three_image_inputs(mcp: McpClient) -> None:
    """tools/list must surface image_path, image_url, and image_data on
    flowlearn_flow_step_upload_image."""
    resp = mcp.request("tools/list")
    upload = next(
        t for t in resp["tools"]
        if t["name"] == "flowlearn_flow_step_upload_image"
    )
    props = upload["inputSchema"]["properties"]
    assert "image_path" in props
    assert "image_url" in props
    assert "image_data" in props
    # All three optional — no `required` entry for any of them
    required = set(upload["inputSchema"].get("required", []))
    assert "flow_step_id" in required
    assert "image_path" not in required
    assert "image_url" not in required
    assert "image_data" not in required


# -------------------------------------------------------------------------
# Validation passes for a real PNG — sanity check that the path/sniff/decode
# pipeline doesn't reject valid input. We use a bogus flow_step_id so the
# Flowlearn API rejects the request, proving validation got out of the way.
# -------------------------------------------------------------------------

def test_valid_png_via_path_passes_validation(
    mcp: McpClient, tmp_path: Path,
) -> None:
    """A real PNG on disk must pass all client-side checks. The API will
    reject the bogus flow_step_id (403/404), proving we reached the network
    rather than failing in validation."""
    p = tmp_path / "tiny.png"
    p.write_bytes(TINY_PNG)

    result = _call_upload_raw(mcp, image_path=str(p))
    # The bogus flow_step_id MUST cause an error — but it must be an API-level
    # error, not a client-side validation error. If we see one of our
    # validation codes, the path/sniff/decode pipeline rejected a valid PNG.
    if result.get("isError"):
        # Error envelope may be structured (our code) or raw text (uncaught
        # API exception from client.request). Distinguish by trying to parse.
        text = result["content"][0]["text"]
        try:
            err = json.loads(text)
            code = err.get("code", "")
            assert code not in {
                "INVALID_ARGUMENTS",
                "IMAGE_TOO_LARGE",
                "IMAGE_INVALID_FORMAT",
                "IMAGE_READ_FAILED",
                "IMAGE_FETCH_FAILED",
            }, f"validation rejected a valid PNG: {err}"
        except json.JSONDecodeError:
            # Raw API error message — validation definitely passed.
            assert "Flowlearn API" in text or "stp_validation_only" in text, (
                f"unexpected error text: {text}"
            )
    else:
        pytest.fail(
            f"upload to bogus flow_step_id unexpectedly succeeded: "
            f"{json.dumps(result, indent=2)}"
        )
