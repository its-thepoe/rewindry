# Rewindry — MVP Product Requirements Document

**Version:** 1.3  
**Date:** 10 October 2026  
**Status:** Proposed MVP scope; not implemented  
**Product name:** Rewindry  
**Delivery:** Open-source, local-first npm setup tool, user-level capture agent, development-only timeline  
**Source:** Updates Rewindry MVP PRD v1.2. Complete implementation-ready MVP specification (not an addendum).
**Changes in v1.3:** Agent turn-based checkpoint finalisation; manual idle grouping; adapter requirements; verified final-frame screenshot scheduling; updated edge cases and acceptance tests.  
**Primary checkpoint policy:** One completed AI-agent prompt/turn = one visible iteration; edits outside known agent turns group after inactivity.
**Naming:** Public npm/GitHub/domain and trade-mark availability must be checked before release.

## 1. Executive summary

Rewindry is an open-source, local-first visual history tool. It automatically records coherent code states and, when a compatible local development preview is available, screenshots of how the application looked at those states. Developers reveal a small floating dot timeline at the bottom of the development preview, play or scrub through recorded designs, inspect historical diffs, and copy code. The MVP is **read-only**: no restore, revert, fork or historical execution.

**MVP promise:** **Install once. Complete a prompt. See one new iteration when the code changes.** Handwritten edits are also captured after a period of inactivity. The experience must remain passive after one-time setup.

### Authoritative iteration policy

1. **Agent-driven edits:** One visible iteration is created only when a distinct **AI-agent user prompt/turn has finished**, and only if its final eligible source state differs from the preceding recorded state. All writes, saves, tool calls, retries and self-corrections *within* that turn are internal activity, **not separate timeline dots**.
2. **Non-agent edits:** Eligible edits outside a known active agent turn are grouped into one visible manual iteration after a configurable quiet period (initial proposal: **15 seconds**). Later manual work separated by another quiet period becomes another iteration.
3. **Unrecognised agents and unattributed writes:** Source changes remain observable, but the filesystem alone cannot distinguish human edits from unknown agents or prove prompt boundaries. The tool uses inactivity grouping and labels ambiguous activity **Grouped edits** (not a confirmed manual edit or completed prompt). Where an explicit integration establishes no agent is active, it may display **Manual iteration**.
4. **Visual capture:** Queue one visual capture attempt **after** the visible checkpoint is finalised, not during intermediate agent writes; a screenshot is accepted only when its source association is verified. Dev-server absence produces a truthful source-only checkpoint.

The local user-level watcher operates independently of a dev server; completion adapters supply prompt boundaries where supported. The bottom overlay and new screenshots are development-only. Git history can supply older *commit states*, not historic uncommitted prompt-by-prompt iterations or guaranteed screenshots.

## 2. Problem

Frontend developers and design engineers iterate repeatedly, often with Cursor, Codex, Claude Code and other coding agents. A version that looked better can disappear after the next agent edit. Git typically contains deliberate commits rather than every short-lived visual direction. Screen recordings show pixels but rarely link frames to the exact files behind them. Manually saving screenshots and checkpoints interrupts the work. A simple file watcher also gets iteration boundaries wrong: one agent prompt can produce dozens of writes separated by long pauses.

The MVP helps developers review the visual progression of their work without committing each experiment, operating a recorder, or remembering to start a second tool. It must honour the developer's mental model of one completed prompt as one iteration.

## 3. Target users and main job

- **Primary:** Frontend developers, design engineers and designers building websites/apps with code or local coding agents. *“Let me replay the different UI directions I tried today and inspect the code behind one I liked.”*
- **Secondary:** Developers reviewing a regression or design iteration. *“When did this UI change, and what source changed?”*
- **Not an MVP persona:** A production deployment viewer, remote-only agent operator, collaborative design review platform or full code backup/restore user.

## 4. Scope decisions

| Feature | MVP decision | Meaning |
|---|---|---|
| One-command setup | **Must have** | Installs watcher and configures supported agent lifecycle adapters where approved; no daily Rewindry command |
| Background source observer | **Must have** | Monitors eligible local writes but does **not** promote every edit to a visible iteration |
| Completed agent-turn checkpoint | **Must have for declared integrations** | Exactly one eligible visible checkpoint at turn completion; intermediate writes hidden |
| Manual idle checkpoint | **Must have** | Non-agent changes grouped after a configurable idle window |
| Agent lifecycle integration | **Must have for declared agent/edition support** | Detect prompt start/end when supported; event sources are not equivalent across editions |
| Source-only fallback | **Must have** | Unsupported/unidentified agents grouped by inactivity and labelled, without one-per-prompt guarantee |
| Dev-only floating timeline | **Must have** | Small dot pill hidden by default; one dot per *visible* iteration, not per file save |
| Visual screenshots | **Must have** | One final-state visual capture attempt per eligible visible iteration when preview is live |
| Play, pause, manual scrub | **Must have** | Frame-by-frame screenshots, not a recorded video |
| Version metadata | **Must have** | Provenance, completion status, changed files, source digest, visual status |
| Read-only code inspection/copy | **Must have** | View full historical files and diffs; copy selection/file/diff |
| Git history import | **Must have** | Older commits as a separate historical source; do not mislabel commits as agent prompts |
| Missing-visual states | **Must have** | No fabricated screenshot for an unrendered snapshot |
| User-level background agent | **Must have on declared OSes** | Keeps observing eligible files without a running dev server |
| Screenshot comparison | **Nice to have** | Side-by-side two recorded frames |
| Restore, revert, apply, fork | **Out of scope** | No write-to-project controls in MVP |
| Running old versions | **Out of scope** | Historical screenshots and code only |
| Video export, sync, accounts | **Out of scope** | On-screen playback and repository-local data |
| Scraping private agent checkpoints | **Out of scope** | Rewindry owns its own source snapshots; hooks provide lifecycle events |
| Remote-agent and unseen-worktree history | **Deferred** | Only monitored local directories guaranteed |

## 5. Goals and success measures

