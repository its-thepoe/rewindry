# Rewindry — MVP Implementation Plan

**Version:** 1.0 · 10 October 2026  
**Status:** Build plan for coding agent and maintainers; no implementation is claimed  
**Read first:** `rewindry_mvp_prd_v1_3.md` → `rewindry_technical_spec_mvp_v1.md` → this plan.  
**Outcome:** Install Rewindry once, continue coding normally, and replay final recorded visual iterations from a bottom-dot timeline. Every confirmed completed, changed agent prompt creates one dot; manual edits group after inactivity. No code restoration.

## 1. Rules for the implementing agent

1. Follow the MVP PRD. **Do not add** code restoration, patch application, Git checkout/fork, live historical execution, video export, cloud accounts or remote sync.
2. **One confirmed completed agent prompt = at most one dot.** Intermediate agent writes do not generate visible history. Source-only dots and honest missing-preview states are valid.
3. Build and pass **turn-boundary tests before designing the timeline UI**. If a provider exposes only completion events, do not misrepresent it as fully supported one-per-turn capture.
4. Every change needs a test or a documented manual verification. Commit in small reviewable changes after a passing test gate.
5. Preserve existing agent-hook handlers, package scripts and Vite configuration. Setup must be idempotent, reversible and run without administrator privileges when the OS permits.
6. Never install a daemon using a temporary `npx` executable path. Register a stable versioned runtime.
7. Browser review is **read-only**. No frontend endpoint is allowed to modify source, run arbitrary shell commands or check out Git revisions.
8. Prefer source checkpoint integrity over maximum screenshot coverage; reject a visual if its source association cannot be confirmed.
9. When the PRD or third-party behaviour is ambiguous, make the smallest safe choice, record it as an ADR and surface the limitation in product status. Do not fabricate capabilities.
10. After each milestone, report: changed files, tests run, passing/failing results, remaining gaps and next tasks. Do not mark tasks completed without evidence.

## 2. Definition of MVP done

A user on a **declared supported macOS + Node + React/Vite setup** can:

- Run only `npx rewindry@latest setup`, accept the required permission and continue working with normal IDE and dev commands.
- Close the setup terminal, quit and reopen their editor, and still have the user-level Rewindry daemon observing eligible local source writes.
- Complete a recognised changed Cursor or Claude Code turn (on individually validated editions) that writes 20+ times with long idle gaps and see **exactly one** new iteration after the turn completes.
- Make manual edits across several files and see one grouped iteration after the default 15-second quiet window.
- Use source-only history while the development server is off; see a captured verified screenshot when the configured React/Vite local preview is available.
- Reveal the simple bottom-dot timeline in **development only**, play/scrub, inspect diffs and copy historical code **without modifying the current project**.
- Browse old reachable Git commits as clearly labelled Git history, not incorrectly labelled historical agent prompts.
- Receive precise status when Codex CLI, an unknown agent, permissions or an unsupported environment lack verified turn-boundary integration.
- Uninstall the integration without breaking the original dev command or other agents' hooks and without deleting recorded history.

**Not an MVP guarantee:** one-per-prompt capture in every agent app/edition, cloud-agent sessions, unregistered worktrees, screenshots without a running dev preview, or recreation of pre-install uncommitted states.

## 3. Delivery order and dependencies

```text
M0 Feasibility and support matrix
  ├─> M1 Workspace, storage, watcher and journalling
  ├─> M2 Turn manager and manual grouping
  │     └─> M3 Real agent adapters and completion correlation
  ├─> M4 One-command setup and persistent daemon (may run alongside M2/M3)
  └─> M5 Dev preview, screenshot verification and timeline
                  └─> M6 Git import, code viewer, hardening and release
```

This is a **dependency order**, not an estimate of calendar time. Parallelise work only when the dependent interfaces and schemas are settled. Each milestone has an exit gate; do not advance because its UI looks finished.

## 4. Milestone 0 — Feasibility spikes (mandatory first)

**Goal:** prove the hardest assumptions before committing to a detailed implementation.

