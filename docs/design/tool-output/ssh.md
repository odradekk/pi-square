# `ssh`

**Family:** remote · **Scope:** parent only, never exposed to child sessions ·
**Owner:** `src/ssh/tool.ts`, rendered by `src/display/remote-adapters.ts`

**Status:** Implemented.

## Evidence level

Observed on this machine through the production decoration path at 80 columns,
with the four real agent-level profiles: `list`, a failed `connect`, and a
`command` without a session ID.

Not observed: every state that needs an established session. All four
configured hosts refused the handshake from this machine, so `connect`
success, `command` output, `read` cursors, `input`, `interrupt`, and `close`
are derived from the renderer source, not from a run:

- `src/display/remote-adapters.ts:62-71` builds the target from
  `profile/target` for `connect` and from the session ID for every other
  operation.
- `src/display/remote-adapters.ts:78-86` extracts `body.output` from the JSON
  result, so terminal text is meant to replace the raw JSON.
- `src/display/remote-adapters.ts:277-315` builds the `Profiles` and
  `Sessions` record sections and their fields.

Endpoints are replaced by `user@host:22` in this document. Real addresses must
not enter repository documentation.

## Current output

`list` with four profiles and no session. The collapsed body is the raw JSON
result:

```
✓ ⌬ SSH list                                                                 1ms
│    status=success · code=OK · operation=list
│  {"version":1,"status":"success","operation":"list","code":"OK","message":"4
│  SSH profiles; 0
│  sessions","sessions":[],"profiles":[{"name":"profile-a","defaultTarget":"pri
│  mary","targets":[{"name":"primary","endpoint":"user@host:22"}]},{"name":…
└─ …"omissions":{"profiles":0,"targets":0,"sessions":0}}
```

Expanded is structured but key-value based:

```
│    PROFILES ──────────────────────────────────────────────────────────────────
│      profile-a
│        defaultTarget=primary · targets=primary: user@host:22
```

Failed `connect`, where the error body is rendered twice in the expanded
`OUTPUT` section:

```
✗ ⌬ SSH profile-a/primary                                                    0ms
│    status=error · code=SSH_ERROR · operation=connect · profile=profile-a ·
│    target=primary · label=design-evidence
│    {"version":1,"status":"error","operation":"connect","code":"SSH_ERROR","mes
└─   sage":"Timed out while waiting for handshake"}

│    OUTPUT ────────────────────────────────────────────────────────────────────
│    {"version":1,"status":"error",…"Timed out while waiting for handshake"}
│    {"version":1,"status":"error",…"Timed out while waiting for handshake"}
```

`command` without a session ID:

```
✗ ⌬ SSH command                                                              0ms
│    command=uname -a && uptime · status=error · code=INVALID_ARGUMENT ·
│    operation=command
│    {"version":1,"status":"error","operation":"command","code":"INVALID_ARGUMEN
└─   T","message":"command requires a session ID"}
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 80 | The collapsed body renders the raw JSON result, broken across rows at arbitrary characters | C4, C6 |
| 81 | The raw JSON of `list` exposes every configured endpoint as an unstructured blob | C4 |
| 82 | A failed result renders the same JSON error twice in the expanded `OUTPUT` section | C8 |
| 83 | The header has no target for `command`, `read`, `input`, `interrupt`, and `close`; only the machine session ID would be available, and it is not shown | C5 |
| 84 | A metadata row prints `status`, `code`, and `operation` as key-value pairs and repeats the header | C4, C8 |
| 85 | Profile and session records print `defaultTarget=`, `targets=`, `state=`, `command=` as key-value pairs | C4 |
| 86 | Internal fields `omissions`, `version`, and `sshCode` reach the display | C4 |

## Target design

### Header

```
● SSH connect profile-a/primary                                           2.0s
● SSH profile-a uname -a && uptime                                        0.4s
● SSH list                                                                0.0s
```

The title is `SSH`. The target depends on the operation:

| Operation | Target |
|---|---|
| `connect` | `connect profile/target` |
| `command` | the profile label, then the command truncated with `…` |
| `read`, `input`, `secret_input`, `interrupt` | the profile label and the operation word |
| `close` | `close <profile label>` |
| `list` | none |

The machine session ID is never the target. The session is identified by its
profile and its optional user label, which the user chose.

### `command`

The output uses the execution grammar of [bash.md](bash.md): one collapsed
row with the outcome inline, the output only when the entry is expanded, the
`truncated` badge when rows are dropped, and no trailing empty row.

```
● SSH profile-a ls -la /etc | head -30 30 lines · exit 0 · session 2 of 4 [truncated] 0.4s
```

Expanded, the tail keeps the `previewLines` bound:

```
● SSH profile-a ls -la /etc | head -30                        [truncated] 0.4s
│    … 21 earlier lines
│    drwxr-xr-x   2 root root   4096 Aug  4 10:02 ssh
│    -rw-r--r--   1 root root    767 Jul 30 08:11 sysctl.conf
└─   30 lines · exit 0 · session 2 of 4
```

Inline summary cases:

| Case | Row |
|---|---|
| Success | `30 lines · exit 0` |
| Non-zero exit | `12 lines · exit 2` |
| No output | `No output · exit 0` |
| Cursor available | adds `· more output at cursor 4096` |
| Session busy | `A command is already running` |
| Disconnected | `Session is disconnected` |

### `connect`

```
● SSH connect profile-a/primary Connected as user@host:22 · label design… 2.0s
```

The endpoint is shown once, because the user must be able to verify which host
was reached. The host fingerprint is not rendered; verification already
happened before the session existed.

An alternate target that needs the once-per-session endpoint confirmation
carries the `needs-input` badge while the prompt is open.

### `list`

```
● SSH list 4 profiles · no sessions                                       0.0s
```

The profile rows render when the entry is expanded. With sessions, one
`SESSIONS` section is added above the profile rows:

```
│    design-evidence  profile-a/primary  connected  idle 42s
└─   4 profiles · 1 session
```

Raw JSON is never rendered. `version`, `omissions`, `sshCode`, `status`, and
`code` never reach any row.

### Failure

```
● SSH connect profile-a/primary Handshake timed out                       2.0s
```

| Cause | Row |
|---|---|
| Unknown profile | `Unknown profile <name>` |
| Unknown target | `Unknown target <name> in <profile>` |
| Handshake timeout | `Handshake timed out` |
| Host unreachable | `Host is unreachable` |
| Fingerprint mismatch | `Host key does not match the pinned fingerprint` |
| Authentication | `Authentication failed` |
| Missing session ID | `This operation needs a connected session` |
| Session limit | `Session limit reached for <profile>` |
| Expired cursor | `Output cursor has expired` |

The failure body appears exactly once. The raw provider message stays in the
expanded `ERROR` section. Passphrases, key material, and any runtime secret
never enter a row, a detail, a log, or an artifact.

## Acceptance criteria

1. No state renders raw JSON.
2. The header target uses the profile and the user label, never the machine
   session ID.
3. A failure renders its message exactly once.
4. `command` output follows the `bash` output rules, including the one-row
   collapsed entry and the `truncated` badge.
5. `connect` states the endpoint once and never the fingerprint.
6. `list` renders profiles and sessions as aligned rows when expanded, with
   no key-value pairs and no internal fields.
7. Secret material never appears in any state.
8. The model-facing JSON result is unchanged.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.
10. The connected-session states must be confirmed against a real session
    before implementation, because this machine could not establish one.

## Out of scope

- Full-screen terminal emulation, automatic reconnect, SFTP, jump hosts,
  proxies, and forwarding.
- Exposing `ssh` to child sessions.