1. Install once; begin capturing without a new command on each development session.
2. Produce **one and only one visible iteration** per successfully completed, changed, supported agent turn, regardless of intermediate writes or idle pauses.
3. Capture **manual** changes as coherent iterations after inactivity, without requiring explicit checkpoint commands.
4. Accurately declare **unsupported/unknown turn boundaries** rather than claiming all file changes represent complete agent prompts.
5. Capture final-state screenshots when the local preview is running, and link every visual to verified source content.
6. Make the bottom-dot timeline fast, keyboard-accessible and strictly non-destructive, with read-only code inspection/copy.
7. Continue monitoring during dev-server downtime, and clearly distinguish visual gaps.

**Proposed beta targets, not measured performance:** 100% of the 20-edit and multi-minute-paused agent-turn fixtures yield exactly one completed-turn dot; no intermediate dot appears during a known active turn; 100% of eligible manual edit fixtures settle to one idle-group checkpoint; at least 99% of observable eligible write sequences are included in a persisted final tree; 100% of shown screenshots pass source-association checks; no project writes from the viewer; cached frame switch target <=250 ms on the reference fixtures. Agent-edition-specific reliability must be measured separately, not averaged into a blanket compatibility claim.

## 6. User experience — installation and ongoing use

Proposed installation (not a published package):

```bash
npx rewindry@latest setup
```

One setup invocation detects the repository, package manager and Vite/React development environment, installs the Rewindry local background agent and development-only preview adapter, configures the selected supported coding-agent hooks (where user-approved), creates `.rewindry/`, records a baseline, and indexes Git history in the background. It must preserve existing hook commands and be repeatable and reversible. Startup-service or hook-configuration permissions can prompt once during setup; they must never be silently bypassed.

### Onboarding results must be specific

- **Source watcher:** Active / fallback dev-session only / needs attention.
- **Agent boundary detection:** Exact for **Cursor [tested edition]**, **Claude Code [tested edition]**, **Codex CLI [tested edition]**, or unsupported; the installer must check installed editions/versions rather than claim universal support.
- **Manual capture:** Active; grouped after inactivity.
- **Visual capture:** Waiting for development preview / active / failed configuration.

When agent hooks cannot be configured, source tracking and manual/unknown activity grouping remain available; the interface must not promise one checkpoint per AI prompt for that agent. **Filesystem events alone cannot identify whether a human or unsupported agent made a change**, so unowned file changes should default to neutral `Grouped edits` provenance unless an explicit signal establishes manual origin.

### Normal developer journey

1. The developer uses Cursor, Codex, Claude Code, another editor or a terminal as usual. No `rewindry start`, separate shell or recurring command.
2. When a **recognised agent turn begins**, the connector marks that workspace/session as `AGENT_ACTIVE`. Rewindry continues observing writes but creates no visible dots as the agent works.
3. When that **turn completes**, Rewindry waits for pending writes to settle, freezes one source-tree checkpoint, and creates **one new dot**, if the source actually changed. An available dev preview then receives one screenshot request.
4. If the developer instead edits files directly with **no recognised agent turn active**, Rewindry groups the edits when the quiet window elapses. It may identify a **Manual iteration** only when manual origin is supported; otherwise it says **Grouped edits**.
5. The developer opens their normal `npm run dev` when they want a preview. Only in this local development interface is the Rewindry overlay injected.
6. Clicking the small bottom trigger reveals the dot timeline. Selecting a dot shows its recorded screenshot (when available), changed files and Copy controls. It never changes working files.

If the OS disallows persistent agent registration, offer a clearly labelled dev-session-only fallback. An OS-level persistent worker observes the repository even without a browser, but screenshots are not produced when the app is not running.

## 7. Capture triggers and browser trigger — separate responsibilities

There are **four** distinct triggers; they must not be conflated.

| Trigger | Source | Action | Creates visible iteration? |
|---|---|---|---|
| **Agent-turn start** | Supported lifecycle adapter (`prompt submitted` / equivalent) | Mark agent run active; buffer/observe affected files; suppress manual idle finalisation for that run | **No** |
| **Agent-turn complete** | Supported lifecycle adapter (`stop`, `agent-turn-complete`, equivalent) | After files settle, capture the final coherent tree; deduplicate by turn ID and source digest | **Yes, one if changed** |
| **Manual inactivity** | Filesystem observer plus absence of a known active agent | After initially proposed 15 s quiet, finalise grouped eligible unattributed/manual changes | **Yes, one if changed** |
| **Development preview ready** | Development-only framework adapter | Render screenshot for finalised checkpoint when source and preview match | **No new dot** |

The **browser UI trigger** is separate: a discreet control in the local development preview reveals or hides the bottom-dot timeline (or keyboard shortcut). The timeline is a read-only screenshot/code viewer; it never starts or stops the agent run.

### Critical constraints

- A 3-second or 15-second idle pause **inside an active agent turn is never an iteration boundary**. Some agents pause while thinking, waiting for tools or seeking permissions.
- **File-write events are input signals**, not independent checkpoint triggers for recognised agent turns.
- The agent completion event must be validated as the appropriate outer user turn; ignore subagent-completion, intermediate model messages and repeated stop events as additional iterations.
- **Completion received before writes settle:** wait for filesystem quiescence and an HMR readiness check; do not snapshot halfway through a last write.
- **Unknown agent lifecycle:** idle grouping applies, labelled `Grouped edits (turn boundary unverified)`. Rewindry cannot accurately guarantee one dot per prompt without a reliable boundary.
- **Production:** no injected overlay, browser history API, screenshot worker or source blobs in deployed builds. The source agent runs on the developer's machine, not inside the production app.

## 8. Timeline UX requirements

The primary reference is a minimal bottom-centred dark pill containing small dots. **A dot represents one completed agent turn, one manual idle-group iteration, or one imported Git commit** (visually differentiated). It never represents each save/tool invocation within a known agent turn.

