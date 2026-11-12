# Plan 003: Passive per-component, per-screen, per-breakpoint visual history

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. Stop at any STOP condition. Do not update `plans/README.md`; the reviewer maintains the index. Step 1 is a spike whose outcome decides the tagging strategy; record its result in `project status.md` before continuing.
>
> **Base branch**: `main` at `8447bc5`. Create an isolated worktree and feature branch from that ref.
>
> **Drift check (run first)**: `git diff --stat 8447bc5..HEAD -- src/capture.ts src/runtime.ts src/store.ts src/vite-plugin.ts src/overlay.js src/overlay.css src/api.ts src/viewer src/backfill.ts src/cli.ts tests README.md DOCS 'project status.md'`
> If an in-scope file changed after this plan was written, compare the current-state notes below with the live code before proceeding.

## Status

- **Priority**: P0 (this is the product's core job)
- **Effort**: XL (phased; each phase ships independently)
- **Risk**: HIGH (relies on React internals or a dev-time JSX shim; replays user interactions)
- **Depends on**: Plans 001 and 002 (both on `main`)
- **Category**: direction
- **Planned at**: commit `8447bc5`, 2026-10-27

## Why this matters

Real use on bingo-demo (Oct 17–21) showed that Rewindry saved code but not the pictures the user cared about:

- Every capture was `/` at 1280×800 with the welcome modal open, because no `preview.targets` were configured.
- Of 91 images, only 30 were distinct, and 51 consecutive edits produced identical screenshots.
- The edited mobile sheets, dialogs and board cells were never shown.

The user's requirements, in their words, are:

- "Show me what it looked like at iteration 1 … 3 turns after that … 4 turns after that."
- History must be viewable at three zoom levels: one component, a whole screen, and a whole screen at one breakpoint.
- Popovers, dialogs and sheets that appear only after a click must be included.
- Capture must keep working when no browser tab is open, and in any browser.
- Capture must be completely passive, with no keystrokes and no required configuration. Manual control should exist but never be needed.
- The user switches between mobile-first and responsive projects, so every capture must cover several breakpoints.

Named targets (plan 001) require upfront configuration the user will not write, which reverses one of `plans/README.md`'s rejected findings. That finding was "Automatically discover framework components from source code". This plan adopts automatic discovery for React/JSX on purpose, keeps the framework-neutral named targets as a manual override, and treats unsupported frameworks as screen-only.

## Product contract

### Concepts

- **UI state**: a reachable picture of the app, defined by a route plus an ordered **interaction path** from a fresh page load. Examples: "load `/`", or "load `/`, click *Close welcome*, click board cell 3".
  - States are **learned passively** from any browser session where the Rewindry Vite plugin is running: the user's own browser, a second browser, or a coding agent's test browser.
  - The user never names or saves a state by hand.
- **Breakpoint profile**: a fixed viewport.
  - The defaults are `mobile` 390×844 (touch, DPR 2), `tablet` 768×1024 (touch, DPR 2) and `desktop` 1280×800 (DPR 1).
  - Profiles are configurable in `.rewindry/config.json` `preview.profiles`.
  - Profiles are fixed, not "whatever width the user last had", so comparisons across iterations stay consistent. This keeps plan 001's rejected-finding rationale.
- **Component instance**: a rendered component, identified by source file plus component name, for example `src/components/BoardCell.tsx#BoardCell`. Each instance has a bounding box in a captured state, with a stable occurrence index when it repeats.
- **Screen frame**: one screenshot of one UI state at one breakpoint for one checkpoint, plus a **component map** (JSON) listing every tagged component instance and its box.
- **Component crop**: a crop of a screen frame to one component instance's box, plus a small margin, clamped to the viewport.

### Passive capture

1. Capture still runs after each settled update: every `agent_turn` or `unattributed_group` checkpoint the runtime already creates. No new trigger or keystroke is added.
2. For each checkpoint, choose the states to capture:
   - States whose last component map contains a component from a changed file.
   - States whose recorded module list for the page includes a changed file.
   - The root state `/`.
   - If no state matches, the root state plus the most recently used states.
3. Capture every chosen state at every breakpoint profile, headlessly, in a fresh isolated browser context per frame.
   - Replay the interaction path step by step, wait for the page to settle (network idle plus two animation frames, with a bounded timeout), then screenshot the viewport and collect the component map.
   - This works with no user tab open, because the runtime only needs the dev server.
4. Budget: at most 36 screen frames per checkpoint (12 states × 3 profiles).
   - This replaces plan 001's 12-variant cap for automatic capture only. Named targets keep their own limit.
   - The existing per-image (4 MiB) and total (256 MiB) quotas still apply.
   - When over budget, prefer states containing changed components, then the most recently used. Record skipped states explicitly.
5. Deduplicate by content hash:
   - A screen frame or component crop identical to that same state/profile/component's previous stored version is recorded as "unchanged" and points at the earlier image. No new bytes are stored.
   - So each history contains only real visual changes, while the timeline still knows every checkpoint.
6. Live capture of the current source is not replay. Backfilled frames keep plan 002's **Replayed from saved source** label.

### Learning states (the recorder)

1. The plugin injects a small dev-only recorder script whether or not the visible widget is shown. A new `preview.widget: false` config option, also available as a plugin option, hides the widget without removing capture. This directly fixes the bingo-demo failure where removing the plugin to hide the widget broke 37 captures.
2. The recorder observes the following from page load:
   - Route changes (History API and `popstate`).
   - Clicks and taps (pointer up on the target).
   - The Escape key.
   - Form-control toggles: checkbox, radio, `select` option.
   - It **never records typed text, input values, clipboard, cookies or storage contents.** Paths that need typed input are out of scope; see Limits.
3. Each recorded step stores a **resilient locator**, picked from the first that resolves uniquely in the document:
   1. `data-testid`.
   2. ARIA role plus accessible name.
   3. The Rewindry component tag plus its occurrence index plus visible text.
   4. A short CSS path.

   Store a few candidates per step, so replay can fall back when markup shifts.
4. A new UI state is saved when a step causes a tagged component to appear that was not visible before, such as a dialog, popover or sheet mounting. The state's path is the minimal path from the last page load.
   - Equivalent states (same route plus same visible-component set) are merged, keeping the shortest working path.
   - States are capped at 200 per project, evicting the least recently seen.
5. The recorder sends steps to a same-origin, loopback-only dev endpoint (`POST /__rewindry/states`).
   - The endpoint validates sizes and shapes and writes into the project store.
   - It never runs code from the payload and never makes outbound requests.
   - This is a learning endpoint, not a restore or apply endpoint. Review stays read-only.
6. The recorder also reports the module URLs the page loaded (`performance.getEntriesByType('resource')` filtered to the dev server's origin) for each saved state. This feeds the "which states use this changed file" query.

### Component tagging

Every component instance in a screen frame must be attributable to a source file and component name, including content rendered through portals. Step 1 picks one of two strategies by spike:

- **A. Fiber walk at capture time (preferred if it works).**
  - Inside the headless page, walk the React fiber tree from each root container.
  - For each function or class component fiber, collect its host DOM nodes and union their boxes.
  - Read the source file from `_debugSource` on React ≤18, or by parsing the dev `_debugStack` / owner stack on React 19.
  - This needs no build transform, but depends on React development internals.
- **B. Dev-only JSX runtime shim.**
  - In `serve` mode only, alias `react/jsx-dev-runtime` to a Rewindry wrapper.
  - The wrapper adds `data-rw="<file>#<Component>"` to the first host element each component renders, using the `source` argument or the owner stack.
  - Production builds must never include the shim.

Tags are dev-only and must never appear in `vite build` output. Non-React projects degrade to screen-level history, with a visible note in the viewer that component zoom is unavailable.

### Reviewing (zoom levels)

The standalone viewer gets a history browser with three zoom levels and one filmstrip:

- **Component**:
  - Choose any component that has ever been captured. The default is the one most recently changed.
  - The filmstrip shows only the iterations where that component's crop changed, across all states and profiles. A profile filter is available.
  - When a component appears in several states, pick the state, defaulting to the one with the most versions.
- **Screen**: choose a UI state and see its frames.
- **Screen at a breakpoint**: choose a state plus a profile.

Each filmstrip item shows:

- Iteration number and time.
- Its checkpoint kind (agent turn or grouped edits).
- A click-through to that checkpoint's code and diff, which already exist.

Two items can be compared side by side. There is no source restore or apply.

Plan 001's named targets and plan 002's backfilled variants appear as extra states in the same browser. The dev overlay keeps its current per-checkpoint view and gets a link to open the standalone history browser.

### Repairing paths

- If a replay step cannot find its locator, that state's frame for the checkpoint is recorded as `path_broken` with the failing step. The previous good images stay in history.
- The next time the user reaches the same visible-component set in any browser, the recorder replaces the path automatically.
- The viewer shows broken states quietly in the state list. It never interrupts the user.

### Limits (must be stated in docs and the viewer, not hidden)

- A state nobody has ever opened in a browser with the plugin cannot be captured. Its history starts the first time it is seen. Earlier iterations can be filled in later with `rewindry backfill --run-historical-source`, replaying the learned path against older checkpoints and labelling the result.
- States that need typed input, sign-in, live backend data, time-sensitive content or randomness may render differently on replay. Rewindry does not claim the frame reproduces dynamic browser state.
- Hover-only UI is out of scope for this plan.
- Component zoom is React/JSX-only in this plan.

## Current state (at `8447bc5`)

- `src/runtime.ts`:
  - `RewindryRuntime.queueCapture(checkpoint)` calls `captureCheckpoint(root, store, checkpoint, { previewUrl, appId, route, targets, capturePage })`.
  - Checkpoints come from `turn-manager.ts`, either agent turns or settled idle groups with `settleMs` = 2s. The file watcher already produces `unattributed_group` checkpoints without hooks, so no trigger change is needed.
- `src/capture.ts`:
  - Holds `PreviewViewport`, `PreviewTargetConfig`, `PreviewTargetRecord` (including `captureMode`/`replayedAt`) and `PreviewRecord`.
  - `captureCheckpoint` writes `.rewindry/previews/<checkpoint>/primary.json`, `primary.png` and `<target>--<viewport>.png`.
  - `captureBackfillVariants` merges replayed variants.
  - Limits: `MAX_CAPTURE_VARIANTS = 12`, `MAX_IMAGE_BYTES` 4 MiB, `MAX_PREVIEW_BYTES` 256 MiB.
  - The capture identity check and generation guard use `/__rewindry/preview`.
- `src/vite-plugin.ts`:
  - `rewindryPreviewPlugin(appId)` is `apply: 'serve'`.
  - `configureServer` publishes the preview URL to `.rewindry/config.json` and serves `/__rewindry/preview`, `/__rewindry/iterations`, `/__rewindry/image/*` and the overlay assets.
  - `transformIndexHtml` injects `overlay.js`. There is no widget-hidden option.
- `src/store.ts`: SQLite at schema `user_version` 2 (`migration-002-checkpoint-files.ts`). A schema change needs migration 003, versioned and idempotent, with tests for upgrading from v2 and rolling back on failure.
- `src/api.ts`: authenticated, GET-only viewer API exposing checkpoints, targets, files, diffs and images.
- `src/backfill.ts`: replays a checkpoint's saved source on an isolated loopback Vite server. Reuse it for replaying learned paths against older checkpoints.
- Tests: `tests/capture.test.ts`, `runtime.test.ts`, `store.test.ts`, `vite-plugin.test.ts`, `api.test.ts`, `backfill.test.ts`, and `tests/e2e/visual.test.ts` (Playwright Chromium headless shell 1248 against `examples/vite-react`).

## Commands

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | Exit 0 |
| Unit tests | `npm test` | Exit 0; all pass |
| Browser/Vite E2E | `npm run test:e2e` | Exit 0 |
| Build | `npm run build` | Exit 0 |
| Setup inspection | `node dist/cli.js setup --dry-run` | Shows planned changes only |

Use Node 26. Add no runtime dependencies without recording why in `project status.md`. A small parser is allowed only if strategy B needs one.

## Scope

**In scope:**

- `src/capture.ts`, plus a new `src/ui-states.ts` (state model, path replay, locator resolution, dedup).
- New `src/component-map.ts` (in-page tagging and collection script for strategy A or B).
- `src/runtime.ts` (state selection per checkpoint).
- `src/store.ts`, plus a new `src/migration-003-ui-history.ts`.
- `src/vite-plugin.ts`, `src/overlay.js`, `src/overlay.css`, plus a new `src/recorder.js` (dev-only recorder).
- `src/api.ts`, `src/viewer/index.html`, `src/viewer/viewer.js`, `src/viewer/viewer.css`.
- `src/backfill.ts`, `src/cli.ts` (path replay over historical checkpoints only).
- `examples/vite-react/` (a dialog/popover, and a component used on two routes, for E2E).
- Tests under `tests/`.
- `README.md`, `DOCS/rewindry_mvp_prd.md`, `DOCS/rewindry_technical_spec_mvp.md`, `DOCS/rewindry_implementation_plan_mvp.md`, `project status.md`.

**Out of scope:**

- Source restore or apply, remote sync, or uploading frames anywhere.
- Recording typed text or values, storage, or cookies. Handing browser storage to the headless browser.
- Capturing from the user's own tab. Headless replay is the only capture path in this plan.
- Hover states, non-React component zoom, video or animation capture.
- Moving agent hooks to the folder where the agent actually runs (the bingo-demo `2-source` versus parent mismatch). That is a separate `install.ts` fix; file it as a follow-up.
- Publishing to npm or claiming `npx rewindry@latest` support.

## Steps

### Step 1: Spike component attribution and choose strategy A or B

Prove attribution on `examples/vite-react` with React 19 (the example's version) and, if feasible, React 18:

- One component that repeats (a list cell).
- One component rendered in a portal (a dialog).
- One component used on two routes.

Collect `{file, component, occurrence, box}` for each in a headless page.

- Try strategy A first.
- Fall back to B if A can't resolve file paths on React 19.
- Confirm that `vite build` output contains no tags or shim code.

Record the decision and evidence in `project status.md` (new row M5-13).

**Verify**: a focused unit test plus an E2E probe assert the expected component set and non-empty boxes for the portal dialog. A build-output grep finds no `data-rw` or shim.
**STOP** if neither strategy attributes portal content on React 19 without patching React or `node_modules`.

### Step 2: Schema for states, frames and component versions (migration 003)

Add versioned, idempotent migration 003 with these tables:

- `ui_states`: id, route, path JSON, visible-component set hash, modules JSON, first/last seen, status.
- `screen_frames`: checkpoint, state, profile, image digest, unchanged-from, status, reason, `captureMode`.
- `component_versions`: component key, state, profile, checkpoint, crop digest, unchanged-from, box.

Images are stored content-addressed under `.rewindry/visuals/<digest>.png`. Existing `previews/` records stay untouched and readable.

**Verify**: tests for a fresh install at v3, an upgrade from a v2 fixture with checkpoints and previews preserved, a migration re-run as a no-op, a forced failure rolling back to v2 intact, and `Unsupported store schema version` for v4+.

### Step 3: Recorder, learning endpoint and widget flag

- Add `src/recorder.js`, injected in serve mode. Capture settings come from config, not from whether the widget shows.
- Add `preview.widget: false` and a plugin option.
- Add `POST /__rewindry/states`. It accepts only loopback same-origin requests with strict size and shape validation, never stores input values, and merges equivalent states.
- Record module URLs per state.

**Verify**:

- Unit tests for locator candidate generation, merge-by-component-set, the 200-state cap, rejection of oversize or malformed or cross-origin posts, and no value capture (password and text inputs).
- E2E: open the example dialog in a real Playwright page with `widget: false`. Assert one new state with a working path, and that the widget DOM is absent.

### Step 4: Headless path replay, multi-profile capture and dedup

- In `runtime.ts`, pick states per checkpoint following the contract.
- In `capture.ts` and `ui-states.ts`:
  - Replay each path per profile in fresh contexts, falling back through locator candidates.
  - Settle, screenshot, collect the component map, crop components, hash, and dedupe.
  - Write frames and versions atomically.
  - Enforce the 36-frame budget plus existing quotas, and record `path_broken` and skipped reasons.
- Keep `primary.png` and `primary.json` producing the root/desktop frame, so legacy clients and plan 001/002 behaviour keep working.

**Verify**:

- Unit tests for the selection rules, budget ordering, dedup pointing at the prior digest, `path_broken` keeping prior images, and atomic failure leaving prior rows intact.
- E2E with the user's browser closed:
  - Edit the dialog component across three checkpoints, two of them visual changes and one a no-op comment.
  - Assert three checkpoints, two stored dialog crop versions plus one "unchanged" at each profile, distinct mobile and desktop bytes, and the welcome-style modal dismissed by the learned path.

### Step 5: History browser with component, screen and breakpoint zoom

- Add GET-only API routes listing components, states and profiles, plus a filmstrip per selection with image URLs, iteration index, checkpoint kind and code/diff links.
- Apply the same auth, path, symlink and size checks as today.
- Build the viewer UI for the three zoom levels plus two-item compare, with fit at 390px width and keyboard access.
- Show the React-only note on non-React projects, and the replay label where it applies.
- Link the overlay to the viewer.

**Verify**:

- API tests for auth, filters, and unchanged legacy `/api/checkpoints`.
- E2E: select the dialog component and see exactly its changed versions in order. Switch to screen and to screen+mobile. Compare two. Check the layout at 390px and 1280px.

### Step 6: Backfill learned paths onto older checkpoints

Extend `rewindry backfill --run-historical-source` to replay learned states (all profiles) against historical checkpoints, using plan 002's isolation. The output is labelled replayed and deduped with the same rules. The command stays explicit, with no automatic historical execution.

**Verify**: backfill tests plus an E2E over two historical checkpoints: replayed dialog crops appear in the component filmstrip with the label, and history digests and `createdAt` are unchanged.

### Step 7: Real-project validation on bingo-demo (needs the user's go-ahead)

This step writes into the user's project `.rewindry/` and runs historical source.

1. **Ask the user before starting.**
2. Rebuild Rewindry and point bingo-demo's runtime at it.
3. Restore the plugin with `widget: false`.
4. Let the user (or an agent's browser) open the board, the redemption sheet and the grocery item dialog once.
5. Run backfill.

Report:

- How many board, sheet and dialog versions appear.
- Which checkpoints failed or have broken paths.
- Whether the history matches the user's memory.

Record the results honestly in `project status.md`. A fixture pass does not count as this step.

### Step 8: Documentation

Update the following to describe passive learning, zoom levels, profiles, the widget flag, limits and privacy (what is and isn't recorded):

- README
- PRD (acceptance criteria touching visual history)
- technical spec §9
- implementation plan (new M5-13 to M5-15 rows)
- `project status.md`

Do not claim publication.

**Verify**: `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build` and `git diff --check` all exit 0.

## Done criteria

- [ ] With no configuration and no keystrokes, editing a component that appears only after a click yields a per-component filmstrip of its real visual changes at mobile, tablet and desktop, with the browser closed after the state was first seen once.
- [ ] Component, screen, and screen-at-breakpoint zoom levels all work in the standalone viewer.
- [ ] Identical frames are deduplicated. Every checkpoint still keeps its code and diff.
- [ ] Hiding the widget does not stop capture.
- [ ] No typed values, storage or cookies are recorded. No production build contains recorder or tag code.
- [ ] Migration 003 upgrades from v2, re-runs as a no-op and rolls back on failure.
- [ ] Legacy previews, named targets and plan 002 replay labels keep working.
- [ ] Backfill can replay learned paths onto older checkpoints, labelled as replayed.
- [ ] Verified on bingo-demo with the user, or `project status.md` says plainly that it is not.

## STOP conditions

- Step 1 fails: no reliable component attribution for portal content on React 19.
- Recording a path would require capturing typed values, credentials or storage.
- Replay would need outbound network access beyond loopback, or weaker capture identity or generation guards.
- The schema change cannot be made idempotent and rollback-safe.
- Any required verification fails twice after one focused repair attempt.
- An in-scope file differs materially from the current-state notes without a plan revision.

## Maintenance notes

Attribution through React internals can break on React upgrades. Keep the attribution code isolated in `component-map.ts`, run its probe in E2E against the example's React version, and surface "component zoom unavailable" rather than wrong attributions. Learned paths are user-behaviour data stored locally only. Keep the recorder's allowlist of event types small and reviewed. Revisit the 36-frame budget after measuring capture time on bingo-demo.
