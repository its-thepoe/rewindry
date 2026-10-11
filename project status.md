# Rewindry project status

Updated: 11 October 2026

Legend: 🟢 done · 🟡 in progress · 🔴 blocked · ⚪ not started. A milestone is green only when its exit gate has evidence.

Maintenance: update affected rows at the start and end of every implementation turn; never promote a row without test or observed-host evidence.

## At a glance

| Phase | Status | Exit gate / current evidence |
| --- | --- | --- |
| G0-P Product proof (proposed addendum) | 🔴 blocked | Five to eight external design-engineer observations require participants; no results yet. |
| M0 / G0-T Feasibility | 🟡 in progress | React/Vite, Codex 0.144.4 and a two-workspace macOS LaunchAgent restart are verified; authenticated Cursor/Claude probes remain blocked. |
| M1 / G1 Foundation and storage | 🟡 in progress | Immutable store, multi-root isolation, process-kill recovery, moved-repo rebind and injected watcher-error reconciliation pass; hosted CI remains. |
| M2 / G2 Turn manager | 🟡 in progress | Synthetic G2 boundary suite passes, including stale/delayed hooks and failed boundary splits. Queue bounds and overlap metadata pass; real-host boundary coverage remains. |
| M3 / G3 Agent adapters | 🟡 in progress | Codex CLI 0.144.4 is verified, with hook trust still user-mediated; Cursor is not logged in and Claude Code CLI is not installed. |
| M4 / G4 Installation and daemon | 🟡 in progress | Multi-workspace registry and isolated daemon routing pass; OS sleep/wake, reboot and real permission-denial checks remain. |
| M5 / G5 Visual capture and timeline | 🟢 done | Overlay and viewer use the 6px segmented stepper; browser E2E verifies desktop/mobile, keyboard, playback and 1,000-point history after sizing changes. |
| M6 / G6 Code, Git and release | 🟡 in progress | Code/diff/copy, Git progress, quotas and local tarball smoke pass; public release validation and external observations remain. |
| Revised G1 thin vertical slice | 🟢 done | Real Codex-plus-Vite vertical slice, process-kill recovery, and real two-root LaunchAgent restart/isolation pass. |
| Revised G2 supported install | 🟡 in progress | One-command install/uninstall, moved-repo recovery and real multi-root service pass; real permission denial remains. |
| Revised G3 first public release | 🔴 blocked | External real-project navigation observations and full release validation are missing. |

## M0 — Feasibility spikes

| ID | Status | Evidence / next step |
| --- | --- | --- |
| M0-01 Fixture React/Vite and Git repo, eligible files | 🟢 done | React/Vite browser fixture and disposable two-commit/shallow Git fixture pass; source include policy is tested. |
| M0-02 Cursor paired outer-turn probe | 🟡 in progress | Cursor IDE 3.24.9 and Cursor Agent 2026.07.23-e383d2b found; real event fixture needed. |
| M0-03 Claude Code lifecycle probe | 🟡 in progress | Claude desktop 2.31226.1 found; real event fixture needed. |
| M0-04 Codex CLI start/end probe | 🟢 done | Local Codex 0.144.4 emitted `UserPromptSubmit` and `Stop` with the same session/turn IDs in a read-only disposable turn; sanitized fixture retained. |
| M0-05 macOS LaunchAgent proof | 🟡 in progress | Disposable user-level service bootstrapped, reported baseline, survived `launchctl kickstart -k` with a new PID and one preserved checkpoint, then uninstalled; permission-denied probe pending. |
| M0-06 Vite dev overlay and screenshot proof | 🟢 done | Vite 8.3.4 serves dev-only overlay, excludes it from production, waits for request idle, captures correct final tree and rejects digest/generation races and compiler errors. Existing-tab HMR state remains a stated fidelity limit. |
| M0-07 Supported version matrix | 🟢 done | `DOCS/compatibility.md` records verified macOS/Node, React/Vite and Codex editions and labels Cursor/Claude and other environments unverified. |

## M1 — Repository foundation and immutable storage