| State | Behaviour |
|---|---|
| Hidden | Small on-demand trigger only; background observation continues |
| Default | Compact line of iteration dots; selected dot highlighted |
| Known agent active | **No provisional or intermediate dots**; discreet status can say `Agent working` |
| Agent completed and changed | Append exactly one new dot after source-tree capture finishes |
| Agent completed without changed eligible files | Append **no dot**; optional activity log status, not main timeline item |
| Manual edits in progress | No dot until quiet-period grouping finishes |
| Manual/unattributed iteration finalised | Append one dot labelled `Manual iteration` when origin is known; otherwise `Grouped edits` |
| Unknown agent/grouped edits | Append grouped-edit dot, not incorrectly labelled `Agent turn completed` |
| Hover/focus | Screenshot thumbnail, timestamp, type (agent/manual/Git/grouped), changed-file count, preview status |
| Selected | Recorded screenshot, if available; else explicit `No visual available` and access to code |
| Playing/scrubbing | Advance between finalised iterations only; source-only dots remain distinguishable |
| Many checkpoints | Virtualised timeline or session/group view; accessible selection |
| Code drawer | Read-only files/diffs, Copy selection/file/diff |
| Capture paused | Explicit status; no claim of invisible background recording |

Keyboard Left/Right, Space to play/pause, Home/End, Escape; focus equivalents for hover and touch-sized hit areas. Do not quietly replace old screenshots with today's live application. The developer may inspect an earlier dot without modifying the active workspace.

## 9. User journeys

### A — One multi-step agent prompt (the primary case)

1. Developer prompts Cursor: **"Redesign the dashboard."** The supported connector sees the turn begin.
2. Cursor updates JSX, changes CSS, imports assets, runs tests, fixes spacing and waits 25 seconds for a command. Rewindry observes file writes but shows **zero new dots**.
3. Cursor finishes the *user turn*. The connector sends one completion event, linked to the active turn.
4. Rewindry allows pending writes to settle, freezes the final changed source tree and adds **one** timeline dot. No second dot appears if a duplicate completion event arrives.
5. If the dev preview is active, one screenshot attempt is made for this final source state. Developer scrubs to the new dot and can inspect/copy historical code.

### B — Manual development between agent prompts

1. Developer manually tweaks two files with no known agent turn active.
2. The watcher tracks each save as pending manual activity. It does not generate one visible dot per save.
3. After **15 seconds** of no eligible writes (proposed default), it creates one checkpoint with the final eligible tree, labelled **Manual iteration** only if manual origin is established, otherwise **Grouped edits**.
4. A later distinct manual edit period produces a separate iteration after its own quiet period.

### C — Agent runs with the dev server stopped

1. Supported agent turn completes; Rewindry adds one final source checkpoint using its persistent worker.
2. That dot is **Source only — no visual captured** because the app was not running.
3. Starting `npm run dev` later does not retroactively pretend the current UI was the old UI; historical visual reconstruction remains out of scope for MVP.

### D — Existing repository

1. Setup indexes reachable Git commits without modifying the working tree; Git dots are clearly distinguished from prompt/manual dots.
2. Old commits normally have source and diff, no historical screenshot.
3. Rewindry captures current working tree as the initial baseline; past undocumented agent prompts cannot be reconstructed.

### E — Changing agents, unknown tools and multiple agents

1. Developer switches between supported local Cursor, Codex CLI and Claude Code integrations, each configured during setup. Each **recognised completed user turn** should create one dot if it changed the watched workspace.
2. If an agent lacks accessible lifecycle hooks, Rewindry groups its observable changes by inactivity and labels them **Grouped edits**; it cannot guarantee the requested exact turn count.
3. If two agents edit the *same checkout concurrently*, their final trees may mix writes. Preserve both event identities and times, show `Overlapping agent activity`, and avoid claiming each snapshot contains only one agent's edits. Distinct changes in independent registered worktrees may be handled separately once worktree support is validated.
4. Remote agents, cloud VMs, unopened worktrees and unsaved editor buffers are outside local observation until synced/written to monitored paths.

### F — Interrupted, cancelled or failed agent turn

- If the agent reports `aborted`/`error`, do **not** label the result `Completed iteration` or append a normal completed-turn dot. An internal diagnostic/recovery snapshot can be retained without entering the main visual timeline.
- If the agent completion signal is missing, the state becomes **Turn status unknown** and must not be silently converted into multiple `completed prompt` dots. Offer an explicit grouped-edits fallback only when boundary evidence is absent, with its true provenance shown.
- If final eligible tree has not changed, no dot is created, even if the agent wrote and reverted files during its run.

## 10. Agent compatibility and turn-boundary support

**Two separate capabilities must be tested:** (a) filesystem visibility of edits, and (b) trustworthy detection of completed **outer user prompts**. File visibility is editor-independent; prompt completion is not. Rewindry uses vendor-supported lifecycle events where available and owns its snapshot store; it **does not scrape or rely on proprietary agent rollback/checkpoint files**.

| Agent / environment | Proposed lifecycle integration | What MVP may promise after verification |
|---|---|---|
| **Cursor IDE Agent** | Project or user hooks: `beforeSubmitPrompt` plus `stop`; inspect `status` and suppress aborted/error completions | Exactly one finalised checkpoint per confirmed completed changed turn in tested versions |
| **Claude Code** | `UserPromptSubmit`, `Stop`, `StopFailure`; exclude `SubagentStop` as top-level completion | Exactly one per confirmed completed changed outer turn in tested versions |
| **Codex CLI** | The `notify`/`agent-turn-complete` event supplies an end signal; start/turn identity needs version-specific confirmation or another documented hook | One per turn only when start/end correlation or a reliable attribution boundary is demonstrated in tests; otherwise `Grouped edits` |
| **Codex desktop/editor integrations** | Do not assume CLI `notify` is delivered in all hosts | Version/host-specific support required; no blanket exactness claim |
| **Other coding agent in watched local checkout** | Filesystem watcher without a validated lifecycle adapter | Automatic grouped edits; **not** guaranteed one per prompt |
| **Manual editor/terminal edits** | No agent turn active; 15 s inactivity grouping | One manual iteration per settled editing burst |
| **Cloud agent or unseen worktree** | No reliable watched local files and/or lifecycle | Not guaranteed captured; only local synced results can enter observation |

