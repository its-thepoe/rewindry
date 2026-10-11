# Rewindry project status

Updated: 11 October 2026

Legend: 🟢 done · 🟡 in progress · 🔴 blocked · ⚪ not started. A milestone is green only when its exit gate has evidence.

Maintenance: update affected rows at the start and end of every implementation turn; never promote a row without test or observed-host evidence.

Customer setup target: one Rewindry setup command discovers supported installed agents and merges their hooks automatically. Rewindry must not collect provider credentials or bypass a host's explicit project-trust prompt. Automatic hook installation is enabled for verified Codex CLI 0.144.4, Cursor IDE 3.24.9 and Claude Code 2.1.296 editions; Cursor's full edit-to-checkpoint support claim remains gated on real-host evidence. Provider sign-in requested below is for maintainer testing, not a requirement for every Rewindry user.

## At a glance

| Phase | Status | Exit gate / current evidence |
| --- | --- | --- |
| G0-P Product proof (proposed addendum) | 🔴 blocked | Five to eight external design-engineer observations require participants; no results yet. |
| M0 / G0-T Feasibility | 🟡 in progress | React/Vite, Codex 0.144.4, Claude Code 2.1.296, and Cursor IDE 3.24.9 lifecycle boundaries are verified; Cursor edit-to-checkpoint evidence remains. |
| M1 / G1 Foundation and storage | 🟢 done | Immutable store, multi-root isolation, process-kill recovery, moved-repo rebind and injected watcher-error reconciliation pass; hosted macOS CI passes clean root/example installs, typecheck, 74 tests, and visual E2E. |
| M2 / G2 Turn manager | 🟡 in progress | Synthetic boundary suite and two consecutive real Claude changed turns pass, including a three-file/30-second-pause turn; 100-write/60-second host stress and cross-host edge cases remain. |
| M3 / G3 Agent adapters | 🟡 in progress | Setup detects local agent versions without login and installs verified Codex, Cursor IDE 3.24.9, and Claude hooks automatically; Cursor edit-to-checkpoint evidence remains. |
| M4 / G4 Installation and daemon | 🟡 in progress | `0.1.3` setup and status report active capture in `case-files`; daemon now isolates dropped-client socket errors and the disconnect regression passes. OS sleep/wake, reboot and real permission-denial checks remain. |
| M5 / G5 Visual capture and timeline | 🟡 in progress | Published `0.1.3` now registers the Vite IPv6 loopback URL; the real project's preview endpoint responds. A captured visual from the restarted project is still unverified. |
| M6 / G6 Code, Git and release | 🟡 in progress | Public npm `rewindry@0.1.3` is verified as `latest`; broad host/platform matrix and external observations remain. |
| Revised G1 thin vertical slice | 🟢 done | Real Codex-plus-Vite vertical slice, process-kill recovery, and real two-root LaunchAgent restart/isolation pass. |
| Revised G2 supported install | 🟡 in progress | One-command install/uninstall, moved-repo recovery and real multi-root service pass; real permission denial remains. |
| Revised G3 first public release | 🔴 blocked | Public npm `0.1.3` is live; the product gate still needs external real-project navigation observations and broader release validation. |

## M0 — Feasibility spikes

| ID | Status | Evidence / next step |
| --- | --- | --- |
| M0-01 Fixture React/Vite and Git repo, eligible files | 🟢 done | React/Vite browser fixture and disposable two-commit/shallow Git fixture pass; source include policy is tested. |
| M0-02 Cursor paired outer-turn probe | 🟢 done | Cursor IDE 3.24.9 real `beforeSubmitPrompt` and `stop` payloads shared `conversation_id` and `generation_id`; sanitized fixture retained. Cursor CLI attempts are not counted as IDE evidence. |
| M0-03 Claude Code lifecycle probe | 🟢 done | Real Claude Code 2.1.296 `UserPromptSubmit` and `Stop` shared session/prompt IDs; sanitized fixture retained. |
| M0-04 Codex CLI start/end probe | 🟢 done | Local Codex 0.144.4 emitted `UserPromptSubmit` and `Stop` with the same session/turn IDs in a read-only disposable turn; sanitized fixture retained. |
| M0-05 macOS LaunchAgent proof | 🟡 in progress | Disposable user-level service bootstrapped, reported baseline, survived `launchctl kickstart -k` with a new PID and one preserved checkpoint, then uninstalled; permission-denied probe pending. |
| M0-06 Vite dev overlay and screenshot proof | 🟢 done | Vite 8.3.4 serves dev-only overlay, excludes it from production, waits for request idle, captures correct final tree and rejects digest/generation races and compiler errors. Existing-tab HMR state remains a stated fidelity limit. |
| M0-07 Supported version matrix | 🟢 done | `DOCS/compatibility.md` records verified macOS/Node, React/Vite, Codex and Claude editions and labels Cursor and other environments unverified. |

## M1 — Repository foundation and immutable storage