| ID | Status | Work item |
| --- | --- | --- |
| M1-01 | 🟡 | TypeScript project and macOS CI workflow added; hosted CI/lint are the remaining checks |
| M1-02 | 🟢 | Versioned event validation, canonical-root workspace ID, turn IDs and checkpoint kinds pass; new manifests identify checkout (stable over move), configured app, policy version and uncaptured input classes |
| M1-03 | 🟢 | Eligible file policy and symlink/path protection tests pass |
| M1-04 | 🟢 | Observer source-write/self-exclusion and missed-event rescan reconciliation pass; duplicate watched events signal once per changed tree |
| M1-05 | 🟢 | Immutable full-tree blobs and deterministic manifest tests pass |
| M1-06 | 🟢 | Versioned SQLite migration, atomic publication and journal pass; injected database failure and real child-process kill before commit leave old history readable and restart recovers |
| M1-07 | 🟢 | Version 2 checkpoint path index migrates/backfills existing manifests and publishes atomically with new checkpoints; same-tree, deletion and history tests pass |
| M1-08 | 🟢 | Corrupt-object/oversize, disk-full recovery, and injected watcher-overflow reconciliation pass; watcher failures remain visible as degraded diagnostics |

## M2 — Turn manager and manual fallback

| ID | Status | Work item |
| --- | --- | --- |
| M2-01 | 🟢 | Synchronous event ingest has no pending queue; 32 concurrent socket clients and 64 KiB per-message cap pass, with journal dedupe/validation tests |
| M2-02 | 🟡 | Long-pause turn test passes; state coverage incomplete |
| M2-03 | 🟢 | Settling, actual multi-file write, no-change and consecutive-turn tests pass |
| M2-04 | 🟢 | Fake-clock multi-save/separate-burst tests pass |
| M2-05 | 🟢 | Long-pause suppression and pending unattributed-write transition pass tests |
| M2-06 | 🟢 | Duplicate, failure, stale timeout, delayed-write and finish-before-start cases pass tests |
| M2-07 | 🟢 | Overlap never claims a confirmed turn; grouped checkpoint persists `overlap` provenance and both timeline feeds label mixed activity |
| M2-08 | 🟡 | Fake-clock and filesystem suites include reordered finish, stale lease, delayed write, manual-before-agent and failed settle-boundary split; real-host and sleep/wake matrix pending |

## M3 — Agent adapters

| ID | Status | Work item |
| --- | --- | --- |
| M3-01 | 🟢 | Bounded fail-open forwarder and real Codex hook-to-socket-to-daemon edit turn pass |
| M3-02 | 🔴 | Project-local Cursor hook merge/uninstall tests pass; real probe blocked because Cursor Agent CLI reports not logged in |
| M3-03 | 🔴 | Project-local Claude hook merge/uninstall tests pass; real probe blocked because Claude Code CLI is not installed |
| M3-04 | 🟡 | Codex 0.144.4 paired hook, real edit capture and project hook install pass; legacy notify chaining remains unverified |
| M3-05 | 🟡 | Capability registry names Codex CLI 0.144.4 as the only verified edit/turn edition; Cursor/Claude have fixture-only adapters |
| M3-06 | 🟢 | Linked Git worktrees retain separate source history and app provenance; one daemon routes events and reports status independently for multiple roots |
| M3-07 | 🟡 | JSON merge/uninstall preserves existing handlers in fixture tests; real user configs not exercised |

## M4 — Installation and persistent operation

| ID | Status | Work item |
| --- | --- | --- |
| M4-01 | 🟢 | Vite/package-manager preflight, no-write dry-run and explicit project/user-service access summary pass |
| M4-02 | 🟢 | Stable versioned runtime fixture tests and real LaunchAgent bootstrap/restart/uninstall pass |
| M4-03 | 🟢 | Version 2 registry and real macOS LaunchAgent probe add two roots, survive `kickstart`, route status independently and remove one root without interrupting the other |
| M4-04 | 🟡 | Normal setup installs verified Codex 0.144.4 project hooks with merge/recovery and combined CLI E2E; Codex trust review remains user-mediated. Cursor/Claude remain disabled. |
| M4-05 | 🟢 | TypeScript-parser Vite adapter preserves the original dev command; real Vite E2E proves automatic port registration, captures and exact config restoration; unsupported shapes fall back to viewer |
| M4-06 | 🟢 | Status, doctor and uninstall tests pass; degraded capture reports errors, version 2 path-index migration/backfill and upgrade rollback pass |
| M4-07 | 🟡 | Idempotency, upgrade rollback, uninstall, denied-bootstrap fixture and LaunchAgent restart pass; OS sleep/wake, reboot and actual permission denial remain |