**Hooks must be non-blocking/fail-open and idempotent:** Rewindry must not prevent prompts from running when its agent is unavailable. Setup should preserve existing user/project hooks instead of replacing them. Store only run IDs, timestamps, repo/worktree locator and status by default; don't persist prompt text or model outputs unless a future opt-in requires it.

**Important limitation:** A filesystem watcher cannot determine whether an unknown agent is still thinking while no files change. Therefore exact one-per-prompt is a **declared integration capability**, not a universal filesystem property. Validate the individual application/CLI versions and operating systems before naming them supported.

## 11. Checkpoint engine and grouping architecture

### Key distinction: observed source changes vs visible iterations

- **Observer:** follows eligible local filesystem events continuously and records the changed-path set. It can use temporary internal journal entries or content objects for crash protection; these **do not create visible timeline nodes**.
- **Turn manager:** correlates agent lifecycle events with a project/worktree and session/turn identity. A recognised `turn-start` suppresses manual idle checkpoint creation for activity associated with that active turn.
- **Idle grouper:** when no known agent turn owns the edits, accumulates writes and waits for a configurable quiet period, initially **15,000 ms** (default is a proposal to beta-test). It finalises one visible checkpoint. If manual origin is unproven, label **Grouped edits**, not **Manual iteration**.
- **Finaliser:** on an agent's **outer user-turn completion**, waits for pending writes to settle (short file-stability window), hashes the final eligible repository tree, and persists **one immutable checkpoint only if content changed**. Repeated completion notifications with the same provider/session/turn ID must be idempotent.
- **Visual scheduler:** receives only finalised checkpoint IDs, never raw file-write events; it queues at most one default-route screenshot attempt per finalised iteration.

### Event contract (illustrative internal API)

```ts
type IterationEvent =
  | { kind: 'agent.turn.started'; provider: string; repoId: string; workspaceId: string; sessionId: string; turnId: string; at: string }
  | { kind: 'agent.turn.completed'; provider: string; repoId: string; workspaceId: string; sessionId: string; turnId: string; status: 'completed' | 'aborted' | 'error'; at: string }
  | { kind: 'filesystem.changed'; repoId: string; workspaceId: string; paths: string[]; at: string }
  | { kind: 'manual.idle'; repoId: string; workspaceId: string; at: string };
```

Provider adapters normalise available event payloads; an event field is never fabricated when unavailable. For Codex completion-only integrations, the implementation must explicitly mark start-boundary confidence as missing. Do not assume a period of filesystem quiet proves task completion.

### State machine

```text
WATCHING
  ├─ agent start (known) → AGENT_ACTIVE (buffer writes; no dot)
  │    ├─ more writes / long idle / subagent stops → AGENT_ACTIVE
  │    ├─ confirmed completed outer turn → FINALISING → one AGENT dot if changed
  │    └─ aborted/error/missing boundary → UNVERIFIED (not a completed-turn dot)
  └─ unowned file writes → MANUAL_PENDING
       ├─ more writes → MANUAL_PENDING (reset quiet window)
       ├─ known agent start → reconcile ownership, suppress/manual merge where justified
       └─ 15 s quiet, no known active agent → FINALISING → one MANUAL or GROUPED dot if changed

FINALISING → immutable tree manifest → optional screenshot queue → WATCHING
```

### Explicit safety/accuracy rules

1. **No intermediate dots while a recognised agent turn is active**, even after long pauses.
2. A new user prompt in the same conversation starts a **new** turn; a tool call, subagent response, internal thinking segment or self-correction does not.
3. Use compound identity `(provider, repo, workspace, session, turn)` to deduplicate turn completion. Do not use timestamp alone.
4. Snapshot the final **eligible whole-project state** (changed paths plus manifest). Code/diffs are based on snapshots; source files outside includes/excludes are not promised.
5. If manual edits overlap a known agent turn in the same checkout, the shared tree cannot prove per-author changes. Store ambiguity and report it; avoid inventing ownership.
6. If two agents overlap, separate **turn events** may still finalise distinct snapshots, but their code/visual content may include concurrent edits. Show this clearly. If a completion is followed immediately by another writer, visual capture can fail with `source-changed` without changing dot count.
7. A missing completion signal must not be silently interpreted as completed. The fallback can produce grouped-edit checkpoints marked `boundary-unverified`, which do not count towards tested exact agent-turn support.
8. Internal buffering or recovery objects are not discoverable timeline checkpoints until finalised; crashes may leave a recoverable journal entry, not a false completed dot.
9. Unchanged final content creates no new dot. If a user wants to retain all no-op turns, add that as a later explicit product option, not the MVP default.
10. Reconcile after sleep/wake, editor atomic writes, restart, Git branch changes or missed filesystem events. Never fabricate unseen intermediate states.

## 12. Screenshot capture fidelity (finalised iterations only)

A screenshot belongs to a **finalised agent/manual/Git checkpoint**, never a transient edit or interim agent thought.

1. Receive a finalised checkpoint ID, tree manifest/digest, provenance (`agent completed`, `manual grouped`, etc.) and changed-file set.
2. If there is a configured local dev preview, wait for file stability, framework hot-reload acknowledgement (where available) and page readiness.
3. Verify that the current watched source digest matches the finalised checkpoint's eligible tree. Render with Playwright at configured route, viewport, theme/scenario; keep Rewindry's overlay out of the image.
4. Verify digest again after capture. On mismatch, reject the image, retry only while the same source state still exists; otherwise set **Visual unavailable — source changed**. **Never label a later screenshot as an earlier prompt's output.**
5. Save source digest, checkpoint ID, route, viewport, capture time, readiness and preview status. A source-only checkpoint remains a valid timeline item.
6. Limit the screenshot worker to the **final state of each visible iteration**; optional internal file-write journals must not trigger extra captures. Do not block the developer's agent while screenshots are attempted.

