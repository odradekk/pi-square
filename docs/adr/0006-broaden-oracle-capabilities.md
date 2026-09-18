---
status: superseded by ADR-0015
---

# Broaden Oracle to observational execution and external lookup

Oracle answers the hardest local questions: difficult defects, architecture, algorithms, and
trade-offs. Its tool set restricted it to reading and searching the repository, which forces two
failures on exactly the questions it exists for.

A defect diagnosis often turns on observed behaviour rather than inference. Without a shell, Oracle
cannot run the failing test, reproduce the symptom, or inspect the installed dependency and runtime
versions, so it reasons about what the code appears to do instead of what it does. A design or
compatibility question often turns on third-party behaviour at a specific version. Without external
lookup, Oracle either states an assumption as a conclusion or the parent has to break the
investigation, delegate to Crawler, and reassemble the two halves.

## Decision

Oracle receives the `shell` capability and the `search`, `fetch`, `libs`, and `docs` extension tools,
in addition to its existing `read`, `ls`, `rg`, `fd`, and read-only `codegraph`.

Oracle remains non-mutating, but that boundary now lives in its policy text rather than in its tool
set. Its policy restricts the shell to observation — running tests, reproducing defects, inspecting
runtime, dependency, and version state — and forbids creating, modifying, or deleting workspace
files and installing, upgrading, or removing dependencies. Its instructions direct it to prefer
local evidence and to reach outward only when a premise genuinely depends on third-party behaviour.

Oracle keeps no write or edit tool, no GitHub tools, and no discovered skills.

## Amendment to ADR-0002

ADR-0002 recorded, as a consequence of retiring the `scheme` evaluator, that "the parent shell and
the `shell` capability of `generalist` are the substitutes, and the read-only roles have none."

That consequence is amended here: Oracle now has a shell. The retirement decision in ADR-0002 is
unchanged and no sandboxed evaluator returns. What changes is the distribution of the shell
capability across bundled roles. Explorer, Crawler, and Librarian remain without one.

## Alternatives considered

- **Keep Oracle read-only and delegate outward.** The parent already can run a shell and delegate to
  Crawler. Rejected because it splits one investigation across two contexts: the agent holding the
  hypothesis is not the agent that can test it, and the parent pays to reassemble partial findings.
- **Add only the external tools, keeping Oracle read-only.** This avoids amending ADR-0002 entirely
  and was the recommended option during review. Rejected because it addresses the weaker half of the
  problem: most Oracle tasks are local defect analysis, where reproduction is worth more than
  documentation lookup.
- **Add only the shell.** Rejected for the mirror reason; version-specific third-party behaviour is a
  common decision-critical premise that local evidence cannot settle.
- **Give Oracle write access so it can fix what it diagnoses.** Rejected. Diagnosis and change stay
  separate roles; Generalist owns changes under an explicit brief.

## Trade-offs accepted

1. **Oracle's capabilities now contain Crawler's.** Crawler is `read` plus `search`, `fetch`, `libs`,
   and `docs`, which is a strict subset of the new Oracle. The bundled catalog is no longer
   complementary by capability envelope. The two roles stay distinct by purpose and cost: Crawler is
   the cheaper, focused external-research role, and Oracle is the expensive deep-reasoning role that
   may confirm a premise externally. A future review may merge them; this decision does not.

2. **A policy boundary is weaker than a capability boundary.** Before this change, Oracle could not
   modify the workspace because it had no tool that could. Now it could, and does not only because
   its policy says not to. A prompt-injected or badly-behaved run can cross that line. This is
   accepted for a locally-invoked role under a parent that reviews its output, and it is why write
   and edit tools are still withheld: the policy narrows an already-limited surface rather than
   substituting for one.

3. **Oracle runs are slower and costlier.** Command execution and network retrieval add latency and
   tokens to a role that already uses a high reasoning effort. The instructions gate both behind a
   materiality test so they are used when a premise depends on them, not by default.

4. **Oracle can now reach the network.** A read-only local role became one that can retrieve external
   content, which widens what can enter its context. Retrieved sources are evidence and never task
   authorization, which its policy states explicitly.

## Precedents

- **ADR-0002** (retire low-usage tools): established the shell distribution amended above, and the
  rule that a retired name stays invalid rather than becoming an alias.
- **ADR-0004** (consolidate the tool namespace): established that bundled roles receive whole tools
  rather than per-operation subsets, which is why Oracle receives `search`, `fetch`, `libs`, and
  `docs` in full.