## M5 — Visual capture and timeline

| ID | Status | Work item |
| --- | --- | --- |
| M5-01 | 🟢 | Runtime queue test and two-turn browser E2E show one attempt per final changed turn |
| M5-02 | 🟢 | Local-only URL, automatic Vite port/app registration, request-idle proof and compiler-error/offline detection pass browser E2E |
| M5-03 | 🟢 | Source pre/post digest, generation-race rejection, overlay hiding and safe Chromium context pass; fresh-page fidelity limit is explicit |
| M5-04 | 🟢 | Source-only/captured metadata, 4 MiB image and 256 MiB workspace limits, symlink checks and one bounded automatic Vite-start retry pass tests/E2E |
| M5-05 | 🟢 | Cookie-isolated loopback source API, origin/mutation guards and authenticated SSE checkpoint feed pass tests |
| M5-06 | 🟢 | Overlay visibly renders 6px segments and compact chevrons; measured active segment 24×6px and bar 198×42px |
| M5-07 | 🟢 | Browser E2E after sizing change verifies focus/keyboard selection, play/pause, desktop/mobile fit and 1,000-point overflow navigation |
| M5-08 | 🟢 | Standalone viewer visibly matches the 6px segments and compact controls; measured active segment 24×6px and bar 226×42px |
| M5-09 | 🟢 | Real Codex-plus-Vite probe captured the final `State B` UI; automatic-Vite two-turn E2E proves distinct immutable images, exact source bytes, read-only overlay and production exclusion |

## M6 — Code, Git and release

| ID | Status | Work item |
| --- | --- | --- |
| M6-01 | 🟢 | Isolated viewer historical file/diff inspection verified in browser |
| M6-02 | 🟢 | Copy actions and exact clipboard content verified in browser |
| M6-03 | 🟢 | Bounded read-only Git commit/parent index passes dirty-worktree and shallow-clone tests; viewer API/UI browser E2E passes |
| M6-04 | 🟢 | Source-only visual state, separate Git history band and visible indexing-progress state pass viewer browser E2E |
| M6-05 | 🟡 | Scoped security review found and fixed journal symlink traversal; core security surfaces reviewed, while report coverage remains partial for docs, fixtures, and example app |
| M6-06 | 🟢 | 1,000-point viewer browser check passes; 512 MiB default source-blob budget pauses new checkpoints without deleting history, separate image limits remain; quota test passes |
| M6-07 | 🟡 | Failure/recovery guide and evidence log are complete; real host/platform matrix, hosted CI, and user recovery study remain |
| M6-08 | 🟡 | Packed bin has executable mode/shebang; isolated tarball `setup --dry-run` works. Public npm release remains gated by external validation. |
| M6-09 | 🟢 | PRD criteria 1–25 mapped below to observed, synthetic or missing evidence |

## Proposed addendum work

| Work | Status | Evidence / next step |
| --- | --- | --- |
| Three-state navigation fixture and observation | 🔴 blocked | Fixture can be built locally; participant observations need users. |
| Two apps and two worktrees identity test | 🟡 | Multi-root service and linked-worktree fixture prove separate roots, histories and app IDs; two preview apps within one checkout remain. |
| Include-policy version, checkout/app IDs, uncaptured inputs | 🟢 | New manifests record policy v1, stable baseline-derived checkout ID, current configured preview app ID and known uncaptured input classes; older manifests remain readable. |
| Delayed/reordered hooks and stale-lease tests | 🟢 | Fake-clock suite proves late finish remains uncertain and a new turn cannot claim writes from a previous unsettled turn, including failed boundary publication. |
| Isolated source viewer origin | 🟢 | Cookie-isolated loopback source API and preview-origin rejection pass tests. |
| Preview server ID and rebuild evidence | 🟢 | Server ID and generation are recorded, compared pre/post and race-tested. |
| Separate source/image budgets | 🟢 | Independent source-blob and image budgets pass tests; source cap pauses capture without deleting prior checkpoints. |

## Acceptance and decisions