| ID | Work item | Evidence / exit criterion |
|---|---|---|
| M0-01 | Create fixture React/Vite repo and a second repo with Git history; define eligible file set | Repeatable project scripts and test fixture instructions |
| M0-02 | Run Cursor `beforeSubmitPrompt`/`stop` in a local project, record sanitised payload shapes, check abort, subagent and repeated callbacks | Exact tested Cursor edition/version and whether paired *outer-turn* boundary is reliable |
| M0-03 | Run Claude Code `UserPromptSubmit`/`Stop`/`StopFailure`; verify turn, session and interruptions | Sanitised event fixtures, tested editions and correlation result |
| M0-04 | Probe Codex CLI `notify=agent-turn-complete` plus any documented public start signal; test without assuming one exists | Capability result: paired or **end-only/unverified**; no false one-per-turn claim |
| M0-05 | Demonstrate a user-level LaunchAgent on macOS that survives terminal exit and restart, without elevated permissions | Start/stop/upgrade/permissions-denied test evidence |
| M0-06 | Prove Vite `apply:'serve'` overlay injection, production exclusion, HMR readiness and screenshots with source-hash verification | Tiny demo records screenshot for correct final tree and rejects changed tree |
| M0-07 | Decide exact first supported macOS/Node/Vite versions and supported agent host editions | `docs/compatibility.md` with verified vs fallback matrix |

**Exit gate G0:** factual capability table plus runnable demos exist. If neither Cursor nor Claude Code can supply reliable paired outer-turn boundaries, stop and revisit the MVP promise before building further. If screenshot fidelity fails, do not claim visual replay; revise the capture mechanism or supported fixture first.

## 5. Milestone 1 — Repository foundation and immutable storage

**Goal:** persist coherent, safe source checkpoints with no UI and no dependence on agent provider.

| ID | Work item | Depends on | Acceptance |
|---|---|---|---|
| M1-01 | Set up TypeScript workspace and package boundaries: `core`, `store`, `daemon`, `cli`, `adapters`, `git`, `capture`, `vite-plugin`, `viewer`, fixture repos | M0 | Typecheck, lint, test CI run |
| M1-02 | Define versioned event types and schemas, canonical paths, workspace ID, turn IDs, checkpoint kinds | M1-01 | Unknown/malformed events rejected; schema fixtures documented |
| M1-03 | Implement allow/exclude glob policy, path/symlink protection and secret-risk defaults | M1-01 | Unit tests include traversal, symlink escape and `.rewindry/` recursion |
| M1-04 | Implement file observer (create/change/rename/delete and atomic saves) and rescan reconciliation | M1-03 | Multi-file fixture receives eligible writes; exclusion tests pass |
| M1-05 | Implement content-addressed blob storage, deterministic full-tree manifests and SHA-256 | M1-03 | No duplicate blobs for identical data; manifests reconstruct exact eligible content |
| M1-06 | Add SQLite migrations, journal, atomic publication and recovery | M1-05 | Kill after object write/before DB transaction: no corrupt published checkpoint |
| M1-07 | Implement changed-tree comparison and checkpoint path/file index | M1-05 | Same tree yields no additional checkpoint; deletion/rename represented |
| M1-08 | Add diagnostics for missing/corrupt blob, disk-full, watcher overflow and moved repo | M1-06 | Explicit degraded states; last complete checkpoint still readable |

**Exit gate G1:** a simulated finalisation call writes an immutable multi-file checkpoint, survives restart, and a read-only method returns exact historical file bytes. 100% of source-object validation tests pass.

## 6. Milestone 2 — Agent-turn state machine and manual fallback

**Goal:** implement the central user promise before connecting real agents.

| ID | Work item | Depends on | Acceptance |
|---|---|---|---|
| M2-01 | Implement append-only event ingest with idempotent `eventId`, strict schema validation and bounded queue | M1-06 | Duplicate event replay creates one state transition |
| M2-02 | Implement `IDLE` → `AGENT_ACTIVE` → `SETTLING` → `COMPLETED/NO_OP` state machine | M2-01 | 100 intermediate writes = zero dots until confirmed end |
| M2-03 | Implement final write-settling and end-state tree digest comparison | M1-07, M2-02 | Late final writes included; unchanged final tree = no dot |
| M2-04 | Implement manual/unattributed 15-second quiet-period grouping, configurable | M1-04, M2-02 | One multi-file burst = one dot; distinct quiet-separated bursts = distinct dots |
| M2-05 | Suppress manual grouping during known active turns; reconcile pending manual writes at turn start | M2-04 | 60-second agent pause never yields a manual dot |
| M2-06 | Handle duplicate finish, subagent finish, aborted/failed turn and missing end | M2-02 | No extra or false `completed` dots; diagnostics show incomplete status |
| M2-07 | Handle overlapping known agent turns and user edits in same checkout | M2-05 | Preserve combined tree, `overlap` flag; no false per-file attribution |
| M2-08 | Add replayable fake-agent driver and deterministic fake-clock test suite | M2-02–07 | All boundary edge cases exercised deterministically without real AI costs |

