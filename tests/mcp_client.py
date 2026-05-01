"""Synchronous JSON-RPC client that drives a stdio-based MCP server as a subprocess.

Designed for tests — one outstanding request at a time, blocking reads.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any


class McpServerError(RuntimeError):
    """Raised when the MCP server crashes or returns an error response."""


class McpToolError(RuntimeError):
    """Raised when a tool call returns isError: true."""

    def __init__(self, tool: str, message: str):
        super().__init__(f"Tool {tool} failed: {message}")
        self.tool = tool
        self.message = message


class McpClient:
    def __init__(self, server_entry: Path, env_overrides: dict[str, str]):
        if not server_entry.exists():
            raise FileNotFoundError(
                f"MCP server entry not found: {server_entry}\n"
                "Run `npm run build` in the package directory first."
            )

        env = {**os.environ, **env_overrides}

        self.proc = subprocess.Popen(
            ["node", str(server_entry)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            bufsize=1,
            encoding="utf-8",
        )
        self._next_id = 0
        self._stderr_lines: list[str] = []

        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, daemon=True
        )
        self._stderr_thread.start()

        self._initialize()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self._stderr_lines.append(line.rstrip())

    def _send(self, msg: dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def _recv(self) -> dict[str, Any]:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        if not line:
            stderr = "\n".join(self._stderr_lines) or "(empty)"
            raise McpServerError(f"MCP server closed stdout. stderr:\n{stderr}")
        return json.loads(line)

    def _request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self._next_id += 1
        rid = self._next_id
        self._send({
            "jsonrpc": "2.0",
            "id": rid,
            "method": method,
            "params": params or {},
        })
        while True:
            msg = self._recv()
            if msg.get("id") == rid:
                if "error" in msg:
                    raise McpServerError(
                        f"MCP error on {method}: {msg['error']}"
                    )
                return msg.get("result")

    def _initialize(self) -> None:
        self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "flowlearn-mcp-tests", "version": "0.1.0"},
        })
        self._send({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        })

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        """Invoke a tool. Returns the parsed JSON the tool produced.

        The MCP server wraps the API response as content[0].text containing
        JSON; this method unwraps that for the caller.
        """
        result = self._request("tools/call", {
            "name": name,
            "arguments": arguments,
        })
        if result.get("isError"):
            raise McpToolError(name, result["content"][0]["text"])
        text = result["content"][0]["text"]
        return json.loads(text)

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                if self.proc.stdin is not None:
                    self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
