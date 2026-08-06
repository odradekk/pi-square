---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
license: MIT (Copyright (c) 2026 Matt Pocock) — complete terms in ../LICENSE
---

Delegate to a **background sub-agent** — `subagent_delegate` with `mode: bg` — so you keep working while it reads. It notifies you on completion; don't poll for it.

Use `agent: generalist`, which can both research and write the output file in step 2. Use `agent: crawler` instead when you only want the findings reported back and you will write the file yourself — crawler is the stronger external-research specialist but is read-only.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