**Exit gate G2:** run the following mandatory tests:

- One prompt writes 20 files in 50 separate operations, waits 60 seconds, self-corrects and ends → **exactly one** dot after finish.
- First prompt unchanged → **zero** dots; second and third changed prompts → **one each**.
- Duplicate finish, delayed write, repeated callback and subagent stop → **no additional** dots.
- Agent aborted/crashed → **zero completed-turn** dots, with labelled diagnostics.
- Manual edits over 10 seconds → **one** dot after the 15-second quiet timer; separate later burst → second dot.
- Agent without reliable start signal → `Grouped edits` fallback, not `Confirmed agent turn`.

If G2 fails, **do not build the visual timeline yet**.

## 7. Milestone 3 — Real agent adapters

**Goal:** replace synthetic lifecycle events with provider-supported, version-tested hooks.

| ID | Work item | Depends on | Acceptance |
|---|---|---|---|
| M3-01 | Build tiny hook-forwarder with bounded latency and fail-open behaviour | M2 | IDE/agent completes normally with Rewindry daemon unavailable |
| M3-02 | Install/update/remove Cursor hooks safely, preserving existing handlers | M0-02, M3-01 | Tested Cursor edition: paired outer turn produces one dot; uninstall preserves other hooks |
| M3-03 | Install/update/remove Claude Code hooks safely, preserving existing handlers | M0-03, M3-01 | Tested Claude Code edition: paired turn produces one dot; failure/subagent cases handled |
| M3-04 | Implement Codex CLI `notify` adapter with preservation/chaining of prior notifier | M0-04, M3-01 | Accurate end-only capability when start unavailable; never promises exact turn count |
| M3-05 | Add adapter capability registry keyed by provider/host/edition/version | M3-02–04 | Status identifies exact working hooks, missing start, missing end and unsupported hosts |
| M3-06 | Test two simultaneous agents and separate registered workspaces/worktrees | M3-05 | No false authorship; unregistered worktree activity not claimed observed |
| M3-07 | Regression test existing Cursor/Claude settings and Codex notify handlers | M3-02–04 | Rewindry never destroys existing third-party configs |

**Exit gate G3:** agent editions listed as supported pass real E2E boundary tests. Codex is allowed to ship as `end_only` or `Grouped edits` **if labelled accurately**; claiming full support requires proof of a start boundary as well as completion.

## 8. Milestone 4 — One-command installation and persistent operation

**Goal:** the developer never remembers an extra Rewindry start command.

| ID | Work item | Depends on | Acceptance |
|---|---|---|---|
| M4-01 | Implement environment detection, dry-run setup plan and permissions summary | M0-05, M1 | Correct repo, app, package manager and framework detected; unknown config not overwritten |
| M4-02 | Install stable versioned agent executable, LaunchAgent and one user-level worker registration | M4-01 | Survives closing terminal; no temporary npm cache path |
| M4-03 | Register workspace, install source watcher and first baseline under `.rewindry/` | M1, M4-02 | Baseline includes current eligible uncommitted source; no self-watch loops |
| M4-04 | Integrate provider adapters with approval, existing-config backup and merge logic | M3 | One setup command configures selected supported adapters safely |
| M4-05 | Install project Vite adapter without rewriting existing dev command when possible | M0-06 | `npm run dev` remains the user's command; unsupported config -> viewer fallback |
| M4-06 | Add `status`, `doctor`, `uninstall` and versioned migrations | M4-02–05 | Uninstall restores integration only; history kept unless explicitly deleted |
| M4-07 | Validate setup twice, upgrade, interrupted setup, rejected permission and OS restart | M4-06 | No duplicate service/hooks, no lost history and truthful `Limited capture` states |

