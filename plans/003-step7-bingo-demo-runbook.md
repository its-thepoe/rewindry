# Plan 003 step 7 runbook: validate screen and component history on bingo-demo

> Status: **planned only.** Nothing in bingo-demo, its `.rewindry/` store or the Rewindry daemon has been changed. Every phase that writes outside this repository needs an explicit go-ahead from the user first.
>
> Written 27 October 2026 against branch `plan-003-attribution-spike` at `919113d`.

## What this run must show

The user's question from the bingo-demo work was: *how did the bingo board (and the home page, sheets and dialogs) improve across iterations, on mobile?* The run passes when, on the Screens page, the user can pick:

- the **board component**, at **Mobile**, and see its real versions in order, with unchanged updates hidden;
- the **home screen** at Mobile and Desktop;
- at least one **dialog or sheet**, such as `BingoConceptDetailDialog`, `CashOutSheet` or `GroceryItemDetailDialog`, that only appears after clicks, including closing the welcome popup.

The user also needs to agree that the history matches their memory. Capture time per update and backfill time per checkpoint are measured and recorded.

## Facts found (read-only inspection, 27 Oct 2026)

| Fact | Evidence | Consequence |
| --- | --- | --- |
| React **18.3.1**, `@vitejs/plugin-react` 4.7.0, Vite **6.4.4** | `2-source/node_modules/*/package.json` | **Blocker for component zoom.** Attribution reads React 19's `_debugStack`; React 18 keeps `_debugSource` (absolute file path) instead, so every component would be unattributed and only screen history would work. Vite 6 is also untested; verified is 8.3.4. |
| Layout is `h-dvh overflow-hidden` with an inner `overflow-y-auto` scroller | `src/demo/main.tsx` `DemoApp` | **Blocker for below-the-fold crops.** A full-page screenshot only covers the viewport here, so components further down the inner scroller (likely parts of the board on mobile) are cut off or missing. |
| Welcome popup opens on **every** load (`welcomeOnLoad`), not remembered | `src/demo/main.tsx`; no storage flag for it | Good for replay: learned paths will include "close welcome", which matches a fresh capture browser. |
| In-memory fake backend; a few `localStorage` "seen" keys for rows and verified squares | `src/demo/fakeBackend.ts`, `useBingoRows.ts`, `useVerifiedSquares.ts` | Data is deterministic. "Newly seen" highlights can differ from the user's tab because capture contexts start with empty storage. |
| Board option is React state switched from `DemoControls`, not in the URL | `src/demo/main.tsx` | Reachable by a learned click or select path. `DemoControls` floats over the page and will appear in frames. |
| Routes: `/`, `/refer-and-earn/bingo`, `/refer-and-earn/bingo/wallet`, `/building`, `/profile`, `/style-guide`, `/views` | `src/demo/main.tsx` | Each URL becomes its own landing state when visited. |
| Dev server `host: true` on port 4200; registered preview `http://[::1]:4200/` | `vite.demo-site.config.ts`, `.rewindry/config.json` | Binds the LAN too. Rewindry's endpoints only answer loopback, so this is acceptable. |
| Rewindry plugin **commented out** ("widget hidden"); loaded from the newest folder under `~/Library/Application Support/Rewindry/runtime/` | `vite.demo-site.config.ts` lines in `defineConfig` | Re-enable it and hide the widget with `preview.widget: false` instead. The loader will pick up whichever runtime is newest. |
| **10 uncommitted files** of the user's own work | `git status` in `2-source` | Never touch `src/`; never commit, stash or reset in that repo. |
| Store: schema v2, 143 checkpoints, 28 MB | `.rewindry/index.sqlite` | Backfilling all 143 checkpoints starts 143 historical servers. Too slow to run blind; needs a limit (see prerequisites). |
| Daemon runtime **0.1.4** serves four roots: this repo, `examples/vite-react`, `case-files`, bingo-demo `2-source`. Its stderr repeats `Invalid Rewindry workspace registry`. | `registration.json`, `daemon.stderr.log` | 0.1.4 refuses schema v3 stores. Upgrading the runtime affects all four roots at once. The registry error is pre-existing and should be diagnosed before the upgrade. |
| Codex ran from `bingo-demo/`, hooks live in `2-source/.codex` | earlier diagnosis | Out of scope here. File-watcher checkpoints (`unattributed_group`) still drive capture. |

## Prerequisites (code work in this repo, before any bingo-demo run)

