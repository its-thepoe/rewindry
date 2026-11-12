# Plan 002: Replay saved checkpoints to backfill historical visuals

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. Stop at any STOP condition. Do not update `plans/README.md`; the reviewer maintains the index.
>
> **Base branch**: `codex/named-visual-targets` at `cbcbae9` (Plan 001 implementation). Create an isolated worktree and feature branch from that ref.
>
> **Drift check (run first)**: `git diff --stat cbcbae9..HEAD -- src/backfill.ts src/capture.ts src/cli.ts src/api.ts src/vite-plugin.ts src/viewer/index.html src/viewer/viewer.js src/viewer/viewer.css src/overlay.js src/overlay.css tests/backfill.test.ts tests/daemon.test.ts tests/api.test.ts tests/e2e/visual.test.ts README.md DOCS/README.md DOCS/rewindry_mvp_prd.md DOCS/rewindry_technical_spec_mvp.md DOCS/rewindry_implementation_plan_mvp.md 'project status.md'`
> If an in-scope file changed after this plan was written, compare the current-state notes below with the live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 001 (`codex/named-visual-targets`, commit `cbcbae9`)
- **Category**: direction
- **Planned at**: commit `cbcbae9`, 2026-10-17

## Why this matters

Plan 001 adds named screens and viewport profiles for new checkpoints, but older checkpoints can still have source files and no images for those profiles. The user requires existing iterations to receive visuals too. Rewindry must replay each checkpoint's own saved source into an isolated temporary workspace, capture the currently configured targets, and attach those images to that checkpoint without changing its source manifest or replacing an existing compatibility image. A replay is a best-effort reconstruction: excluded files, historical dependencies, environment variables, remote data, and browser state were not saved, so it must never be labelled as the original live capture.

## Product contract

- Add an explicit `rewindry backfill` CLI command for the selected project. It processes existing checkpoints sequentially, reports per-checkpoint progress, and resumes safely when run again. Do not make setup, daemon startup, or ordinary Vite startup execute historical project code implicitly.
- Before running historical code, require an explicit CLI acknowledgement flag such as `--run-historical-source`; explain that the command will execute the checkpoint's saved Vite config/application source in a temporary directory. A missing flag must exit without starting the renderer or changing history.
- Use the current `.rewindry/config.json` `preview.targets` catalogue (and existing default root/Desktop target when absent). New target IDs and viewport IDs are applied to old checkpoints. Existing successfully captured target/profile pairs are not overwritten. Failed pairs may be retried by a later explicit command.
- Reconstruct each checkpoint only from `WorkspaceStore.readFile(checkpoint.id, path)` bytes. Do not substitute today's project source. Materialize under a unique `.rewindry/tmp/` directory; never restore or write historical files into the user's checkout.
- Reuse the project's currently installed Vite and `node_modules` without running package-manager install scripts or network package installation. If required files/dependencies/config are unavailable, record the target failure and continue to the next checkpoint.
- Use the existing safe capture pipeline: fresh isolated browser context per variant, loopback-only browser requests, source digest/generation stability checks, per-image and total preview quotas, ID/route validation, and target selector uniqueness checks.
- Mark every replay-generated target with provenance (for example `captureMode: "replayed"` and `replayedAt`). Preserve the original checkpoint `createdAt`, source manifest/digest, original image bytes, and `primary.png` where present. If a checkpoint has no primary image, its first successful replay may become `primary.png` for legacy clients.
- Add a visible **Replayed from saved source** label in both viewers and an explanatory note that dynamic state/dependencies may differ. A replay failure remains explicit and must not hide a successful sibling target.
- Backfill is image-only enrichment. It must not add timeline entries, rewrite source objects/manifests, import Git history, or claim exact historical pixels.

## Current state

