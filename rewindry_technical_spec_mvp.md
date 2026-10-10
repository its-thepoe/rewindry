# Rewindry — MVP Technical Specification

**Version:** 1.0 · 10 October 2026  
**Status:** Proposed engineering specification; not implemented  
**Companion documents:** `rewindry_mvp_prd_v1_3.md` (product requirements) and `rewindry_implementation_plan_mvp_v1.md` (delivery order).  
**Product:** Rewindry — a local-first, open-source visual timeline of completed coding iterations.

## 0. Reading contract

- This document specifies **how** to implement the approved Rewindry MVP. The PRD specifies **what** to build. When documents disagree about product scope, follow the PRD and log the mismatch before coding.
- Every implementation milestone must include automated tests, observable status, a working demo and evidence against its exit criteria. No placeholder integrations may be labelled supported.
- Proposed internal names, schema, durations and paths below are design decisions for implementation, **not assertions about a shipped product or guaranteed third-party capabilities**.
- **Invariant:** one *completed, changed, recognised agent user turn* produces at most one visible checkpoint; no intermediate writes produce visible dots. Non-agent edits group after inactivity. Source-only checkpoints are valid.
- **MVP is read-only:** do not implement restore, apply patch, revert, checkout, fork, historical execution, code-to-workspace copy, video export, accounts or cloud sync.

## 1. Supported baseline and deliberate limitations

| Area | MVP baseline | Fallback / explicit gap |
|---|---|---|
| Host | macOS user-level installation as first tested target; test a declared macOS version matrix | Linux/systemd-user and Windows startup registration are separate platform tasks; never claim verified until tested |
| Runtime | Supported active Node.js LTS (pin exact major at implementation); TypeScript, ESM | Detect and explain unsupported runtimes |
| Frontend | React application using conventional Vite HTML entry | Frameworks with custom entry handling: standalone history viewer; no promise of overlay |
| IDE/agent | Editor-neutral local file capture; boundary adapters tested separately for Cursor, Claude Code, Codex CLI | Unsupported editor, remote agent, unattached worktree: `Grouped edits`/not observed, not guaranteed one-per-prompt |
| Storage | All **project-owned** data inside `<repo>/.rewindry/` | Only daemon binary, repo registrations, service logs and locks may live in user application-data directories |
| Rendering | Single configured local URL/route and one viewport | Multiple routes, UI-state fixtures, deterministic mock APIs are later work |
| Git | Index locally reachable commits read-only | Missing commit objects/shallow history must be disclosed; Git history cannot recover uncommitted pre-install prompts |

**Important interpretation:** `one turn = one iteration` is only promised for agent editions where *outer-turn start, completion and workspace identity can actually be correlated*. A completion-only event is useful but cannot, by itself, prevent premature manual-idle checkpoint creation. Agent capability must be measured and shown per installed edition.

## 2. System layout

```text
IDE / CLI / coding agent                   Developer editor / shell
  recognised outer-turn hooks                      file writes
           |                                           |
           v                                           v
   hook adapter (tiny; fail-open)             workspace observer
           |                                           |
           +------------------+------------------------+
                              |
                       user-level daemon
                 [event journal + turn manager]
                              |
                  [checkpoint finaliser]
                       |              |
           repository .rewindry/    [Git importer]
             objects + manifests        |
             index.sqlite              |
                       +--------------+
                              |
                   read-only localhost API
                        |            |
              Vite dev overlay     standalone viewer
                        ^
                 screenshot worker
               (Playwright, dev-only)
```

### Package boundaries (proposed workspace)

```text
rewindry/
  packages/
    cli/                    # setup, status, doctor, uninstall, viewer
    core/                   # rules, digest, event types, state machine
    store/                  # immutable blobs/manifests, SQLite, migrations
    daemon/                 # watcher, event ingest, service lifecycle
    adapters/               # Cursor, Claude Code, Codex CLI adapters
    git/                    # read-only commit indexing
    vite-plugin/            # apply:'serve', dev-only overlay injection
    capture/                # Playwright screenshot queue/verification
    viewer/                 # React UI, timeline, code browser, copy
    test-fixtures/          # fake agent, fake dev server, sample repos
  examples/vite-react/
  docs/
```

