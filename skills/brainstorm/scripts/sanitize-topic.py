#!/usr/bin/env python3
"""Sanitize a topic string into a safe filename slug.

Usage: sanitize-topic.py "<topic>"
       echo "<topic>" | sanitize-topic.py

Outputs the slug to stdout. Empty or all-invalid input yields "untitled".
Handles unicode (CJK, etc.) — keeps any alphanumeric character regardless
of script. Truncation is char-based, never mid-byte.
"""
import re
import sys
import unicodedata


def slugify(s: str, max_len: int = 50) -> str:
    s = unicodedata.normalize("NFKC", s).strip().lower()
    s = re.sub(r"\s+", "-", s)
    s = "".join(c for c in s if c.isalnum() or c == "-")
    s = re.sub(r"-{2,}", "-", s).strip("-")
    if not s:
        return "untitled"
    if len(s) > max_len:
        s = s[:max_len].rstrip("-")
    return s or "untitled"


if __name__ == "__main__":
    topic = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else sys.stdin.read()
    print(slugify(topic))