- `src/store.ts` exposes `WorkspaceStore.list()` and `readFile(id, relativePath)`. The manifest stores safe relative paths and object digests, so those methods are the source of truth for replay input.
- `src/capture.ts` exports `captureCheckpoint(root, store, checkpoint, options)`. It checks the supplied store's current digest before and after capture, stores results under `.rewindry/previews/<checkpoint-id>/`, validates target IDs/routes, and writes `primary.png` plus `<target>--<viewport>.png` files. `PreviewTargetRecord` currently has no capture provenance field. Existing successful records cause `captureCheckpoint` to return early, so backfill must use a separate merge path or a narrowly scoped capture mode rather than replacing old images.
- `src/vite-plugin.ts` exposes the local loopback Vite preview identity at `/__rewindry/preview`; the capture pipeline uses it to reject source/generation races. For historical workspaces, add an isolated proof path or equivalent that does not weaken the current endpoint protections.
- `src/cli.ts` dispatches `setup`, `serve`, `viewer`, `status`, `doctor`, and `uninstall`. Add the explicit backfill command there. `tests/daemon.test.ts` exercises CLI dispatch and is the existing CLI test pattern.
- The standalone viewer consumes checkpoint metadata in `src/api.ts`, `src/viewer/viewer.js`, and `src/viewer/index.html`. The dev overlay consumes it in `src/vite-plugin.ts` and `src/overlay.js`. Plan 001 already added target selectors to both surfaces; extend their metadata/UI to label replayed visuals.
- `tests/capture.test.ts`, `tests/api.test.ts`, `tests/vite-plugin.test.ts`, and `tests/e2e/visual.test.ts` cover the current capture, API, and viewers. The project uses TypeScript ESM, Node `>=26`, and npm scripts below.
- Existing docs currently say historical backfill is not supported (`README.md` named-capture section; PRD §14; technical spec §2, §11). Update those statements to this plan's best-effort replay contract without implying exact reconstruction.

## Commands

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | Exit 0 with no TypeScript errors. |
| Unit tests | `npm test` | Exit 0; all tests pass. |
| Browser/Vite E2E | `npm run test:e2e` | Exit 0; capture, standalone viewer, and overlay checks pass. |
| Build | `npm run build` | Exit 0 and distribution assets are produced. |

Do not add dependencies or run package installation during backfill. The normal executor may use the existing lockfile-installed dependencies in its worktree.

## Scope

**In scope** (modify only these paths):

- `src/backfill.ts` (new)
- `src/capture.ts`
- `src/cli.ts`
- `src/api.ts`
- `src/vite-plugin.ts`
- `src/viewer/index.html`
- `src/viewer/viewer.js`
- `src/viewer/viewer.css`
- `src/overlay.js`
- `src/overlay.css`
- `tests/backfill.test.ts` (new)
- `tests/daemon.test.ts`
- `tests/api.test.ts`
- `tests/e2e/visual.test.ts`
- `README.md`
- `DOCS/README.md`
- `DOCS/rewindry_mvp_prd.md`
- `DOCS/rewindry_technical_spec_mvp.md`
- `DOCS/rewindry_implementation_plan_mvp.md`
- `project status.md`

**Out of scope**:

- SQLite schema/migrations, checkpoint manifests, source object bytes, `createdAt`, or Git refs.
- Replaying source into the active checkout, restoring historical files, or changing checkpoint order/grouping.
- Running `npm install`, `pnpm install`, `yarn`, `bun install`, package scripts, or remote deployments for historical checkpoints.
- Reconstructing omitted `.env` files, browser sessions, local database state, API responses, or remote service data.
- Automatic backfill on install, daemon start, or normal Vite startup; only the explicit acknowledged CLI command may run it.
- Changes outside the file list above.

## Steps

### Step 1: Add an explicit CLI backfill flow and safe temporary snapshot materialization

Add a `rewindry backfill --run-historical-source` command. Without the acknowledgement flag, print a concise explanation and return nonzero before writing anything. With it, initialize the current `WorkspaceStore`, read current preview config, enumerate checkpoints oldest-to-newest, and process sequentially with progress output. Materialize each checkpoint's files from `store.readFile` into a unique directory below `.rewindry/tmp/`; validate relative paths before creating directories/files; create no symlinks except a controlled link to the current project's installed `node_modules` if present; never copy `.env`, `.rewindry`, or other non-checkpoint data. Always remove only that exact temporary directory in `finally`.

Use the project-local Vite installation and historical Vite config to serve the temp root on an ephemeral loopback port. Add a dedicated backfill preview-identity plugin/endpoint if needed so ordinary Rewindry preview behavior remains unchanged. Do not invoke arbitrary `package.json` scripts or install dependencies. Capture with the current configured target list using the temp store's exact checkpoint file set/digest. Isolate each checkpoint failure and continue; report a final captured/partial/unavailable count.

**Verify**: Add unit tests in `tests/backfill.test.ts` proving the acknowledgement guard causes no writes, snapshot materialization uses historical bytes (not current bytes), path traversal is rejected, the temp directory is cleaned on success/failure, checkpoints process in order, and no package-manager script is called. `npm run typecheck` and focused unit tests pass.

