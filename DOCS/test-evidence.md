# Rewindry test evidence

Updated: 11 October 2026. This log distinguishes real host observations from fixtures; `project status.md` is the release-gate tracker.

| Evidence | Environment | Result | Limit |
| --- | --- | --- | --- |
| `npm run typecheck` | Local macOS arm64, Node 26.0.0 | Pass | Hosted CI not yet observed. |
| `npm test` | Local macOS arm64, Node 26.0.0 | 70/70 pass | Includes synthetic Cursor/Claude boundaries, not real-host validation. |
| Codex Security standard review | Pinned local Rewindry snapshot, macOS single-user threat model | One low-severity journal symlink path finding; fixed in working tree with `O_NOFOLLOW`, descriptor checks, and two passing regressions. | Report coverage is partial; docs, fixtures, and example app were not individually audited. No vulnerable-version trigger was executed. |
| Failure/recovery guide | `DOCS/failure-recovery.md` compared with current CLI/status behavior | Covers offline daemon, moved/unregistered workspace, storage budget, preview failures, watcher/journal diagnostics, permission errors, standalone history viewer, and known limits. | User-recovery study and real host failure matrix remain open. |
| Filesystem symlink protection | Disposable local config, journal file/directory, and external targets | Install rejects symlinked configs; journal open rejects a symlinked file or directory with targets unchanged; Vite uninstall rejects symlinked metadata. | Same-user processes remain within the local trust boundary. |
| Compact timeline visual check | Running Vite overlay and standalone viewer in desktop browser | Both show 6px progress segments; overlay bar measured 198×42px, standalone bar 226×42px. | Keyboard, mobile, and long-history checks are tracked separately by the browser E2E row. |
| Manifest provenance and linked worktrees | Disposable local Git repo with one linked worktree | Checkout identity remains stable over move; separate worktrees retain separate histories and configured app IDs; uncaptured inputs are named. | Two preview apps within one checkout remain unsupported. |
| Multi-workspace LaunchAgent | Disposable macOS user service with two independent project roots | Both roots register, retain independent baseline/status, survive `launchctl kickstart -k`, and removing the primary leaves the second service active. | OS sleep/reboot and actual permission denial remain untested. |
| Watcher error recovery | Injected filesystem-overflow error in disposable observer | Immediate digest reconciliation records a missed tree change once and keeps a degraded diagnostic. | Native OS-level FSEvents overflow not induced. |
| Delayed/reordered turn boundaries | Deterministic fake-clock suite | Late finish after stale lease stays unattributed; a new turn splits previous unsettled writes, and a failed split cannot produce a confirmed checkpoint. | Real multi-host and sleep/wake behavior not exercised. |
| Storage fault injection | Disposable child process and SQLite store | SIGKILL after object/manifest write but before publication leaves prior history readable; restart captures changed tree. Injected ENOSPC reports paused and then recovers. | Real disk-full device not exercised. |
| Explicit moved-repo rebind | Disposable moved workspace, v1 history, Vite and Codex hook configs | Requires `--rebind-moved`; migrates old manifests/path index, refreshes integrations and preserves uninstall restoration. | Module tests, not a real moved-service CLI run. |
| `npm run test:e2e` | Playwright Chromium, React 19, Vite 8.3.4 | Pass | Disposable app with synthetic paired turn events; desktop/mobile, keyboard, playback, compact 6px markers and 1,000-point history checked. |
| `tests/probes/codex-hooks.mjs` | Codex CLI 0.144.4 | Real `UserPromptSubmit` and `Stop` shared session and turn IDs; sanitized fixture retained. | Hook trust still requires user review. |
| `tests/probes/codex-edit.mjs` | Codex CLI 0.144.4, local daemon | One real edit produced one immutable final agent checkpoint. | Single-turn probe. |
| `tests/probes/codex-vite.mjs` | Codex CLI 0.144.4, React/Vite, Chromium | Final `State B` source and screenshot matched one confirmed checkpoint. | Fresh-page rendering, not existing-tab HMR state. |
| `tests/probes/launchagent.mjs` | Disposable macOS user LaunchAgent, two roots | Both roots start, new PID after kickstart, both baselines persist, and primary removal preserves the second workspace. | Sleep/reboot and actual permission denial not run. |
| `tests/probes/one-command.mjs` | Disposable React/Vite project and macOS user service | One-command setup installed service, Vite adapter and Codex hooks; uninstall restored config/hooks and kept history. | Public npm package and user hook trust not tested. |
| `npm pack` and isolated tarball install | Local macOS arm64, Node 26.0.0 | Executable bin/shebang verified; installed `rewindry setup --dry-run` succeeded. | Package remains private and unpublished. |

Open evidence: real Cursor IDE and Claude Code turns, simultaneous real hosts, machine sleep/reboot, denied OS service registration, external 5-8-person navigation/recovery study, hosted CI, and public package install.