**Exit gate G4:** install in a clean supported project using **exactly one command**. After closing the terminal, changing code without running `npm run dev` still records source snapshots. Running original `npm run dev` activates preview automatically. Uninstall leaves the app runnable and other hooks intact.

## 9. Milestone 5 — Visual capture and compact timeline

**Goal:** reproduce the basic reference experience before adding more detailed controls.

| ID | Work item | Depends on | Acceptance |
|---|---|---|---|
| M5-01 | Implement finalised-checkpoint visual queue with configured route/viewport variants | G2, M1 | Intermediate agent writes never enqueue capture; one visual job per changed turn |
| M5-02 | Implement Vite dev readiness/HMR integration and safe local URL config | M0-06, M5-01 | Detect dev server off, compiler failure and configured route readiness |
| M5-03 | Implement source-digest pre/post-capture validation, overlay hiding and safe Playwright context | M5-02 | Reject image if source moved; do not show current UI under old dot |
| M5-04 | Save image metadata, preview statuses, retry budget and storage quotas | M5-03 | All failures show explicit source-only state and stable checkpoint remains readable |
| M5-05 | Build loopback read-only API and SSE status/checkpoint feed, with token/Origin controls | M1, M5-04 | Path traversal, remote origin and mutating requests blocked |
| M5-06 | Inject dev-only hidden trigger and bottom-centred pill with one dot per iteration | M5-05 | UI matches supplied reference at minimum; production build contains zero overlay assets |
| M5-07 | Implement select, hover/focus thumbnail, play/pause, arrows, Home/End, Escape and responsive overflow | M5-06 | Works with 3, 30 and 1,000 dots, including source-only dots |
| M5-08 | Implement standalone localhost viewer for when dev app is unavailable | M5-05 | Can browse existing screenshots without starting app |
| M5-09 | Browser E2E: screenshot the correct final state after two agent turns | M5-01–08 | First dot not overwritten by second; no script/source changes during review |
| M5-11 | Capture configured named routes and app-marked DOM components at named viewport/device profiles; publish a screen/component and viewport chooser in both viewers | M5-04, M5-07, M5-08 | Up to 12 variants per checkpoint; one dot remains one source iteration; missing variants stay explicit; legacy `primary.png` works; old checkpoints are not backfilled automatically |
| M5-12 | Explicit historical visual backfill: replay each checkpoint's saved source in an isolated temp directory and add missing configured variants with replay provenance in both viewers | M5-11 | Requires `--run-historical-source`; history, digests and existing images unchanged; replayed images labelled; failed replays stay source-only; no installs or package scripts |

**Exit gate G5:** a fixture completes an agent prompt while Vite is running; configured route/component and viewport images are captured for the final recorded state and one dot appears. The chooser changes the image without moving that dot. Scrubbing shows recorded images; stopping Vite doesn't remove history; `vite build` produces no Rewindry UI/API/source assets.

## 10. Milestone 6 — Code inspection, Git import and release hardening

**Goal:** make the MVP genuinely useful beyond its screenshots and safe for public open-source adoption.

| ID | Work item | Depends on | Acceptance |
|---|---|---|---|
| M6-01 | Build immutable checkpoint file list, historical source panel and diff panel | G1, M5 | File bytes match selected checkpoint, not current source |
| M6-02 | Add Copy selected text, Copy file and Copy diff actions | M6-01 | Clipboard contains exact historical bytes/text; no write APIs |
| M6-03 | Index reachable Git commits and parent graph without altering Git | M1 | Git nodes distinct from agent/manual dots; shallow clone gaps disclosed |
| M6-04 | Add source-only and import-progress UI plus expanded timeline branch context | M6-03, M5 | Imported commits don't claim unavailable screenshots or agent provenance |
| M6-05 | Hardening: CSP, loopback auth, XSS-safe code rendering, symlinks, path escapes and API limits | M5, M6-01 | Security tests pass; remote web origin cannot fetch code |
| M6-06 | Performance and retention: lazy thumbnails, virtualised timeline, object reachability GC, quota messages | M5, M6-01 | No silent deletion of needed blobs; sensible 1,000-dot navigation |
| M6-07 | Run full platform/agent/version compatibility suite, failure injection and README validation | All | Capability claims grounded by passing tests; known gaps documented |
| M6-08 | Prepare MIT/Apache licence choice, contribution guide, SECURITY policy, release notes and source package audit | M6-07 | Public release has reproducible install/build, clear licence and no secrets |
| M6-09 | Run original PRD 25 acceptance criteria and map each to test case/evidence | All | All mandatory criteria pass on declared targets, or release is blocked |