### Step 2: Merge replay results into historical preview records without replacing originals

Add a dedicated merge/publication path for target variants. Existing captured images and target/profile records are immutable: skip successful pairs, append new successful/failed pairs, preserve old `primary.png` byte-for-byte, and use a successful replay as primary only when no primary image exists. Store replay provenance and replay timestamp on each target record. Update the stored visual status when at least one primary or target image is available. Enforce the 4 MiB per-image limit and 256 MiB workspace total across both existing and replayed PNGs before publication. Write image files and JSON metadata atomically; a failed merge must leave the prior record/images intact. A repeated command must skip already successful variants and retry failed variants without duplicate catalogue entries.

**Verify**: Extend capture/backfill tests for legacy primary preservation, empty-record primary creation, repeated/idempotent runs, per-target failures, quota exhaustion, source stability races, and atomic cleanup after a publish failure. `npm test` passes.

### Step 3: Surface replay provenance in APIs and viewers

Expose capture provenance through both iteration APIs. Preserve `previewUrl`, target URLs, legacy fallback, and all local/auth/symlink/size checks. In both the standalone viewer and Vite overlay, label a replayed target clearly as **Replayed from saved source** with a short note that omitted runtime inputs can change pixels. Keep selection, one timeline point per source checkpoint, and explicit missing-variant messages unchanged.

**Verify**: Extend `tests/api.test.ts` and `tests/vite-plugin.test.ts` for replay metadata and unchanged legacy clients. Extend `tests/e2e/visual.test.ts` to backfill at least two historical checkpoints from distinct saved source states, assert unique image bytes, assert their saved checkpoint digest and `createdAt` did not change, confirm `primary.png` preservation and replay labels in both viewers, and confirm failed replay remains navigable/source-only. `npm run test:e2e` passes.

### Step 4: Document behavior and verification

Update README and product docs to explain the explicit command, required `preview.targets` configuration, replay/execution boundary, dependency and environment limits, provenance label, retry behavior, and the fact that exact original runtime pixels cannot be recovered. Replace the previous blanket “no backfill” statements with this precise contract. Add an M5 follow-on row to `project status.md` with verified evidence. Do not claim the feature is published or that every historical checkpoint is guaranteed to capture.

**Verify**: `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`, and `git diff --check` all exit 0. `git status --short` lists only in-scope files.

## Done criteria

- [ ] User must explicitly invoke backfill with the historical-source acknowledgement; setup and ordinary Vite startup never execute old code.
- [ ] Every replay input is read from the exact selected checkpoint's immutable source objects, materialized only in `.rewindry/tmp/`, then cleaned.
- [ ] The current active project checkout, checkpoint manifests/digests/timestamps, and Git refs remain unchanged.
- [ ] Existing successful images are never replaced; missing configured target variants are added idempotently, and a primary image is created only when absent.
- [ ] Replayed captures carry an explicit provenance label in API data and both viewer surfaces.
- [ ] Missing dependencies/configuration, invalid selectors, quotas, or source/generation instability produce per-checkpoint/per-target failure evidence and do not halt other checkpoints.
- [ ] No historical package-manager install or package script is run.
- [ ] Typecheck, unit tests, browser/Vite E2E, build, and `git diff --check` all pass.
- [ ] `project status.md` is updated with actual verification evidence.

## STOP conditions

- The historical manifest/object cannot be read or its content does not match its recorded digest. Do not fall back to current project files.
- Safe temp materialization would require writing into the active project, restoring a checkpoint, fetching dependencies, copying secrets, or relaxing network/image/storage guards.
- The historical Vite config cannot be loaded without weakening the explicit acknowledgement or current preview security controls.
- Preserving existing `primary.png` and legacy API behavior cannot be achieved.
- More than 12 configured variants are requested for one checkpoint, or the total image quota would be exceeded. Mark the affected result; do not weaken the limit.
- Any in-scope file differs materially from the current-state description without a plan revision.
- Any required verification fails twice after one focused repair attempt.

## Maintenance notes

Replayed visuals describe the saved source plus the current installed dependency tree and current preview target configuration; they do not prove the original browser/runtime state. Keep `captureMode` visible in API metadata and UI, preserve original images indefinitely, and make retries idempotent. Reviewers should inspect temp-path cleanup, exact-checkpoint source reads, symlink/path defenses, quota accounting against existing files, and the no-package-install guarantee. Existing checkpoints with no source objects cannot be backfilled and must stay explicitly unavailable.
