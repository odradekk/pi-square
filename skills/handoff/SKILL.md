---
name: handoff
description: Compact the current conversation into a handoff document so a fresh agent can pick the work up. Use when the user asks to hand off, resume later, switch sessions, or summarize the conversation for continuation.
---

# Handoff

Write a handoff document summarizing the current conversation so a fresh agent can continue the work. Save it to the OS temporary directory — never the current workspace.

Include a "suggested skills" section listing skills the next agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information — API keys, passwords, tokens, personally identifiable information.

If the user passed arguments to the skill invocation (`/skill:handoff "<focus>"`), treat them as a description of what the next session will focus on and tailor the document accordingly.