**Exit gate G6 / MVP release:** a new developer reproduces the end-to-end journey with only the setup command and normal dev command. The UI is read-only, code history intact, active app unchanged, and compatibility status honest.

## 11. End-to-end acceptance matrix

Map each PRD v1.3 numbered acceptance criterion to a named test. Minimal coverage:

| PRD criterion(s) | Required test identifier | Milestone |
|---|---|---|
| 1–5 setup and service | `install.one-command`, `service.restart`, `install.idempotent`, `uninstall.preserve` | M4 |
| 6–12 turn boundaries | `turn.long-pause-one-dot`, `turn.two-prompts-two-dots`, `turn.duplicate-stop`, `turn.no-change`, `turn.failed`, `adapter.capability-matrix` | M2/M3 |
| 13–16 manual and overlap | `manual.multi-save-one-dot`, `manual.separate-bursts`, `overlap.two-agents`, `watcher.excludes-own-store` | M2 |
| 17–21 screenshots and timeline | `preview.finalised-only`, `preview.digest-race`, `timeline.keyboard`, `build.no-overlay`, `viewer.offline` | M5 |
| 22–25 Git, copy, resilience, storage | `git.read-only-index`, `code.copy-immutable`, `store.crash-recovery`, `store.repo-local` | M6 |

Save automated test reports and a manual evidence log in the repository. Tests involving external agents must list exact observed host versions. A mocked adapter passing does **not** qualify the real provider as supported.

## 12. Proposed user-journey test script

1. Create the fixture React/Vite project and initialise Git with a few commits.
2. Run `npx rewindry@latest setup` once, approve user-level service registration, and note detected agent support.
3. Close the setup terminal; manually change two files with separate saves inside 15 seconds; wait. Confirm **one** grouped dot.
4. Start a supported agent turn: prompt it to redesign the dashboard; allow edits and pauses; ensure zero new dots while the turn runs and **one** after it completes.
5. Prompt the agent a second time to revise typography; confirm exactly one more dot after completion.
6. Start the app with its original `npm run dev`; open the local page and reveal Rewindry with its small bottom trigger. Scrub/read the stored previews; when a dot lacks a screenshot, see an explicit source-only placeholder.
7. Inspect a historical file and Copy. Confirm content is from the selected checkpoint.
8. Hash the source tree before and after all viewer interactions; values must match exactly.
9. Stop dev server and agent process; relaunch after OS/login as supported. Confirm source history remains and status reports accurately.
10. Run production build and inspect assets for absence of Rewindry viewer/source/history APIs.
11. Uninstall Rewindry and check existing agents/dev scripts still work and history is retained.

## 13. Risk register and early mitigation

| Risk | Severity | Mitigation | Release condition |
|---|---|---|---|
| No reliable outer-turn start event in a provider | High | Edition-based capability matrix; end-only fallback truthful | Do not advertise one-per-prompt for unsupported host |
| Capture screenshot after source advances | High | Hash-before/after and readiness checks; unavailable frame | Zero known mismatched visuals in test suite |
| Installer modifies other tools' hooks | High | Config-aware edits, backup, chaining and uninstall tests | Repeated setup/uninstall preserves existing handlers |
| OS service fails on login/sleep | High | Stable binary, health checks, rescan on wake, limited-mode status | Declared macOS targets pass lifecycle tests |
| Dev server exposes historical source on LAN | High | Loopback service, origin/token, standalone viewer when unsafe | Security tests block remote access |
| Two concurrent agents share one tree | Medium/high | Workspace leases, overlap provenance, no false file ownership | Tests disclose mixed state |
| Unknown agent mistaken for manual | Medium | Neutral `Grouped edits` label by default | UI never calls unknown activity a confirmed prompt |
| Deep Git history slows setup | Medium | Background incremental indexing and lazy object reads | Initial baseline capture unaffected |
| Many screenshots fill disk | Medium | Compression, quota and retention policy | Source history persists; explicit visual failure |
| Secrets accidentally snapshotted | High | Default ignore policies, source limits, warning, no remote upload | Secret/path tests pass; documented limits |
| Framework config incompatible with injection | Medium | No blind rewrites; standalone viewer | Existing dev build stays intact |