| ID | Status | Work item |
| --- | --- | --- |
| M1-01 | 🟢 | TypeScript project and macOS CI workflow pass on hosted macOS: pinned root/example install-script approvals, clean installs for both lockfiles, typecheck, 74 tests, and visual E2E all pass. Root cause was CI omitting `examples/vite-react` dependencies. |
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
| M2-02 | 🟢 | Acceptance gate now exercises 100 writes across 50 operations, a 60-second pause and self-correction; no checkpoint is published until the paired finish settles |
| M2-03 | 🟢 | Settling, actual multi-file write, no-change and consecutive-turn tests pass |
| M2-04 | 🟢 | Fake-clock multi-save/separate-burst tests pass |
| M2-05 | 🟢 | Long-pause suppression and pending unattributed-write transition pass tests |
| M2-06 | 🟢 | Duplicate, failure, stale timeout, delayed-write and finish-before-start cases pass tests |
| M2-07 | 🟢 | Overlap never claims a confirmed turn; grouped checkpoint persists `overlap` provenance and both timeline feeds label mixed activity |
| M2-08 | 🟡 | Fake-clock and filesystem suites include reordered finish, stale lease, delayed write, manual-before-agent and failed settle-boundary split; real Claude Code 2.1.296 turn made three separate file edits, paused 30 seconds, and produced one exact final-tree checkpoint; 100-write/60-second stress case and sleep/wake matrix remain pending |

## M3 — Agent adapters

| ID | Status | Work item |
| --- | --- | --- |
| M3-01 | 🟢 | Bounded fail-open forwarder and real Codex hook-to-socket-to-daemon edit turn pass |
| M3-02 | 🟡 | Cursor IDE 3.24.9 paired boundaries and project hook merge/uninstall tests pass; hooks are enabled for this verified edition. Latest real IDE probe on 11 Oct 2026 ended with the fixture unchanged and only an `unattributed_group`, so edit-to-checkpoint support is unverified. |
| M3-03 | 🟢 | Claude Code 2.1.296 real paired start/stop hooks and hook-to-daemon capture verified; two consecutive changed prompts produced two exact checkpoints, with three file edits and a 30-second in-turn pause on the first, on 11 Oct 2026; project-local merge/uninstall tests pass; setup auto-installs this edition. |
| M3-04 | 🟡 | Codex 0.144.4 paired hook, real edit capture and project hook install pass; legacy notify chaining remains unverified |
| M3-05 | 🟢 | Capability registry verifies Codex CLI 0.144.4, Cursor IDE 3.24.9 and Claude Code 2.1.296; version-selection tests pass. |
| M3-06 | 🟢 | Linked Git worktrees retain separate source history and app provenance; one daemon routes events and reports status independently for multiple roots |
| M3-07 | 🟡 | JSON merge/uninstall preserves existing handlers in fixture tests; real user configs not exercised |

## M4 — Installation and persistent operation

| ID | Status | Work item |
| --- | --- | --- |
| M4-01 | 🟢 | Vite/package-manager preflight, no-write dry-run and explicit project/user-service access summary pass |
| M4-02 | 🟢 | Stable versioned runtime fixture tests and real LaunchAgent bootstrap/restart/uninstall pass |
| M4-03 | 🟢 | Version 2 registry and real macOS LaunchAgent probe add two roots, survive `kickstart`, route status independently and remove one root without interrupting the other |
| M4-04 | 🟡 | No-write setup dry-run detects Codex, Cursor IDE (from the macOS app bundle), and Claude Code without login; it reports automatic hooks for all three verified editions. Cursor install discovery is verified, but accepting the latest IDE edit still did not change the fixture on disk; its edit-to-checkpoint integration is not yet verified. No manual config editing is expected from customers. |
| M4-05 | 🟢 | TypeScript-parser Vite adapter preserves the original dev command; real Vite E2E proves automatic port registration, captures and exact config restoration; unsupported shapes fall back to viewer; setup recognizes a project-owned preview plugin without rewriting it |
| M4-06 | 🟢 | Status, doctor and uninstall tests pass; degraded capture reports errors, version 2 path-index migration/backfill and upgrade rollback pass |
| M4-07 | 🟡 | Idempotency, upgrade rollback, uninstall, denied-bootstrap fixture and LaunchAgent restart pass; OS sleep/wake, reboot and actual permission denial remain |
| M4-08 | 🟢 | Customer setup exposed shared hook-registration collision across workspaces and false Vite unsupported result for an already-installed project plugin; workspace-scoped registrations, legacy single-workspace migration, moved-workspace rebind and project-owned Vite plugin recognition pass regression tests. All 76 unit tests, typecheck and browser/Vite E2E pass. |
| M4-09 | 🟢 | User reported setup rollback with `connect ENOENT .../daemon.sock`; LaunchAgent readiness now waits up to 30 seconds. The delayed-start regression passes, and published `0.1.2` setup plus `status` report active capture in the reported `case-files` project. |
| M4-10 | 🟢 | A short-lived daemon status probe exposed an unhandled socket error after client disconnect. Socket errors are now isolated per connection; the disconnect-then-status regression, all 80 unit tests, browser/Vite E2E and typecheck pass. |

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
| M5-10 | 🟡 | `case-files` Vite listens on `[::1]:3100`; Rewindry had advertised unreachable `127.0.0.1:3100`. Published `0.1.3` now registers `http://[::1]:3100/`, and the preview endpoint responds with `readiness: idle`; a real captured screenshot remains to be verified. |