Identical source does not guarantee identical browser output: network responses, state, sessions, animations and external assets can differ. Prefer deterministic fixtures where possible. MVP supports one configured route and desktop viewport in React/Vite; no historical live execution or retroactive screenshot backfills are promised.

## 13. Git import, what it can and cannot do

- Import locally reachable commits and parents, optionally limited to current branch ancestry; support shallow-clone boundary status and renamed file/history caveats.
- Index commits lazily for responsiveness. Git history import is read-only and must not create commits or modify the current worktree.
- Treat an imported Git commit as a **source checkpoint**; it will not have a historical screenshot unless one is legitimately available and provenance is verified.
- Uncommitted history before installation cannot be inferred from Git. Do not promise editor private history import in MVP.
- During playback, represent Git-only states distinctly; provide source code/diff and label visual absence. Imported Git commits do not count as completed prompts; preserve their separate type.

## 14. Read-only code viewer and Copy

- Select checkpoint -> **View code** opens an anchored drawer or panel.
- Show changed file list, file path, before/after diff, full file at the selected checkpoint, search within file and syntax highlighting for supported languages.
- Copy buttons: **Copy selection**, **Copy file**, **Copy diff**. Clipboard content must be exactly the selected historical source or diff.
- Clearly indicate selected checkpoint, file and revision; never copy current code while presenting it as historical.
- No restore, apply, replace, write to editor, Git checkout, `git reset` or `git cherry-pick` from the UI in MVP.
- All browser endpoints serving source must be loopback-only and token protected. Apply file-path validation and source-exclusion rules.

## 15. Technical architecture

```text
Cursor / Claude Code / Codex CLI       Manual editor / unknown agent
        |                                      |
  supported prompt/turn hooks                 | file writes
        |                                      |
        +----------→ Rewindry user-level agent←+
                          |
                  workspace file observer
                          |
          +---------------+----------------+
          |                                |
   AGENT_ACTIVE buffer               MANUAL_PENDING grouper
   start → confirmed end             quiet 15s, no known agent
          |                                |
          +---------------+----------------+
                          |
                finalise ONE source tree
                   (no-op dedupe)
                          |
              .rewindry/ manifests + blobs
                          |
              checkpoint graph and viewer
                          |
          local dev-only dot timeline + code Copy
                          ^
               one screenshot request per
               finalised checkpoint (if live)
                          ^
               React/Vite dev preview
```

### Processes and responsibilities

- **One-time installer:** discovers agent editions, registers their supported hooks only with appropriate permission, preserves existing hook config, registers the project/OS agent, and injects the development-only preview integration.
- **Persistent local worker:** survives editor/dev server restarts. Observes files, owns turn-correlation state, manual idle timers, transactional checkpoint finalisation and local journal recovery.
- **Agent adapters:** send lifecycle events only, not proprietary internal checkpoint blobs. Must identify completed *outer user turns* rather than every tool/subagent call. Fail open when worker is not reachable; no delay/block in the user's agent run.
- **Storage:** immutable SHA-256 content blobs and manifests indexed with SQLite under `.rewindry/`. Operational system service metadata only may live outside the repo.
- **Visual worker:** screenshot capture on finalised checkpoint only, when a local dev server is ready and the digest matches.
- **Timeline viewer:** served locally and injected only in development. Read-only browser API for checkpoint metadata, screenshot images and source-code Copy; no restore endpoints.

### Adapter design for maintainability

```ts
interface AgentTurnAdapter {
  provider: string;
  versionRange: string;
  capabilities: { turnStart: boolean; turnEnd: boolean; sessionAndTurnIds: boolean; status: boolean };
  installHooksSafely(projectRoot: string): Promise<void>;
  uninstallHooksSafely(projectRoot: string): Promise<void>;
  normalise(payload: unknown): IterationEvent | null;
}
```

Adapters are feature-detected per host and version. **An end-only hook is not equivalent to full prompt-boundary coverage.** Filesystem grouping stays available everywhere local writes are visible. Multiple agents in one checkout require overlap warnings and correlation rather than naive reliance on whichever completion event fires first.

### Minimum supported product claim

- **React/Vite**: first development-only overlay and visual adapter.
- **Source observation**: editor-independent for monitored local directories.
- **One iteration per agent prompt**: only for explicitly tested, supported agent editions with reliable completion/boundary correlation. Installer/status UI lists exact capabilities.
- **Manual/unattributed grouping**: quiet-period based and available without agent-specific hooks. Unknown origin is labelled `Grouped edits`.

Service registration may need OS approval. Fall back clearly when denied. Never silently use package `postinstall` to register a persistent service or overwrite existing agent hooks.

## 16. Storage and lifecycle

All **project-owned** history lives under the repository:

```text
project/
  src/
  package.json
  .git/
  .rewindry/
    config.json
    index.sqlite
    manifests/
    objects/
    previews/
    journal/             # Internal pending/recovery state, not timeline dots
    cache/
```

System/user application data outside the repository may contain a versioned agent executable, registered absolute repo paths, locks and small operational logs. It must not hold project snapshots or screenshot history.

Default `.gitignore` excludes `.rewindry/` history while allowing opt-in sharing of configuration. Cloning a Git repo **does not copy ignored local history**. Copying the folder including `.rewindry/` or exporting history is a later portability path. Show disk-use stats and configurable retention. Do not delete persisted source objects needed by existing checkpoints.

If a repo moves, re-register it rather than assuming the old absolute location is still live. Uninstall removes integration/registration but keeps snapshots unless the user explicitly requests deletion. Production builds must never bundle the viewer or history store.

## 17. Privacy, security and safety

- Default localhost-only, no cloud account, no telemetry, no default uploads.
- Require consent to install the login-start service; no hidden privileged OS-level service.
- Never expose historical source via a remotely accessible dev-server interface, production build or unsecured browser route.
- Protect against cross-origin requests/CSRF, malicious paths/symlinks, credential-file capture, content injection in code viewer and accidental screenshotting of real personal data.
- Avoid auto-running arbitrary historical source or package scripts: **there is no historical execution in MVP**.
- The reviewer cannot write to the source tree. This simplifies the threat model substantially.
- Display clear disabled/paused/capture-failed status and storage-health warnings.