> **Done 27 Oct 2026, committed as `40babac`:**
> - React 18 attribution was verified against bingo-demo's own `node_modules` (read-only), which also covers Vite 6.4.4.
> - Inner-scroll crops are verified on the `?shell=1` fixture.
> - `backfill --last N` and timing output are added.
>
> Expect the memoised `Cell` to appear as `Cell2` under Vite 6.

1. **React 18 attribution.** In `src/component-collector.js`, when an owned fiber has no `_debugStack`, read `_debugSource.fileName`. Return an absolute path as-is, and relativize it against the project root on the Node side: in `ui-capture.ts`, and in the recorder endpoint in `vite-plugin.ts`. Reject anything outside the root.
   - Test it with a React 18 fixture. That needs `react@18` and `react-dom@18` installed into a second example app, which is a network install, so **ask first**.
2. **Inner scroll containers.** Choose and test one approach on a fixture with an `overflow-hidden` shell and an inner scroller:
   - (a) for each component outside the viewport, scroll its nearest scrollable ancestor so it is in view and take a clipped screenshot;
   - (b) or detect the main inner scroller and capture it by scrolling and stitching.

   Prefer (a). Frames stay viewport-sized for these layouts.
3. **Backfill limit.** Add `--last N` (or `--from <checkpoint>`) to `rewindry backfill` so a run can be bounded and timed. Default to all, as today.
4. **Vite 6 check.** Run the recorder and per-screen E2E against Vite 6.4.4 in the fixture, or record it as unverified.

## Phase A — disposable copy (no change to bingo-demo or the daemon)

> **Run 27 Oct 2026: not passed yet.** Results, two fixes and open blockers (fragile learned paths, backfill ignoring a non-default Vite config name, leftover temp caches, absolute manifest paths) are recorded in `project status.md` row M5-16. Practical notes: `serve --data-dir` must be short (macOS socket paths ≤ 104 bytes); the copy's config needs a static plugin import under Vite 6's runner loader; rebase `checkpoints.manifest_path` after copying a store.

Run everything against a copy so that the real project, its store and the 0.1.4 daemon stay untouched.

1. Build this branch: `npm run build`.
2. Make a copy in this session's scratch directory:
   - Copy `2-source/` without `node_modules`, `dist-demo` or `.git`. Include `.rewindry/` so the 143 real checkpoints come along.
   - Symlink `node_modules` to the real one.
3. In the copy only:
   - Set `.rewindry/config.json` `preview` to `{ "appId": "groupr-ambassador-bingo-demo", "route": "/", "widget": false }`.
   - Uncomment the plugin loader in `vite.demo-site.config.ts`, but point it at this branch's `dist/vite-plugin.js` instead of the runtime folder, so the installed runtime is never used.
4. Start the copy's dev server on a free port bound to `127.0.0.1`, for example `npx vite --config vite.demo-site.config.ts --port 4300 --host 127.0.0.1`. The store migrates to v3 on first open; only the copy is affected.
5. **Learn (user, about 2 minutes):** open `http://127.0.0.1:4300/` at phone width and:
   - close the welcome popup;
   - open a board cell's concept dialog;
   - open the cash-out sheet;
   - open a grocery item;
   - switch the board option in DemoControls;
   - visit `/refer-and-earn/bingo/wallet` and `/profile`.

   Check with `sqlite3 .rewindry/index.sqlite "SELECT route, json_array_length(path_json), components_json FROM ui_states"`.
6. **Live capture:**
   - Start a foreground daemon for the copy only, with a private data directory so the installed LaunchAgent and its registry are untouched: `node dist/cli.js serve --root <copy> --data-dir <scratch>/rewindry-data`. With no registered roots in that data directory it watches just `<copy>`.
   - Make two or three small visual edits in the copy, for example board cell colour or copy text.
   - Time each update from checkpoint to the last frame.
7. **Backfill:**
   - `node dist/cli.js backfill --run-historical-source --root <copy> --last 5`, timed.
   - If acceptable, run larger ranges.
   - Record the counts of captured, unchanged, unreachable and failed, and the time per checkpoint.
8. **Review (user):** `node dist/cli.js viewer --root <copy>` → **Screens**. Walk the three checks in "What this run must show". Note anything wrong: missing components, wrong crops, noisy "changes", broken paths.
9. Delete the copy, or keep it at the user's request.

**Pass:** the three checks hold, and the timings are recorded in `project status.md` (M5-16, with the copy named as the environment).

**Fail:** record what failed. No rollback is needed.

## Phase B — the real project (only after Phase A passes and the user approves)