## M6 — Code, Git and release

| ID | Status | Work item |
| --- | --- | --- |
| M6-01 | 🟢 | Isolated viewer historical file/diff inspection verified in browser |
| M6-02 | 🟢 | Copy actions and exact clipboard content verified in browser |
| M6-03 | 🟢 | Bounded read-only Git commit/parent index passes dirty-worktree and shallow-clone tests; viewer API/UI browser E2E passes |
| M6-04 | 🟢 | Source-only visual state, separate Git history band and visible indexing-progress state pass viewer browser E2E |
| M6-05 | 🟡 | Scoped security review found and fixed journal symlink traversal; core security surfaces reviewed, while report coverage remains partial for docs, fixtures, and example app |
| M6-06 | 🟢 | 1,000-point viewer browser check passes; 512 MiB default source-blob budget pauses new checkpoints without deleting history, separate image limits remain; quota test passes |
| M6-07 | 🟡 | Failure/recovery guide and evidence log are complete; hosted macOS CI now passes after adding the example dependency install. Broader host/platform matrix and user recovery study remain. |
| M6-08 | 🟢 | `rewindry@0.1.0` published publicly with `latest`; npm registry metadata and `npx rewindry@latest setup --dry-run` from another project both verified. |
| M6-09 | 🟢 | `rewindry@0.1.1` published after publish-specific web security-key approval; `npm view` confirms version and `latest` are both `0.1.1`. |
| M6-10 | 🟢 | `rewindry@0.1.2` is live as npm `latest`; published setup succeeded and `status` reports active capture in the reported `case-files` project. |
| M6-11 | 🟢 | `0.1.3` is published as npm `latest`; IPv4/IPv6 regression tests and visual E2E pass, and the reported project restarted with the expected IPv6 preview URL. |
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
- Current gate: a persisted Cursor IDE edit-to-checkpoint probe, 100-write/60-second host stress case, sleep/reboot, external recovery observations, and remaining release validation. Cursor IDE 3.24.9 paired lifecycle hooks have real evidence; the latest edit probe ended with an unchanged fixture and no agent-turn checkpoint. Claude Code 2.1.296 produced two sequential exact checkpoints; the first covered three file edits and a 30-second in-turn pause. Hosted macOS CI passes clean installs for both lockfiles, typecheck, 74 tests, and visual E2E. Public npm `0.1.2` is live and its published setup dry-run passes from the reported `case-files` project; real one-command setup/uninstall, two-workspace LaunchAgent install/restart/removal, Codex 0.144.4 plus Vite visual capture and automatic-Vite browser E2E pass.

## PRD release criteria

Statuses below refer to the numbered criteria in `DOCS/rewindry_mvp_prd.md` section 20. Green means the stated behavior has direct local evidence; yellow means partial or synthetic evidence, not a release claim.

| Criterion | Status | Evidence / gap |
| --- | --- | --- |
| 1 One-command setup and baseline | 🟡 | Real disposable setup passed; Codex hook trust review still needs the user. |
| 2 Terminal/IDE/dev-server restarts | 🟡 | LaunchAgent restart and Vite restart passed; IDE restart not exercised. |
| 3 Machine restart/sleep | 🟡 | Service kickstart preserved history; machine sleep/reboot not exercised. |
| 4 Unsupported OS/denied permission | 🟡 | Unsupported setup guard, degraded daemon health and denied-bootstrap rollback test pass; real OS permission denial pending. |
| 5 Repeat setup/uninstall | 🟡 | Fixture idempotency and real setup/uninstall pass; real repeat cycle pending. |
| 6 Long multi-write agent turn | 🟡 | Real Claude turn made three separate file edits, paused 30 seconds before finishing, and produced one exact checkpoint; synthetic 100-write/60-second-pause case passes; real 100-write/60-second host stress remains. |
| 7 Consecutive changed turns | 🟢 | Real Claude Code 2.1.296 ran two consecutive changed prompts in the same project; exactly two sequential checkpoints retained their respective exact final trees. |
| 8 Repeated/subagent callbacks | 🟡 | Adapter and turn fixtures pass; real host callbacks pending. |
| 9 No-change/failed prompt | 🟡 | Deterministic turn tests pass; real host failed turn pending. |
| 10 Final tree and turn identity | 🟢 | Real Codex and Claude edits each produced one correctly identified immutable final checkpoint with the exact final source bytes; Codex also matched the Vite PNG. |
| 11 Truthful unsupported fallback | 🟢 | Status/doctor and adapters reserve confirmed turns for verified paired boundaries. |
| 12 Separate host validation | 🟡 | Codex CLI 0.144.4, Cursor IDE 3.24.9 lifecycle hooks, and Claude Code 2.1.296 verified; accepting the Cursor IDE edit still did not update the fixture on disk, so edit-to-checkpoint validation remains. |
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