Package boundaries should be a single pnpm/npm workspace if practical; avoid independent services or elaborate plugin registries until a real extension use case appears. Use narrow TypeScript interfaces between the modules.

## 3. Installation and lifecycle contract

### User-facing command

```sh
npx rewindry@latest setup
```

It must be a **single invocation** that completes setup. It may ask for permissions and must make truthful claims about capabilities. It is not acceptable to require developers to run `rewindry watch`, `rewindry init` or start a second terminal every day.

### Setup flow

1. **Preflight:** find repo/workspace root, operating system, Node version, package manager, Git status, Vite configuration and installed supported agent editions. Do not assume a monorepo root is the correct frontend application.
2. **Plan before modification:** show specific files/configurations the installer intends to change, capability limitations and whether OS startup permission is needed; request approval once for required invasive changes.
3. **Install stable binaries:** install a pinned project package for the development adapter, plus a versioned stable agent runtime in user application data. **Never register an ephemeral `npx` cache path** with the OS service manager.
4. **Register one user-level daemon:** reuse an existing healthy Rewindry daemon on that machine; add repository registration rather than starting one daemon per project. Never require elevated/system-wide installation.
5. **Configure adapters:** patch only agent-supported hook configs; preserve existing hook order and handlers. If a provider offers one exclusive callback (e.g. Codex `notify`), chain through a reversible, tested dispatcher only with consent, or report limited integration. The dispatcher must not swallow the previous callback.
6. **Configure Vite:** install a development-only plugin using a parsed AST/config-aware change where safe. Do not rewrite unknown Vite configuration formats blindly; use standalone viewer fallback when safe patching isn't possible. Prefer not to alter the existing `dev` script.
7. **Create `.rewindry/`:** config, object storage and index; add user-approved `.gitignore` rules. Snapshot the baseline eligible working state; begin read-only Git indexing.
8. **Verify:** daemon heartbeat, change observer, hook test where possible, working dev plugin registration (if dev server running), and secure local API. Print distinct statuses for Source capture / Agent boundary capture / Visual capture.
9. **Rollback partial setup:** restore exactly the files changed by the installer if setup aborts; leave pre-existing user changes untouched. Logs must explain skipped changes.

### Ongoing lifecycle

- OS login resumes the **user-level** daemon; after sleep/wake or a crash, it rescans registered projects, reconciles digests and marks observational gaps.
- Exit/restart of IDE, dev server, terminal or agent does not require manual restart.
- Source capture and agent-hook reception work even when Vite is stopped. Screenshots require a reachable, compatible **local** dev server.
- A per-project lock or SQLite-based lease prevents competing writers. The daemon performs bounded async work and does not block IDE hooks.
- `rewindry status` and `rewindry doctor` are diagnostics, **not daily operating requirements**.
- `rewindry uninstall` removes *only its own* hooks, Vite integration and service/project registration; it retains `.rewindry/` history unless the user explicitly elects to delete it.
- Rerunning setup is idempotent; upgrade and downgrade paths preserve the source history.

### Proposed daemon service

macOS: user `launchd` LaunchAgent pointing to the stable installed runtime, running under the current user. Linux: user `systemd` service once separately validated. Windows: user-level startup task or service only after suitable non-elevated lifecycle tests. Registration metadata may live outside the repo, but **checkpoint data may not**.

## 4. Core terminology and provenance

- **Raw observation:** filesystem event, hashing result or agent lifecycle event. Never creates a visible timeline dot by itself.
- **Active turn:** a uniquely correlated *outer user prompt* from a supported provider in a registered workspace.
- **Visible iteration / checkpoint:** immutable manifest of the complete eligible project source tree after a completed changed turn or grouped manual/unattributed period. One dot in the UI.
- **Baseline:** initial working state on setup, visually different from later iterations; not misrepresented as an agent prompt.
- **Git revision:** imported reachable commit, separately typed and rendered; not an agent iteration.
- **Visual:** screenshot associated with one exact checkpoint manifest, route and viewport.
- **Confidence:** `confirmed` only for tested lifecycle correlation; `grouped` for quiet-time fallback; `overlap` for mixed concurrent writes.

