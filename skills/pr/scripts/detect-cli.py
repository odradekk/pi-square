#!/usr/bin/env python3
"""Detect availability and auth state of `gh` (GitHub CLI) and `glab` (GitLab CLI).

Usage: detect-cli.py
Output: JSON to stdout, e.g. {"github": "authenticated", "gitlab": "not_installed"}

Statuses:
  authenticated     — CLI installed and logged in.
  installed_no_auth — CLI installed but not authenticated.
  installed_error   — CLI installed but reports an error other than auth (network, TLS, etc.).
  not_installed     — CLI executable not on PATH.
"""
import json
import shutil
import subprocess

AUTH_PATTERNS = (
    "not logged in", "no accounts", "not authenticated",
    "unauthorized", "login required", "you are not",
)
NETWORK_PATTERNS = (
    "could not resolve", "connection refused", "connection timed out",
    "network is unreachable", "tls handshake", "ssl",
    "502", "503", "504",
)


def detect(cli: str) -> str:
    if shutil.which(cli) is None:
        return "not_installed"
    try:
        result = subprocess.run(
            [cli, "auth", "status"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (subprocess.TimeoutExpired, OSError):
        return "installed_error"

    if result.returncode == 0:
        return "authenticated"

    output = ((result.stdout or "") + (result.stderr or "")).lower()
    if any(p in output for p in NETWORK_PATTERNS):
        return "installed_error"
    if any(p in output for p in AUTH_PATTERNS):
        return "installed_no_auth"
    return "installed_error"


if __name__ == "__main__":
    print(json.dumps({"github": detect("gh"), "gitlab": detect("glab")}))