> **Prepared 1 Nov 2026 (read-only; nothing in the real project, its store or the daemon changed):**
> - **Backups:** `~/Rewindry-backups/2026-11-01/` holds a read-only `sqlite3 .backup` of each registered store (rewindry 33 checkpoints, examples/vite-react 10, case-files 1, bingo-demo 143; all schema v2, `integrity_check` ok) and `bingo-demo-git-status.txt` (14 entries). Objects and manifests are immutable files that the v3 migration does not touch.
> - **Registry error diagnosed, already resolved:** every `Invalid Rewindry workspace registry` and `ENOENT … GoogleDrive…/Engineering` line in `daemon.stderr.log` dates from 17 Oct 2026, when the registration still named the old Google Drive paths. The rebind at 14:09 that day (backups `registration.json.before-rebind-*.bak`) moved it to `~/Downloads/...`; the log has not changed since, and the running daemon serves all four roots.
> - **Dry run** (`node dist/cli.js setup --dry-run --root <2-source>`; `git status` and `.rewindry` listing identical before and after): real setup would create history in `2-source/.rewindry`, re-register the user LaunchAgent, *edit the project Vite config reversibly*, and **merge Codex and Claude Code hooks into `2-source/.codex/hooks.json` and `2-source/.claude/settings.local.json`** (user files). Decide before step 4 whether hooks are wanted there; the Vite edit should be replaced by the manual change in step 5, shown as a diff first.
> **Approved by the user 1 Nov 2026; partly done:**
> - Fresh backups before the upgrade in `~/Rewindry-backups/2026-11-01-before-phase-b/`: the four stores (rewindry 36 checkpoints, examples/vite-react 10, case-files 1, bingo-demo 143; v2; integrity ok), `registration.json`, `daemon.json`, the LaunchAgent plist, bingo-demo's `.codex/hooks.json` and `.claude/settings.local.json`, and its `git status` (14 entries).
> - Step 4 (`node dist/cli.js setup --root <2-source>`) was **refused by Claude Code's permission classifier as self-modification**, because setup merges hooks into `2-source/.claude/settings.local.json`; it must be run by the user. Those hook files already hold only Rewindry's 0.1.4 commands; the merge repoints them at the new runtime, which they need once the stores are v3. Setup will not edit the Vite config (it only edits `vite.config.*`; bingo-demo has `vite.demo-site.config.ts`). Hooks in the other three roots keep pointing at 0.1.4, which only forwards events to the daemon socket and stays compatible.
> - Step 5, part 1 done: bingo-demo's `.rewindry/config.json` (git-ignored) now sets `preview.widget: false` and `preview.viteConfig: "vite.demo-site.config.ts"`.
> - Step 5, part 2 prepared, not applied: `~/Rewindry-backups/2026-11-01-before-phase-b/bingo-vite-config.patch` re-enables the plugin loader in `vite.demo-site.config.ts`. Apply only after step 4, with the user's go-ahead on the diff.
> - Remaining gate: the user's Phase A sign-off and explicit approval of step 4, which upgrades the daemon for all four roots and migrates their stores to v3 (0.1.4 cannot read v3; rollback = restore the backups).

1. **Back up.** For each of the four registered roots, copy `.rewindry/index.sqlite*` to a dated backup. Record `git status` of bingo-demo `2-source`.
2. **Diagnose** the existing `Invalid Rewindry workspace registry` error and fix it, or decide it is benign.
3. **Inspect:** `node dist/cli.js setup --dry-run` from `2-source`. Review the runtime and LaunchAgent changes it proposes.
4. **Upgrade:** run `node dist/cli.js setup` from `2-source`.
   - This installs the branch runtime, which the loader picks up as the newest version, and restarts the daemon.
   - All four roots' stores migrate to v3 on first open. `rewindry status` must report active capture for each.
5. **Configure:** set `preview.widget: false` in bingo-demo's config. Re-enable the plugin loader lines in `vite.demo-site.config.ts`. That is the user's file, so show the diff first. Nothing in `src/` changes.
6. **Run:** the user works normally, for about a day.
   - Check the Screens page.
   - Check the daemon logs for `Rewindry screen history capture failed`.
   - Measure capture time against the user's edit rate.
7. **Rollback** if needed:
   - Comment the plugin out again.
   - Reinstall the published runtime with `npx rewindry@latest setup`.
   - Restore the backed-up `index.sqlite` files. Any history captured during the trial is then lost; say so before restoring.

## Not in scope

Pushing, merging or publishing; moving Codex hooks to the parent folder; changing bingo-demo source; any remote service.