## 18. Failure states and gotchas

| Scenario | Required MVP behaviour |
|---|---|
| One agent turn edits 20 files in 50 separate writes | **One** completed-turn dot, not 50; interim writes observed but not published |
| Agent pauses longer than manual idle threshold | **No** dot until confirmed completion while known active |
| Agent fixes its own first attempt | Final corrected state only; no intermediate visual dots |
| Agent completes with identical final tree | No visible new dot |
| Duplicate `stop`/completion webhook | Idempotent; never duplicate a dot |
| Agent start hook missing, end hook exists | Do not advertise exact one-turn capture without proven correlation; label grouped edits otherwise |
| Agent crashes or is cancelled | No false `completed` dot; keep labelled diagnostic/recovery status |
| Agent's final file write arrives after completion signal | Wait for write settling and digest consistency before finalisation |
| User edits files outside any known active agent turn | One iteration after proposed 15 s idle; `Manual` only when attributable, otherwise `Grouped edits` |
| User edits while agent works | Shared-tree attribution is uncertain; include overlap status, don't invent authorship |
| Two agents work concurrently in same checkout | Correlate separate events where possible; flag mixed-source states and visual mismatches |
| Unsupported agent pauses between edits | Quiet-time grouping **may** split its prompt; label `Grouped edits`, not `Confirmed agent turn` |
| Screenshot race: source changes mid-capture | Reject/mark unavailable; never show an incorrectly attributed screenshot |
| Dev server off / app crashes / HMR fails | Keep final source checkpoint; visual absent or failed with reason |
| Agent edits unseen worktree/remote VM | Only visible local checkout changes can be observed; no fabricated history |
| Laptop sleeps or persistent agent restarts | Resume and reconcile latest eligible tree; mark unknown gaps |
| Git imported with old commits | Git checkpoints separate provenance; old screenshots normally absent |
| Hundreds of completed prompts | Group/session virtualisation without one dot per file write |
| Full disk/permissions lost | Fail safely, preserve previously committed manifests, visible status |
| Production build runs | No Rewindry overlay, source API or embedded histories |
| Installer run twice / uninstall | Hook/service idempotence; preserve user hook config; uninstall keeps history by default |

## 19. Accessibility and performance

- Keyboard equivalent for every timeline control; focus-visible and accessible labels for dots, source-only markers and play/pause.
- Touch-friendly hit areas despite small visible dots. Responsive width and unobtrusive positioning.
- Prefer image thumbnails/WebP for scrub; lazy-load large screenshots and source blobs; optimise for smooth interaction.
- Honour reduced-motion preferences. Animation should not be necessary to inspect any checkpoint.
- Back-pressure preview captures without blocking normal coding, build or dev server tasks. New screens are requested only for finalised iterations, never every edit.

## 20. MVP acceptance criteria (release blockers)

### Setup and background lifecycle

1. One command configures supported local setup, persistent agent and appropriate agent hooks (with required consent), and creates baseline.
2. Closing the installation terminal, restarting the IDE or restarting the dev server requires **no** additional Rewindry command.
3. Source watcher resumes after machine restart/sleep where supported; previous checkpoints remain intact and gaps are labelled.
4. Unsupported operating systems or rejected background-service permissions show `Limited capture`, not `Always capturing`.
5. Repeating setup/uninstall does not duplicate hooks, break existing agent configurations or corrupt the project's normal `dev` command.

### One agent turn = one iteration

6. In a declared-supported agent integration, a prompt that causes at least 20 writes across multiple files, several tool calls and a pause longer than 15 seconds produces **exactly one** dot after the confirmed turn ends; **zero new dots while it runs**.
7. Two consecutive completed, changed prompts in one conversation produce **two** distinct dots, not one session-level checkpoint.
8. Subagent completion, repeated final response callbacks and repeated stop notifications do **not** create extra dots.
9. A completed prompt with no final eligible source-tree change produces **no** dot; a cancelled/failed prompt is never marked `Completed iteration`.
10. The correct checkpoint is linked to the completed turn identity where available and contains the final eligible tree, not an earlier partial state.
11. Unsupported/end-only agent integrations do not advertise guaranteed one-per-prompt tracking; source remains captured with truthful `Grouped edits`/confidence labels.
12. Cursor, Claude Code and Codex CLI receive **separate edition/version-specific validation** of lifecycle events and workspace attribution; no universal support claim is allowed without passing tests.

### Manual idle grouping and concurrency

13. A sequence of known manual writes across multiple files separated by less than the configured 15-second quiet window yields **one idle-grouped iteration** after the quiet period, with manual provenance only if established.
14. Separate manual sessions with a quiet interval yield separate dots; a known active agent pauses 30+ seconds without manual dots appearing.
15. Simultaneous agents/editors in one checkout trigger an overlap/attribution warning and never fabricate exclusive source ownership.
16. Neither `.rewindry/` nor generated output triggers self-capture loops.

### Visual and timeline

17. One finalised changed checkpoint queues **at most one primary-route screenshot job** (which may retry on readiness/source-race failures); intermediate writes never queue historical screenshots.
18. The screenshot shown for a dot is associated with that precise source digest; if source has moved on, the old dot is source-only, never represented by the new UI.
19. In local development the hidden trigger reveals a small bottom dot pill. Timeline plays/scrubs among finalised iterations, with missing visuals disclosed; review never modifies project files.
20. Production builds/deployed sites contain no timeline overlay, screenshot-control routes or source/history blobs.
21. Existing screenshots/code can be inspected in the standalone local viewer when no dev server is running.

### Git history, code inspection and resilience

22. Imported Git commits preserve provenance/graph ancestry and are distinct from agent/manual timeline dots. Git import does not modify Git or source.
23. Selecting a checkpoint allows read-only full-file/diff inspection and exact Copy. No restore, apply, revert or fork API exists.
24. Crash, disk-full, failed preview or agent-hook failure cannot corrupt previously completed immutable checkpoints; user sees status.
25. All project-owned persistent history, source blobs, images and indexes remain inside `.rewindry/`; external service registration contains operational metadata only.