Suggested checkpoint kinds: `baseline`, `agent_turn`, `manual_group`, `unattributed_group`, `git_commit`.

## 5. Normalised lifecycle protocol

Adapter callbacks send **events**, never private agent checkpoint databases, source blobs or prompt/transcript text. Use an append-only local journal and a tiny hook-forwarder executable that can exit without blocking the host.

```ts
type Provider = 'cursor' | 'claude-code' | 'codex-cli' | 'unknown';
type TurnStatus = 'completed' | 'failed' | 'aborted' | 'unknown';

type AgentEvent = {
  protocolVersion: 1;
  eventId: string;                 // stable dedupe key or derived hash
  eventType: 'outer_turn_started' | 'outer_turn_finished';
  provider: Provider;
  adapterVersion: string;
  occurredAt: string;              // ISO timestamp
  workspaceId: string;             // canonical registered worktree identity
  hostSessionId?: string;
  hostTurnId?: string;
  status?: TurnStatus;              // mandatory for finished events
  boundaryQuality: 'paired' | 'end_only' | 'unverified';
};
```

**Never assume missing turn IDs can be manufactured reliably across unrelated processes.** When the provider has no stable turn identifier, the adapter may correlate a start and terminal event only if a scoped single-active-turn constraint and ordering can be demonstrated in tests; otherwise mark `unverified`.

### Provider adapter mapping and verification requirements

| Provider | Candidate supported signals | Important risk | MVP support bar |
|---|---|---|---|
| Cursor IDE Agent | `beforeSubmitPrompt` and `stop` | Distinguish outer prompt vs continued loop/subagent; incomplete or changed payload IDs | Real paired-hook test, stable workspace/session correlation, duplicate/abort handling |
| Claude Code | `UserPromptSubmit`, `Stop`, `StopFailure` | Ignore `SubagentStop`; stop hooks may continue run; user interruption can lack `Stop` | Validate complete user-turn stop, status and correlation in supported editions |
| Codex CLI | `notify` `agent-turn-complete` (end-only in published config) | No universal start signal from `notify`; source idle may create dots *before* completion | Label `end_only` and **do not claim exact one-per-turn support** until a proven start/correlation mechanism exists |
| Other / unknown | Filesystem observer only | No reliable prompt boundary | Group by inactivity, label `Grouped edits` |

Hook configuration is **read-modify-write with backups** and never clears other tools' handlers. Hook failures must be fail-open and low latency. Do not store raw prompt content or assistant responses as part of Rewindry history.

### Local event transport

- Prefer restricted-permission Unix domain socket on macOS/Linux (or loopback endpoint with short-lived bearer token); Windows may require a named-pipe equivalent. API accessible only to the current user.
- Validate message schema, size limits, path and origin identity. Reject events outside registered roots.
- Hook-forwarder writes small event payloads, retries briefly on a transient daemon restart then exits successfully. Do not block the coding agent or prevent a prompt from submitting/completing.
- Events persist before state transitions; deduplicate via `(provider, workspaceId, eventId)` and completed turn key.
- Diagnostics show unsupported hook versions and last successful event time.

## 6. Turn manager state machine

Maintain an event-ordered state per `(workspaceId, provider, hostSessionId, hostTurnId or provisional scope)` and a workspace-level list of active turn leases.

```text
IDLE
  -- paired outer-turn start --> AGENT_ACTIVE
AGENT_ACTIVE
  -- writes --> AGENT_ACTIVE   [observe changes, no visible checkpoints]
  -- completed finish --> SETTLING
  -- failed / cancelled --> INCOMPLETE  [diagnostic only]
SETTLING
  -- stable final tree + changed --> COMMITTED_CHECKPOINT [one visible dot]
  -- stable final tree + unchanged --> NO_OP [no dot]
  -- source changes / conflicting active turn --> WAIT / mark overlap
INCOMPLETE
  -- timeout/reconcile --> CLOSED_UNKNOWN [no fake successful dot]
IDLE
  -- local unowned write --> GROUP_PENDING
GROUP_PENDING
  -- another write --> GROUP_PENDING [reset 15s timer]
  -- paired outer-turn starts --> FLUSH_OR_HOLD [preserve pending manual pre-turn changes]
  -- 15s quiet --> COMMITTED_GROUP_CHECKPOINT [one visible dot]
```