## 14. Suggested first coding session

A coding agent should start with the following small slice, **not** the UI:

1. Inspect the repository, runtime and existing project conventions; write down differences from this plan.
2. Create the workspace package skeleton, `AgentEvent` schema and fake-agent test harness.
3. Write failing tests for a 20-write turn with a 60-second pause and one completion; a manual edit burst; duplicate completion; and no-change completion.
4. Implement event journal + turn manager + manual grouping until those tests pass.
5. Wire the finaliser to an immutable full-tree manifest/store and demonstrate one source checkpoint per completed turn.
6. Only then implement the real agent adapters, one-command installer and screenshot timeline.

**Do not start by shipping a visually convincing mock timeline over dummy data.** The central risk is checkpoint boundary correctness and screenshot attribution, not the visual difficulty of drawing dots.

## 15. Deliverable structure and document handoff

Keep all three documents accessible to the coding agent:

```text
/docs/product/rewindry_mvp_prd_v1_3.md
/docs/engineering/rewindry_technical_spec_mvp_v1.md
/docs/engineering/rewindry_implementation_plan_mvp_v1.md
```

As the implementation evolves, add only these short living documents:

- **`AGENTS.md` (recommended):** 1–2 pages of repository commands, architecture map, source-of-truth documents, test commands, conventions and prohibited MVP scope. The agent should read it before each coding session.
- **`docs/compatibility.md` (required by M0):** exact tested Cursor, Claude Code, Codex CLI, OS and Vite editions/versions; which support paired boundaries, end-only events or grouped fallback.
- **`docs/decisions/ADR-*.md` (only when needed):** one small decision record for a disputed architecture choice (e.g. event transport, preview verification or framework injection).
- **`docs/test-evidence.md` (required for release):** fixture/test ID, result, environment, date and remaining defects. Never mark untested support as verified.

A standalone UI spec is optional until there is ambiguity about the bottom-dot timeline. Do not spend time producing a long design-system document before the capture engine works.

## 16. Reference links and scope

- Product requirements: `rewindry_mvp_prd_v1_3.md`.
- Technical model, schemas and API: `rewindry_technical_spec_mvp_v1.md`.
- Official Cursor hook documentation: https://cursor.com/docs/hooks
- Official Claude Code hook documentation: https://code.claude.com/docs/en/hooks
- Official Codex CLI `notify` configuration: https://developers.openai.com/codex/config-advanced
- Vite plugin development-only integration: https://vite.dev/guide/api-plugin.html

**Build principle:** an accurate, incomplete visual history is more useful than a confident but inaccurate one. Ship only verified iteration boundaries and visuals; make gaps visible.

---

## Design and product engineering review addendum — proposed, 10 October 2026

**Status:** The minimal timeline behavior is user-confirmed; the delivery-order changes remain proposals. The original milestones remain above for comparison. The first two gates below test the product and technical assumptions before a full implementation commitment.

### Change summary

| Original plan | Proposed change | Reason |
| --- | --- | --- |
| M0 is mainly provider and platform feasibility | Add a simple iteration-navigation test and visual-availability study | Technical capture can work while navigation remains confusing or visuals are usually absent |
| M1 creates all nine packages | Start with internal modules, extract packages when needed | Reduce release and interface overhead before real behavior is proven |
| M4 automates invasive setup before visual validation | Prototype the full journey in one fixture first; automate the proven path afterward | Avoid hardening installation for a workflow users may not value |
| M5 accepts source pre/post hashes as visual verification | Require preview identity/build-generation evidence and honest fidelity labels | Hashes alone do not prove which UI the browser rendered |
| M5 exposes history through overlay/API | Isolate source viewer from preview-origin scripts | Avoid giving the app page a source-reading capability |
| M6 makes Git import, playback, and code inspection one MVP gate | Defer these unless needed for iteration navigation; keep security/integrity gates mandatory | Protect the lightweight timeline without weakening trust |

### Revised delivery gates