## 21. Test plan

- **Turn-boundary fixtures:** one prompt with 20–100 file events; tool-call pauses of 5, 20 and 60 seconds; self-correction; subagent return; duplicate completion; two consecutive prompts; no-change completion; cancelled/failed turn. Assert dot count and exact final source digest after each.
- **Adapter E2E:** separately test Cursor IDE Agent, Claude Code terminal/IDE and Codex CLI on declared versions. Instrument actual `start`/`stop` or `notify` events. For Codex completion-only cases, demonstrate correlation before claiming exact turn coverage; otherwise verify degraded truthful fallback.
- **Manual tests:** handwritten edits to JSX/CSS over multiple saves; inactivity grouping at 15 seconds; distinct manual sessions; ambiguous origin labelled `Grouped edits`; manual editor writes mixed with an agent turn.
- **Concurrency tests:** two agents in one checkout; background subprocess writes after reported completion; agent working in another local/unwatched worktree; remote changes synced later; ambiguous event/ownership ordering.
- **Source integrity:** immutable manifests, atomic renames, watcher restarts, branch changes, symlinks, secret exclusion, crash recovery, no self-trigger loops.
- **Visual correctness:** HMR readiness, screenshot hash both before/after, multiple rapid turn completions, final source differing from current app, dynamic content and no preview.
- **UI:** 3/30/1000 completed-turn/manual/Git dots; hidden/default/play/focus; read-only diff/Copy; no production overlay.
- **System:** one-command setup/uninstall, coexistence with installed user hooks, user service start/stop, sleep/wake, OS approvals and fallback status; declare OS/version matrix before release.

## 22. Build sequence (within the MVP)

**Milestone A — Agent-aware capture foundation:** one-command setup; persistent local watcher; immutable storage; **turn manager, prompt start/end adapters, idempotent one-turn finaliser and manual idle grouper**; capability/status reporting. Prove "one completed prompt → one dot" and "idle quiet period → one dot" on simulated events before integrating visual capture.

**Milestone B — Real agent integration:** implement/validate Cursor and Claude Code lifecycle hooks, then Codex CLI completion handling with evidence-based correlation or an explicit grouped-edits fallback. Test actual hosted editions before claiming support. Build Git importer and restart recovery.

**Milestone C — Final-state visual playback:** React/Vite dev adapter; screenshot queue sourced **only** from finalised checkpoint IDs; HMR/source digest checks; bottom pill; Play/Pause and missing-visual states.

**Milestone D — Code viewer and hardening:** read-only diff/file Copy, concurrency/overlap status, storage retention, secure viewer, accessibility, full end-to-end matrix, one-command install/uninstall regression tests.

These are milestones in one **read-only visual-history MVP**, not separate user-facing products. Rewindry must never degrade silently from confirmed turn boundaries to idle-based grouping.

## 23. Explicitly postponed features

- Restore/apply old code, undo, fork a checkpoint, Git checkout, live execution of historical application states.
- Exporting video/GIF, hosted sharing, cloud synchronisation and team accounts.
- Importing proprietary agent-private snapshot databases, prompts or uncommitted histories from before installation.
- Automatic historical screenshot reconstruction and execution of older dependencies.
- Cloud-agent instrumentation, unsupported/unwatched worktrees, fully general multi-framework capture.
- Semantic component/AST history and multi-route or multi-state visual capture beyond the supported MVP fixture.
- Capturing every intermediate file change as a visible checkpoint. **Explicitly prohibited for known active AI turns.**

## 24. Open decisions for validation (not blockers to the checkpoint policy)

1. **Manual quiet period:** start with 15 seconds; beta-test 10–30 seconds against natural hand edits and avoid accidental splits.
2. **Codex CLI start correlation:** test current `notify` and any supported lifecycle hooks; do not claim exact prompt grouping from an end-only event without proof.
3. **Concurrent turns:** display an overlapping-activity marker and shared-tree warning; decide whether to suppress screenshot attempts while another agent is still writing.
4. **Interrupted turns:** retain diagnostic hidden state only by default; consider an explicit `Incomplete work` drawer later, separate from the main timeline.
5. **Visual replay rate:** proposed one displayed finalised screenshot per second; source-only dots remain navigable and clearly marked.
6. **Route selection:** start with one explicit route/viewport; multi-route scenarios only after validating source-to-screenshot fidelity.
7. **Retention:** determine a practical screenshot quota after measuring real front-end project sizes; never prune pinned completed snapshots silently.

## 25. Technical references for agent boundary and development capture

These official sources establish available **capabilities**, not guaranteed compatibility with every installed edition or version:

- Cursor hooks and lifecycle events, including `beforeSubmitPrompt` and `stop`: https://cursor.com/docs/hooks
- Claude Code hooks: `UserPromptSubmit`, `Stop`, `StopFailure`, and outer/subagent distinction: https://code.claude.com/docs/en/hooks
- OpenAI Codex CLI completion notifier (`agent-turn-complete`) in Codex source: https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs
- Codex configuration and evolving hooks: https://github.com/openai/codex/blob/main/docs/config.md
- Vite dev-only plugin hooks: https://vite.dev/guide/api-plugin.html
- Playwright screenshots: https://playwright.dev/docs/screenshots
- Git worktree reference (future worktree support): https://git-scm.com/docs/git-worktree

**Scope of claim:** Rewindry can observe local filesystem changes across editors, but **exactly one visible iteration per completed AI prompt** requires a working, tested turn-boundary adapter for that agent and host. Unsupported sources use explicit `Grouped edits` fallback. This is the product promise to validate in implementation, not proof that the software already exists.

---

## Design and product engineering review addendum — proposed, 10 October 2026

**Status:** Recommendations for decision, not an implemented or automatically approved change to PRD v1.3. The original requirements above are preserved. If a recommendation is accepted, record the decision and update its named acceptance criteria before implementation.