### Non-negotiable finalisation rules

1. **Suppression:** no manual idle timer may finalise a checkpoint while a **known active** agent turn affects that checkout. A 60-second pause inside one turn still yields zero intermediate dots.
2. **Completion:** after a confirmed outer-turn end, wait for all observed writes to quiesce (short settling window, e.g. 1–3 seconds), compute the final eligible manifest and compare with its parent. If unchanged, emit nothing.
3. **Deduplication:** unique index on `provider + workspace + host session/turn identity` where available. Duplicate stop hooks, retries or process restarts must not duplicate dots. For events without a stable ID, confidence stays unverified and event replay must be idempotent on the journal sequence.
4. **Subagents:** subagent completion, file-edit notifications, test commands and assistant-message callbacks are not outer-turn completion.
5. **Failed/aborted turn:** retain a diagnostic/recovery record if needed, but no normal completed-agent dot. A subsequent manual edit must not be silently attributed to the failed prompt.
6. **Missing finish:** a stale active turn becomes `status_unknown`, with observational-gap messaging; never silently turn it into several purportedly completed prompts. A deliberate, explicitly labelled grouped-edits fallback can be offered after reconciliation.
7. **Concurrent agents:** snapshot reflects the *shared checkout state*, not proof of exclusive ownership. Mark `overlap` and avoid falsely attributing individual files; do not guarantee distinct screenshot fidelity if one agent writes during the other's capture.
8. **Cross-turn boundaries:** for back-to-back prompts, settle the first before attributing later writes, when the provider exposes reliable ordering; otherwise mark ambiguous rather than claiming a verified first-turn screenshot.
9. **Manual grouping:** use **15 seconds of eligible-write inactivity** as a configurable first default; origin is `manual_group` only when independently established, else `unattributed_group`.
10. **No-change turns:** a user prompt that makes no net eligible change creates no visible dot.

### Example run: one dot

```
13:00:00 outer_turn_started (Cursor, Turn A)
13:00:01 writes Dashboard.tsx
13:00:10 writes dashboard.css
13:00:40 edits Dashboard.tsx again
13:01:10 writes icon.svg
13:01:45 outer_turn_finished (Turn A, completed)
13:01:47 source stable; manifest differs from parent
13:01:47 CHECKPOINT agent_turn / A published (one dot)
13:01:48 screenshot queued (only if dev preview is active)
```

There must be **no** visible checkpoint at 13:00:10 or 13:00:40.

## 7. File observer and immutable source storage

### Eligibility and isolation

- Watch registered project roots and known eligible paths; exclude `.rewindry/`, `.git/`, `node_modules/`, build output, generated assets, secrets, environment/config credentials and oversized binaries by default.
- Config-driven allowlist/denylist; ignore patterns and symlink safety checked before reads. Do not follow symlinks that escape the registered root.
- Worktrees are **distinct workspace IDs**. Only worktrees actively registered and watched have coverage; discovering a linked worktree is not the same as observing it.
- On filesystem overflow/missed-event suspicion, rescan eligible files and record a capture-gap status.
- Treat atomic editor saves (temp file + rename), deletes and changes across folders as ordinary tree changes; never infer the application state from a single changed file alone.

### Manifest and object strategy

- Content-addressed objects `objects/<first-two-hex>/<sha256>`; hash exact eligible file bytes; store compressed content if useful, with a stable codec identifier.
- A checkpoint is a canonical, deterministically ordered manifest of **every eligible file** at the end of the iteration, mapping relative path, mode, size and blob digest. Manifest itself receives a SHA-256 digest. This reconstructs source for code inspection, including unchanged files without duplicating bytes.
- Write object to temporary file, flush, atomically rename, then write manifest and commit index transaction. A checkpoint isn't visible until its referenced objects are verified.
- Build digest must be computed over eligible files; omitted secrets and environment data mean screenshot fidelity is **source association**, not proof of deterministic runtime output.
- Diff against the prior comparable checkpoint using path sets and blob digests; Git commits use Git's revision graph rather than pretending to be linearly related to local turns.
- Immutable references; corruption or missing blobs become `unavailable`, not fabricated content. Background garbage collection must preserve all blobs reachable from retained manifests.
- Background hashing, rate limits and size budgets avoid blocking the editor.