**G0-P — Product proof, before implementation:** Build a clickable or lightweight prototype with 3 visual states. Observe 5–8 design engineers moving to an earlier iteration and back to the current working state. Record whether they understand the sequence without instruction. The UI should show the visual and time, with the live current state last; do not add thumbnails, changed-file counts, provenance choices, lanes, or filters. Exit with a decision on this minimal navigation behavior.

**G0-T — Technical proof, before architecture lock:** In one React/Vite fixture on one declared macOS/Node combination, demonstrate: a real paired outer-turn adapter; 20+ writes with a long pause producing one source checkpoint; HTML/style/asset/config coverage; a dev preview handshake tied to the right workspace and rebuild generation; and a screenshot rejected on stale compile or source change. Do not expose historical source to preview-page scripts. Keep sanitized fixtures and exact version results. If any proof fails, narrow the declared support or change the product claim before M1.

**G1 — Thin vertical slice:** Build the minimal durable event journal, finaliser, source store, one adapter, screenshot worker, and read-only viewer as internal modules. One real turn should create one navigable historical position with, when preview evidence is sufficient, one visual; the live current state remains the final position. A stopped preview should produce a short unavailable state for that historical position. Test atomic publication, restart replay, and per-workspace isolation. This slice may use a developer launch command; it is an engineering demonstration, not the promised public install experience.

**G2 — Supported install:** Turn that proven path into one-command setup with a stable user-level runtime. Show planned config changes before applying them; preserve hooks; test rerun, uninstall, machine restart, moved repo, and permission denial. Default included files and preview URL must be inspectable before baseline capture. Publish an exact support matrix for this path.

**G3 — First public release:** Run the earlier-iteration-to-current navigation task on a real UI project. Require no false confirmed-turn dots, no wrong-source screenshots, no project writes from viewing, and a short unavailable state for visual gaps. If source inspection is added, require that preview-origin scripts cannot read it. Include Git import, extra agent adapters, playback, or code inspection only if the real-project trial shows one is necessary for this navigation task. Record accepted deferrals against the old §2 definition of done so the release claim is honest.

### Concrete work items to insert into the existing plan

1. **Before M0-01:** Write a three-state visual navigation fixture and observation script. Verify that users can move to an earlier visual and return to the live current state without extra controls.
2. **During M0-01/M0-06:** Test two apps in one repo and two linked worktrees; document checkout/app identity and include-policy coverage. Make a Vite build-generation handshake part of the visual demo.
3. **During M1-02/M1-05:** Put include-policy version, checkout ID, app ID, and known uncaptured input classes in the manifest. Use one durable checkpoint publication point and a replay high-water mark.
4. **During M2:** Add delayed/reordered hook, stale lease, sleep/wake, and manual-before-agent boundary fixtures. Assert `ambiguous_boundary` rather than a fabricated confirmed turn.
5. **If code inspection is added at M5/M6:** Test same-origin preview scripts against the source API. Keep code bytes and credentials only in an isolated loopback viewer origin; overlay receives status and navigation only.
6. **During M5-03:** Record preview server ID, workspace/app binding, rebuild generation, route, viewport, readiness result, source digest, and known fidelity limits with every image.
7. **During M6-06:** Define separate source/image budgets and the behavior at quota before implementing retention. Do not silently delete referenced blobs.

### Exit evidence and stop conditions

- Keep the original PRD's 25 acceptance tests as the full-scope reference. Once the first-release scope is chosen, mark each **required now**, **deferred with reason**, or **replaced by a stronger test**. Never report a deferred test as passing.
- Every declared agent edition needs a real captured event fixture; mocked events prove only the state machine.
- Every screenshot fixture must record both source association and preview-generation evidence. A source hash by itself is insufficient for the stronger visual claim.
- A source-reading token reachable by preview-page JavaScript blocks release of the embedded code viewer.
- If the navigation test fails, first simplify the sequence and current-state behavior; add a control only when the observed failure requires it.
- If users rarely have an active preview during the target task, revise onboarding and the visual-first promise before broad installation work.

**Document hygiene:** The original headers and §15 refer to `rewindry_mvp_prd_v1_3.md`, `rewindry_technical_spec_mvp_v1.md`, and a lowercase `/docs/...` tree. Those paths do not exist in this repo. The actual files are the three documents in `DOCS/` linked from [the document index](README.md). Use these paths in coding handoffs; update the original references only when a revised edition is approved.