### A. What the user is really trying to recover

The primary job in §3 is to find an earlier UI direction and inspect its code. §4 and §14 explicitly exclude restore while offering Copy. That creates a task gap: a useful design may span JSX, CSS, assets, and configuration, and copying one file at a time may not recover it. A timeline can succeed technically while failing the user's actual task.

**Proposed change:** Keep the first viewer read-only, but test the complete task: “Find the version I preferred and get the code I need to recreate it.” Add a **Copy changed files bundle** or downloadable patch as a candidate only if single-file Copy fails; this would export historical bytes without modifying the working tree. Defer applying the patch in place. Do not call the product a recovery tool until users complete this task.

**Decision test:** Give 5–8 target users a fixture with three visually distinct, multi-file iterations. Record whether they find the preferred frame, identify the right changed files, and recover it in a fresh branch within five minutes. Capture observed failures and decide whether multi-file export is required for MVP.

### B. Validate the visual promise before building the whole platform

§5 measures event accuracy and frame speed but not whether users get enough useful screenshots. §9C and §12 correctly admit that a stopped preview produces permanent source-only history. A visually focused product may therefore deliver many dots without visuals during ordinary agent use.

**Proposed change:** Add a product-level activation measure: the share of changed turns that produce an inspectable visual in the supported reference workflow, plus the share of users who can locate a useful earlier design. These are research measures, not invented release targets. In setup and timeline, explicitly show whether the preview is connected **before** a user expects visual capture. Test whether users will keep the preview running; if not, revisit the visual promise and capture workflow rather than quietly accepting source-only history as the typical result.

### C. Narrow the first public compatibility promise

The PRD combines a persistent OS agent, multiple agent integrations, installer config edits, Git import, visual capture, timeline playback, and code inspection as release blockers (§4, §20). Each is plausible, but their combined integration surface is large before the core value is validated.

**Proposed first supported release:** One declared macOS version, one conventional React/Vite template, one verified paired-boundary agent edition, one route/viewport, local source checkpoints, verified best-effort screenshots, timeline selection, and historical code/diff Copy. The watcher and viewer should still work if the preview is off. Keep one-command setup as the target, but gate its invasive service and config edits on a tested prototype. Make additional agents, Git import, slideshow playback, and broad installer automation follow-on release candidates unless user testing proves one is necessary for the primary recovery task. This is an explicit proposal to revise §4 and §20, not a claim that the current MVP already has that scope.

**Decision test:** After the first vertical slice, have developers use it on a real two-hour UI task. Measure whether they voluntarily revisit a prior iteration and what they try to do next. Promote a deferred feature only when it removes an observed blocker.

### D. Make the timeline answer a question quickly

§8 specifies dots, hover details, playback, and 1,000-item virtualisation, but says little about finding a particular visual direction. Even 30 identical dots are hard to recognize, and imported Git commits can swamp the agent-turn story.

**Proposed change:** Group by work session/day; show a thumbnail, time, changed-file count, and trustworthy provenance on focus/selection; provide previous/next visual and a clear “current working tree” marker. Keep source-only items in navigation with a distinct appearance. If Git import ships, put commits in a separate lane or filter rather than interleaving every commit as an equal dot. Test 30 and 100 mixed entries with keyboard and touch, then choose whether playback adds value over quick selection and comparison.

### E. Distinguish file association from visual fidelity

§12 and §20 use “precise source digest” language. Matching watched files before and after capture does not prove that Vite served the newest compiled modules, that the page rendered without an error, or that remote data, local storage, fonts, time, and animations produced the expected state.

**Proposed change:** Use two visible claims: **Source recorded** when manifest bytes are intact, and **Visual recorded from a ready preview** only when the preview confirms the intended workspace and build generation, the page is ready, and the source remains stable. Present the image as an observed development rendering, with route, viewport, capture time, and known dynamic-data limitations. Do not use “exact historical UI” as an unqualified claim. A missing image is preferable to a misleading one.

### F. Make privacy an installation choice users can understand

§17 acknowledges secret and personal-data risk, while setup automatically creates a broad local history store and screenshots. File-name excludes cannot detect secrets inside ordinary source or private data visible in the app.

**Proposed change:** Before baseline capture, show the exact included roots, excluded paths, storage location, and configured preview URL; let users exclude paths and disable screenshots without losing source capture. Default to no network upload and no persisted browser login state as already specified. Show disk usage and a one-step pause control in the viewer. Test setup with a repo containing a nested app, generated files, symlinks, and intentionally sensitive fixture content to ensure the preflight explains what will be saved.

### G. Resolve the provenance edge cases in user language

The distinction between `Manual iteration` and `Grouped edits` is honest but may be too subtle for a new user (§8–11). A turn can also fail after leaving a meaningful new source state, while the main timeline hides it (§9F).

**Proposed change:** Use a short explanation beside each badge: “Agent turn confirmed,” “Changes grouped after inactivity; author unknown,” or “Agent stopped before completion.” Provide a separate, discoverable “Unfinished changes” area only if users need to inspect failed-turn states; never merge these into confirmed-turn counts. Test whether users can correctly explain what each badge means without reading documentation.

### Decisions to settle before calling the PRD implementation-ready

| Priority | Decision | Evidence needed |
| --- | --- | --- |
| P0 | Is review + single-file Copy sufficient, or is multi-file export necessary? | Recovery-task user test in A |
| P0 | What is the first supported host/agent/framework combination? | Real paired-hook and screenshot prototype |
| P0 | What level of visual fidelity can the UI honestly promise? | HMR/build-generation and dynamic-page fixtures |
| P1 | Is preview availability common enough for a visual-first default? | Two-hour real workflow observation |
| P1 | Which features follow the first release: Git import, playback, more agents, broader install automation? | Task failures and adoption signal, not feature completeness alone |

**Cross-document action:** The technical and implementation addenda below spell out the engineering changes and the order for resolving these decisions. The original numbered acceptance criteria remain historical requirements until the scope decision is made.