### Suggested project directory

```text
my-project/
  .git/
  src/
  package.json
  .rewindry/
    config.json
    index.sqlite
    manifests/<checkpoint-id>.json
    objects/ab/<sha256>
    previews/<checkpoint-id>/<route-viewport>.webp
    journal/events.jsonl
    cache/
    tmp/
```

All persistent **project history** is under `.rewindry/`. The SQLite index must be rebuildable from immutable manifests and an event journal as far as possible. Include format/schema version in each manifest.

## 8. Database model

Prefer SQLite with WAL while daemon runs; use prepared queries and explicit transactions. Conceptual schema (types may be adjusted during implementation with versioned migrations):

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  relative_identity TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  capture_state TEXT NOT NULL
);

CREATE TABLE agent_turns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_key TEXT,
  host_turn_key TEXT,
  start_event_id TEXT,
  finish_event_id TEXT,
  state TEXT NOT NULL,
  boundary_quality TEXT NOT NULL,
  began_at TEXT,
  finished_at TEXT,
  CHECK (state IN ('active','settling','completed','failed','aborted','unknown'))
);
CREATE UNIQUE INDEX ux_agent_turn_identity
  ON agent_turns(workspace_id, provider, session_key, host_turn_key)
  WHERE host_turn_key IS NOT NULL;

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_id TEXT,
  tree_digest TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  agent_turn_id TEXT UNIQUE,
  git_oid TEXT,
  attribution TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_state TEXT NOT NULL DEFAULT 'available'
);
CREATE INDEX ix_checkpoint_workspace_time ON checkpoints(workspace_id, created_at);

CREATE TABLE checkpoint_files (
  checkpoint_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_digest TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  PRIMARY KEY (checkpoint_id, path)
);
CREATE INDEX ix_checkpoint_files_path ON checkpoint_files(path);

CREATE TABLE previews (
  id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL,
  route TEXT NOT NULL,
  viewport_key TEXT NOT NULL,
  status TEXT NOT NULL,
  image_path TEXT,
  verified_tree_digest TEXT,
  failure_reason TEXT,
  captured_at TEXT,
  UNIQUE(checkpoint_id, route, viewport_key)
);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT,
  event_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