- PRD criteria 1–25 are mapped below. A passing mocked adapter does not count as real provider support.
- Supported environments: observed macOS arm64 / Node 26.0.0 / React 19 / Vite 8.3.4 / Codex CLI 0.144.4; exact scope and caveats are in `DOCS/compatibility.md`.
- Existing `DOCS/` files are currently untracked while root copies are marked deleted. Preserve that user state.
- Current gate: Codex hook trust review, authenticated Cursor/Claude probes, sleep/reboot, hosted CI, external recovery observations, and release validation. Unit suite: 70 passing; typecheck, production build and browser E2E pass. Real one-command setup/uninstall, two-workspace LaunchAgent install/restart/removal, Codex 0.144.4 plus Vite visual capture and automatic-Vite browser E2E pass.

## PRD release criteria

Statuses below refer to the numbered criteria in `DOCS/rewindry_mvp_prd.md` section 20. Green means the stated behavior has direct local evidence; yellow means partial or synthetic evidence, not a release claim.

| Criterion | Status | Evidence / gap |
| --- | --- | --- |
| 1 One-command setup and baseline | 🟡 | Real disposable setup passed; Codex hook trust review still needs the user. |
| 2 Terminal/IDE/dev-server restarts | 🟡 | LaunchAgent restart and Vite restart passed; IDE restart not exercised. |
| 3 Machine restart/sleep | 🟡 | Service kickstart preserved history; machine sleep/reboot not exercised. |
| 4 Unsupported OS/denied permission | 🟡 | Unsupported setup guard, degraded daemon health and denied-bootstrap rollback test pass; real OS permission denial pending. |
| 5 Repeat setup/uninstall | 🟡 | Fixture idempotency and real setup/uninstall pass; real repeat cycle pending. |
| 6 Long multi-write agent turn | 🟡 | Synthetic 20-write/60-second case passes; real Codex long multi-write turn pending. |
| 7 Consecutive changed turns | 🟡 | Synthetic and browser two-turn runs pass; real agent two-prompt run pending. |
| 8 Repeated/subagent callbacks | 🟡 | Adapter and turn fixtures pass; real host callbacks pending. |
| 9 No-change/failed prompt | 🟡 | Deterministic turn tests pass; real host failed turn pending. |
| 10 Final tree and turn identity | 🟢 | Real Codex edit produced one correctly identified immutable final checkpoint and matching Vite PNG. |
| 11 Truthful unsupported fallback | 🟢 | Status/doctor and adapters reserve confirmed turns for verified paired boundaries. |
| 12 Separate host validation | 🟡 | Codex CLI 0.144.4 verified; Cursor and Claude Code remain unverified and disabled by setup. |
| 13 Multi-file quiet grouping | 🟢 | Deterministic clock and filesystem runtime grouping tests pass. |
| 14 Separate sessions/active pause | 🟡 | Deterministic 60-second pause and separate-burst tests pass; real 30-second agent pause pending. |
| 15 Simultaneous attribution | 🟡 | Overlap warning, persistent mixed-tree provenance and no false confirmed checkpoint pass; real simultaneous host test pending. |
| 16 No self-capture | 🟢 | Observer excludes `.rewindry`, generated directories and private paths. |
| 17 Final-only capture job | 🟢 | Runtime queue and automatic-Vite browser tests show one job per final changed turn. |
| 18 Source-bound screenshot | 🟢 | Digest/server-generation race tests reject mismatched visuals; source-only fallback is shown. |
| 19 Dev-only read-only timeline | 🟢 | Desktop/mobile browser E2E verifies playback, scrub, history and no source mutation. |
| 20 Production exclusion | 🟢 | Browser E2E verifies production build omits overlay and control endpoints. |
| 21 Offline standalone viewer | 🟢 | Standalone viewer browser flow shows existing screenshots and code without dev server. |
| 22 Read-only Git ancestry | 🟢 | Dirty-worktree/shallow Git tests and viewer browser E2E pass without changing refs/source. |
| 23 Read-only file/diff/Copy | 🟢 | Browser E2E verifies exact clipboard content and no restore/apply API. |
| 24 Failure resilience | 🟡 | Publication failure, process kill, offline preview, corrupt object and hook fail-open tests pass; injected disk-full pauses capture and recovers; real full disk pending. |
| 25 Local project-owned history | 🟢 | Store, previews and indexes live under `.rewindry`; user LaunchAgent holds operational registration only. |