```

**Migration constraint:** support creating fresh stores, upgrading compatible stores and refusing unknown newer schemas with a readable error (rather than corrupting them). Imported Git commit records can use a separate `git_commits` table with all parent edges rather than forcing multiple parents into `checkpoints.parent_id`.

## 9. Visual capture — exact checkpoint association

The browser screenshot is a **record of one finalised iteration**, not a recording of all edits.

### Pipeline

1. Turn/group finaliser commits checkpoint `C` with immutable `tree_digest=D`.
2. If a configured Vite dev preview is **already active** and permitted, enqueue at most **one primary visual job** keyed by `(C, route, viewport)`; a bounded retry does not create new jobs or dots.
3. Wait for the dev-server readiness signal and HMR settle (including page-load and selected fonts-ready checks). The UI overlay must be hidden or excluded from the screenshot.
4. Re-hash the eligible source tree immediately **before** capture. If different from `D`, record `source_changed` and mark the checkpoint visual unavailable; do not display the latest UI as the old checkpoint.
5. Browser navigates to the configured local URL, uses a fresh isolated context and captures screenshot with fixed viewport, device scale and colour scheme; await configured readiness and avoid clicking app controls or hitting production services.
6. Re-hash immediately **after** the image is taken; attach only if both hashes equal `D`, the dev preview belongs to the intended registered workspace and route, and no readiness error was observed. Persist as `.webp` or `.png` plus metadata. Otherwise discard image and record an explicit status.
7. Handle rapid sequential turns with back-pressure. If current source has moved on, old source-only dots stay navigable; **MVP must not execute earlier source to repair missing images**.

**Limits of verification:** Matching source digests does not guarantee the pixels are deterministic if the app uses remote APIs, local storage, date/time, random data or unseen environment files. The UI labels a capture `Recorded during development`, not a perfect deterministic reconstruction. Preview setup must support explicit local/test data assumptions.

### Capture statuses

`pending`, `recorded`, `waiting_for_preview`, `source_changed`, `preview_unavailable`, `readiness_timeout`, `blocked_by_configuration`, `unsafe_remote_dependency`, `capture_failed`.

### Screenshot settings (MVP)

- One explicit route, e.g. `/`, at one fixed viewport (default proposal 1440×900; configurable).
- Only `127.0.0.1`/localhost URLs in default setup; no production websites, accidental external DNS requests or automatic cloud upload.
- Browser session uses no persisted authentication unless developer explicitly configures safe local test state.
- Fixed timeout with retry budget; missing visual does not block the source checkpoint.
- `captureEveryFinalisedCheckpoint=true` when compatible dev server is available, **never** capture intermediate writes.

## 10. Git history import (read-only)

- Query locally reachable refs/commit parents using read-only Git commands; preserve commit OIDs, parents, timestamps and changed paths.
- A commit becomes a **Git history node**, not a completed agent turn. UI must distinguish Git and local checkpoints.
- Lazily retrieve source blobs/diff from Git when viewing commits. If an object disappears after GC/rebase, display `source unavailable` and an appropriate cause. Optional materialisation into `.rewindry/` can be added when required for offline portability.
- Shallow clones and missing ancestry are reported, not guessed. Do not run `git fetch` by default or change branches/working tree.
- Git repository itself may be absent: local snapshots still work, no Git importer.
- If Git histories branch/merge, preserve graph parents in expanded view; the compact timeline can show only selected branch/context and must not invent a single total order of ancestry.

## 11. Local API, browser overlay and code copy

### API boundary

The agent service offers read-only HTTP endpoints on **loopback only** for the viewer. Use a per-session access token/capability, restrictive Origin policy, Host validation and path sanitisation; avoid a public network interface. Mutation endpoints are not present in MVP.

Illustrative routes (not an already published API):

```text
GET /v1/status
GET /v1/workspaces/:id/checkpoints?cursor=...&limit=...
GET /v1/checkpoints/:id
GET /v1/checkpoints/:id/files?path=...
GET /v1/checkpoints/:id/diff?base=...&path=...
GET /v1/checkpoints/:id/previews?route=...
GET /v1/previews/:id/image
GET /v1/events/stream             # SSE with read-only checkpoint/status notifications
```

For every route: validate workspace access, checkpoint ID, canonical path inside approved manifest, size limits and excluded/private paths. Never use an arbitrary filesystem path from URL as a file read. Escape displayed source; do not interpret code as HTML. Copy uses the selected immutable blob or diff, **never** the current workspace file.

### Browser overlay

- A Vite plugin with `apply: 'serve'` and controlled `transformIndexHtml` injection creates the hidden trigger in supported browser development previews. When a framework bypasses standard HTML transformation, fall back to standalone viewer.
- Default bottom-centred compact pill, one dot per visible iteration. Hide/show keyboard shortcut and click trigger. Dot click displays **recorded image**, not live historical code execution.
- Hover/focus thumbnail and metadata: time, kind, provider/confidence, changed-file count, visual status. Expansion opens read-only file/code/diff drawer with Copy selection/file/diff.
- Play/Pause advances finalised checkpoints like a slideshow (suggested default one frame/second); source-only dot gets an explicit placeholder.
- Accessibility: keyboard Left/Right, Home/End, Space, Escape; focus rings, screen-reader labels, reduced-motion support, touch-friendly hit areas and responsive scrolling/virtualisation for 1,000+ dots.
- Support one-click standalone viewer when dev preview is stopped; source-only history must still be browsable.

### Network exposure prevention

A Vite dev server may run on a public/LAN interface. **Do not blindly proxy historical source endpoints through Vite.** Keep the local history service bound to loopback; block requests from non-loopback contexts and enforce an explicit browser-origin allowlist/capability handshake. If safe local access cannot be established, hide source-copy features in the overlay and launch a separate secured loopback viewer instead. Ensure Rewindry is absent from production output and from build-time bundle entrypoints.

## 12. Configuration file (proposed)

```json
{
  "schemaVersion": 1,
  "workspace": { "root": ".", "displayName": "my-project" },
  "capture": {
    "manualQuietMs": 15000,
    "agentSettleMs": 2000,
    "include": ["src/**", "public/**", "package.json", "*lock*"],
    "exclude": [".rewindry/**", ".git/**", "node_modules/**", "dist/**", "**/.env*", "**/*secret*"],
    "maxFileBytes": 5242880
  },
  "agents": { "cursor": "auto", "claudeCode": "auto", "codexCli": "detect" },
  "git": { "indexReachableHistory": true, "fetchRemote": false },
  "preview": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:5173",
    "route": "/",
    "viewport": { "width": 1440, "height": 900 },
    "timeoutMs": 10000
  },
  "storage": { "maxLocalBytes": 2147483648 },
  "privacy": { "telemetry": false, "remoteUpload": false }
}
```

Schema defaults are a starting point; do not claim glob patterns cover every secret. Treat rules as a best-effort barrier plus an explicit warning when files might contain credentials. User-config changes must be validated and versioned. Only user-owned project configuration and history live inside `.rewindry/`.

## 13. Status, failures and recovery

Display truthfully:

| Condition | User-facing status |
|---|---|
| Watcher running, no known hooks | `Source capture active · Agent turns unverified` |
| Supported paired lifecycle hooks live | `Source capture active · Agent turns detected (provider/version)` |
| Service registration refused | `Limited capture: development sessions only` |
| Dev server stopped | `Visual capture waiting for local preview` |
| Screenshot digest mismatch | `Source saved · visual unavailable (source changed)` |
| Hook completion failed/interrupted | `Incomplete/unknown turn; no completed-turn dot` |
| Overlapping agent writes | `Overlapping activity · source attribution uncertain` |
| Workspace moved without registration update | `Workspace needs re-registration` |
| Storage full | `Capture paused: insufficient storage; existing checkpoints safe` |

Crash recovery: replay validated journal records and rebuild indexes; reconcile current tree without inventing historical intervals. Recover temp files/unfinished transactions and preserve all complete manifests. A corrupted object never silently resolves to the current source code.

## 14. Observability and privacy

- Local structured logs: service start/stop, workspace IDs, boundary confidence, checkpoint counts, capture timings, failure reasons and schema migration results.
- Do **not** record full user prompts, transcripts, secrets, file contents or screenshots in diagnostic logs. Source and screenshot payloads live only in their authorised repository store.
- Health checks, process uptime, last observed edit, last completed turn, last visual capture, queue depth and storage use available through `rewindry status` / `rewindry doctor`.
- Telemetry off by default. No remote requests except user-approved package installation or application dev-server requests.
- Log rotation and local retention limits for operational daemon logs outside repository.

## 15. Non-functional requirements and performance budgets

Targets to validate on representative fixtures (not production measurements):

- One changed recognised turn with 20–100 writes and a 60-second pause -> **exactly one** dot, final eligible tree only.
- No additional perceived latency imposed on agent execution by hook forwarding; hook scripts must fail open under unavailable-daemon conditions.
- After settled completed turn, persist the source checkpoint promptly (aim p95 <3 seconds for medium fixture repos, excluding very large assets).
- Cached screenshot dot navigation perceived p95 <=250 ms for test fixtures; fetch thumbnails lazily.
- No source file modified by viewing, seeking, copying or playback.
- Bounded CPU and memory while idle; no repeated rehash of entire repo without reason.
- Configurable storage threshold; warn before reaching quota and prioritise source manifests over images.
- Test across slow disks, frequent file changes, restart, process kill, sleep/wake and overlapping agents.

## 16. Security constraints and red-team tests

- Exclude known secrets and generated/large directories by default; document that exclusion rules cannot detect secrets hidden in normal source files.
- Refuse path traversal, symlink escape, unauthorised cross-origin access, remote bind, oversized API responses and ambiguous repo ownership.
- Keep browser source viewer as escaped plain text, with restrictive content security and no remote HTML execution.
- No write-to-project endpoints or unsafe Git commands; no external cloud services, auto-sharing or remote agent access.
- Setup/uninstall must preserve existing configs and not override project tooling. Check for shell injection in workspace paths and injected hook commands.
- Browser screenshot worker should not inherit production secrets or login cookies by default; configure preview fixtures explicitly.

## 17. Required test fixtures and acceptance mapping

### Unit / property tests

- Canonical path policy, symlinks, ignore patterns, content digests, deterministic manifests, event idempotence, state machine transitions, quiet timers and checkpoint deduplication.
- Simulate 100 writes within one paired turn including 60-second idle, self-correction, duplicate finish and no-change finish.
- Simulate manual burst, manual/agent overlap, unknown agent and stale turn.

### Integration tests

- SQLite transactions, power loss before index commit, corrupted/missing blobs, replays after restart, Git merge/shallow clone/history import, filesystem rename/delete.
- Real agent edition/version probes for Cursor, Claude Code and Codex CLI; record fixtures and capability results. Do not advertise untested editions.
- macOS user-agent registration/upgrade/uninstall, permissions denied, renamed/moved repo, OS sleep/wake. Platform-specific tests for Linux/Windows when supported.
- React/Vite dev-only plugin, HMR readiness, no production output, screenshot pre/post source digest rejection, no dev server.

### End-to-end test journeys

1. **Install:** one command -> agent active -> close setup terminal -> edit manually -> one grouped dot after quiet period.
2. **Agent:** prompt -> 20–100 writes -> long pause -> self-correct -> complete -> one agent dot and one capture attempt.
3. **Second prompt:** run another changed prompt -> exactly one additional dot.
4. **Visual:** run normal `npm run dev` -> screenshot captured -> open bottom pill -> scrub/play -> copy historical file -> verify source tree unchanged.
5. **Offline visual:** stop dev server -> complete turn -> source-only dot, no fabricated image.
6. **Git:** install on repo with old commits -> Git nodes in source history, not incorrectly labelled as AI prompts.
7. **Safety:** CI/build runs -> no timeline code, API or history in production output.
8. **Resilience:** kill agent mid-turn -> restart -> show unknown gap, no false completed dots, persisted checkpoints intact.

Map all 25 product acceptance criteria in PRD v1.3 to named test cases and attach evidence in the implementation plan. Release fails if a declared supported integration violates the one-turn rule or if any browser action writes to the current project.

## 18. Decisions needing explicit engineering evidence

1. Whether Cursor on tested editions exposes adequate stable identity for concurrent conversations; if not, scope to one active run per workspace and disclose ambiguity.
2. Whether Codex CLI can provide or derive a **reliable start boundary** through a supported public mechanism; completion-only `notify` is insufficient for the exact policy.
3. How to ensure screenshot HMR readiness when the dev server is busy and runtime content is dynamic. Missing screenshot is preferable to a wrong one.
4. The first official macOS versions and Node LTS major; list versions in test/release docs, not broad universal claims.
5. Default blob/image retention after measurement and whether Git nodes are lazy references or fully materialised source.
6. Whether Vite configuration can be changed safely on each supported template; no regex-only edits of unknown configs.
7. How to handle manual edits during active agent turns: retain combined snapshot with explicit overlap, do not attribute confidently.

## 19. Official implementation references (checked 10 October 2026)

- Cursor hooks: https://cursor.com/docs/hooks — `beforeSubmitPrompt`, `stop`, distinct agent/subagent events; some events vary by host.
- Claude Code hook reference: https://code.claude.com/docs/en/hooks — per-turn `UserPromptSubmit`, `Stop`, `StopFailure`; stop may not fire on user interruption.
- Codex CLI advanced configuration: https://developers.openai.com/codex/config-advanced — `notify` receives `agent-turn-complete` with `turn-id`, `thread-id` and `cwd`; published notifier is completion-only.
- Vite plugin API: https://vite.dev/guide/api-plugin.html — `apply:'serve'`, `configureServer` and `transformIndexHtml` (not universal for framework-owned HTML entrypoints).
- Playwright screenshot guide: https://playwright.dev/docs/screenshots
- Git worktree reference (future work; not historical execution in MVP): https://git-scm.com/docs/git-worktree

**Final implementation rule:** preserve accuracy above coverage. A source-only or `Grouped edits` checkpoint is an acceptable honest result; an incorrectly labelled completed agent turn or mismatched historical screenshot is not.
