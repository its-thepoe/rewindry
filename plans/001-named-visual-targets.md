# Plan 001: Capture and browse named screens at multiple viewports

> **Executor instructions**: Follow this plan step by step. Run each verification command and confirm the expected result before proceeding. Stop at any condition listed under **STOP conditions**. When complete, update the status row in `plans/README.md` and the required row in `project status.md`.
>
> **Drift check (run first)**: `git diff --stat 539ddf9..HEAD -- src/capture.ts src/runtime.ts src/preview-files.ts src/vite-plugin.ts src/api.ts src/viewer/index.html src/viewer/viewer.js src/viewer/viewer.css src/overlay.js src/overlay.css tests/capture.test.ts tests/vite-plugin.test.ts tests/api.test.ts tests/e2e/visual.test.ts README.md DOCS/README.md DOCS/rewindry_mvp_prd.md DOCS/rewindry_technical_spec_mvp.md DOCS/rewindry_implementation_plan_mvp.md 'project status.md'`
> If any in-scope file changed after this plan was written, compare the excerpts below to the current files. A mismatch is a STOP condition until the plan is revised.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `539ddf9`, 2026-10-17

## Why this matters

Rewindry currently renders one configured page at a fixed desktop-sized viewport for each checkpoint. The viewer can be open on a phone, but that only changes the viewer controls; it cannot change the pixels already stored in the screenshot. A checkpoint also has only one image, so a user cannot compare different screens or component renderings at the same iteration. This change keeps one source checkpoint and one timeline, while storing selectable named visual captures for routes or DOM components at named viewport profiles. It does not recreate images for old checkpoints that never had them.

## Current state

- `src/capture.ts` owns screenshot capture and the JSON preview record. Its current defaults are:

  ```ts
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  const route = options.route ?? '/';
  ```

  `PreviewRecord` stores one `route` and one `viewport` (`src/capture.ts:7-21`). Capture writes `primary.png` and `primary.json` in `.rewindry/previews/<checkpoint-id>/` (`src/capture.ts:90-153`).
- `src/runtime.ts:18-23,59-90` reads `preview.url`, `preview.appId`, and an optional single `preview.route`; it does not pass a viewport or target collection into capture.
- `src/preview-files.ts:8-17` only permits `primary.json` and `primary.png`. The image quota scanner in `src/capture.ts:32-39` also counts only `primary.png`.
- The Vite API in `src/vite-plugin.ts:143-190` and authenticated viewer API in `src/api.ts:95-155` each return one `previewUrl` per checkpoint and serve one image.
- The standalone viewer has one image element (`src/viewer/index.html:31-34`). `src/viewer/viewer.js:78-118` selects that single URL when the timeline changes. The Vite overlay in `src/overlay.js:13-15,67-80` also displays one image URL per iteration.
- `tests/e2e/visual.test.ts:131-167` opens the overlay at desktop and mobile browser sizes to check viewer fit. Its screenshot-capture flow remains at the `captureCheckpoint` default; `:190-192` opens the standalone viewer at 1280×800. The existing mobile check therefore does not prove that the app screenshot itself is mobile-sized.
- The technical spec calls one route and one viewport the MVP limit (`DOCS/rewindry_technical_spec_mvp.md:20-26`). The README direction says no separate lanes or filters (`DOCS/README.md:15`). The user's newer request authorizes a visual-target chooser; preserve a single iteration timeline and add a chooser for the image being viewed.
- Repository conventions: TypeScript ESM, plain JavaScript and CSS for the viewer/overlay, Node.js `>=26`, and npm scripts from `package.json`. Existing browser E2E is in `tests/e2e/visual.test.ts`; unit capture and API tests are in `tests/capture.test.ts`, `tests/vite-plugin.test.ts`, and `tests/api.test.ts`.

## Product and data contract

Use the existing `.rewindry/config.json` `preview` object. Add an optional `targets` array. A target is a named route and optional CSS locator; each target has one or more named viewport profiles. For example:

```json
{
  "preview": {
    "url": "http://127.0.0.1:5173/",
    "appId": "existing-app-id",
    "targets": [
      {
        "id": "bingo-home",
        "label": "Bingo home",
        "route": "/",
        "viewports": [
          { "id": "mobile", "label": "Mobile", "width": 390, "height": 844, "isMobile": true, "hasTouch": true },
          { "id": "desktop", "label": "Desktop", "width": 1280, "height": 800 }
        ]
      },
      {
        "id": "bingo-board",
        "label": "Bingo board component",
        "route": "/",
        "selector": "[data-rewindry-target=\"bingo-board\"]",
        "viewports": [
          { "id": "mobile", "label": "Mobile", "width": 390, "height": 844, "isMobile": true, "hasTouch": true }
        ]
      }
    ]
  }
}
```

A target without `selector` captures the page viewport. A target with `selector` captures exactly one matching DOM element after the route loads. Rewindry must not try to discover React/Vue/etc. components from source code: for an isolated component, the app must expose it on a deterministic route/state and mark its DOM root with a stable selector. Rewindry must not click controls or execute user-provided JavaScript to construct state. A missing or non-unique selector makes that target unavailable for that checkpoint, with an explicit reason.

When `preview.targets` is absent, preserve current behavior: synthesize one default page target using `preview.route` or `/`, with one `Desktop` 1280×800 profile. Do not infer a mobile viewport from the device displaying the viewer. Each image's recorded viewport is fixed when captured.

Limit the configured target × viewport combinations to 12 per checkpoint. Target and viewport IDs must match `^[a-z0-9][a-z0-9-]{0,47}$` and be unique in their own lists. Labels must be 1–64 printable characters; selector strings must be 1–256 characters without control characters. Viewport width and height must be integers from 1 through 4096. Optional `isMobile` and `hasTouch` fields must be booleans and default to false; `deviceScaleFactor` must be an integer from 1 through 3 and defaults to 1. Routes must resolve to the registered local preview origin. These limits keep capture time, path handling, and the existing 256 MiB workspace image budget bounded.

For new checkpoints, persist every configured target/profile result and its label, route, optional selector, viewport/device-emulation settings, status, failure reason, and image filename in `primary.json`. Keep `primary.png` as the compatibility image for the first successful configured target/profile; store other successful variants as `<target-id>--<viewport-id>.png`. Record which variant maps to `primary.png`, and resolve other files only through validated IDs and `safePreviewFile`. This preserves the old `previewUrl` contract even when the first configured target fails. Existing records with only `route`, `viewport`, and `primary.png` must remain readable as one synthesized default target. Do not rewrite old records or claim old missing screenshots have been recovered.

Capture targets sequentially within a checkpoint using a fresh isolated browser context per variant, but reuse the launched Chromium process for that checkpoint. Preserve the existing loopback-only request guard, overlay hiding, source digest checks, Vite app/server/generation checks, and 4 MiB per-image limit. Only publish image files and the final metadata after the post-capture source and generation checks succeed. One target failure must not erase successful captures for other targets; report each target's status. The checkpoint is visually captured if at least one target/profile succeeded, otherwise it remains source-only. Count all target PNGs toward the existing total image budget.

Expose target metadata in both the Vite overlay API and the authenticated standalone viewer API. Keep existing `previewUrl` and `primary.png` behavior for old clients. Add a target-image route to each API, with the same loopback/origin, checkpoint-membership, authentication, regular-file, size, and path validation as the existing image route. The viewer and overlay must offer accessible **Screen/component** and **Viewport** selectors without creating extra timeline points or lanes. Changing either selector changes the image for the selected iteration and leaves timeline/playback position alone. Keep the user's selection while scrubbing. If the selected target/profile is not available for a historical iteration, show an explicit missing-target message; never silently display a different target. The current live frame may remain the existing live page preview.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install exact lockfile | `npm ci` | Exit 0; Node.js 26 or newer is active. |
| Typecheck | `npm run typecheck` | Exit 0 with no TypeScript errors. |
| Unit tests | `npm test` | Exit 0 with all unit tests passing. |
| Browser/Vite E2E | `npm run test:e2e` | Build and E2E exit 0; Playwright Chromium is installed. |
| Build | `npm run build` | Exit 0 and expected distribution assets are produced. |

There is no lint script in `package.json`. Do not add one as part of this plan.

## Scope

**In scope** (modify only these paths):

- `src/capture.ts`
- `src/runtime.ts`
- `src/preview-files.ts`
- `src/vite-plugin.ts`
- `src/api.ts`
- `src/viewer/index.html`
- `src/viewer/viewer.js`
- `src/viewer/viewer.css`
- `src/overlay.js`
- `src/overlay.css`
- `tests/capture.test.ts`
- `tests/vite-plugin.test.ts`
- `tests/api.test.ts`
- `tests/e2e/visual.test.ts`
- `README.md`
- `DOCS/README.md`
- `DOCS/rewindry_mvp_prd.md`
- `DOCS/rewindry_technical_spec_mvp.md`
- `DOCS/rewindry_implementation_plan_mvp.md`
- `project status.md`
- `plans/README.md` (status row only)

**Out of scope** (do not touch):

- SQLite schema or migrations; preview records and image files are filesystem metadata, not SQLite rows.
- Source checkpoint creation/grouping, Git import, restore/apply endpoints, remote sync, agent hooks, setup permissions, or Vite installation behavior.
- Automatic framework component discovery, arbitrary app interaction scripts, authentication-cookie persistence, retroactive screenshot backfill, or historical live execution.
- Untracked `.DS_Store`, `.claude/`, and `.codex/` user files.

## Git workflow

- Current branch at planning time was `main`. Start implementation on a feature branch:

  ```bash
  git switch -c codex/named-visual-targets
  ```

- Recent commits use short imperative subjects (example: `539ddf9 Add public Rewindry README`). Match that style if a commit is needed. Do not push or open a PR unless the operator separately asks.

## Steps

### Step 1: Add and validate named capture target configuration

In `src/capture.ts`, define typed target/profile/variant metadata. In `src/runtime.ts`, extend the `preview` override and `.rewindry/config.json` reader to pass `targets` through. Keep the existing `route` field and current default behavior for configs without `targets`. Validate IDs, labels, routes, selector lengths, viewport dimensions, device-emulation values, uniqueness, and the 12-variant cap before launching Chromium. A configuration error must be visible as a source-only visual failure reason and must not prevent source checkpointing.

Update `README.md` with the minimal configuration example above and explain that an isolated component needs a route/state the app renders plus an optional stable CSS selector. Update `DOCS/README.md` to retain one timeline while clarifying that screen/viewport selection chooses the visual attached to an iteration. Update the PRD/spec/implementation plan to replace the old one-route/one-viewport limitation for configured targets, record the no-auto-discovery/no-backfill boundary, and add this delivery as a visual-capture follow-on. Do not rewrite unrelated product decisions.

**Verify**: `npm run typecheck` → exit 0; `npm test` → existing tests pass. Add unit cases for legacy default config, two named targets, duplicate/unsafe IDs, invalid viewport bounds, unsafe route, duplicate variants, and the 12-variant cap.

### Step 2: Capture and store all configured variants safely

In `src/capture.ts`, capture each target/profile with its own isolated context and the existing route guard. For selector targets, use a CSS-only locator, require exactly one match, and save the element screenshot; for page targets, save the viewport screenshot. Pass `viewport`, `deviceScaleFactor`, `isMobile`, and `hasTouch` into Playwright's browser context. Preserve overlay hiding and all current identity/digest checks across the entire set. Collect per-variant outcomes, enforce the per-image and total-image quotas across all PNGs, and only publish successful files plus `primary.json` after the final stability checks. Keep `primary.png` mapped to the first successful configured variant. Extend `src/preview-files.ts` so only the compatibility filename or validated `<target-id>--<viewport-id>.png` names can be returned, with the same regular-file and size checks.

**Verify**: `npm test` → capture tests pass. Extend `tests/capture.test.ts` with injected capture calls that assert each URL, viewport, device-emulation setting, and selector, independent target success and failure, selector missing/duplicate behavior, source/generation race rejection for the whole set, quota accounting for non-primary PNGs, and legacy `primary.png` readability.

### Step 3: Publish the target catalogue and secure image routes

Update both `src/vite-plugin.ts` and `src/api.ts` to include per-checkpoint target/profile metadata and target image URLs in iteration responses. Preserve the current `previewUrl` field as the compatibility image. Add target-image endpoints without weakening existing local-request checks, the standalone viewer's cookie authorization, checkpoint membership checks, safe file resolution, or content-size limits. When reading older `primary.json` files that do not contain a target list, synthesize the default target from legacy `route` and `viewport` fields.

**Verify**: `npm test` → API tests pass. Extend `tests/vite-plugin.test.ts` and `tests/api.test.ts` to cover multiple images, legacy record fallback, malformed/encoded IDs, missing files, oversized images, symlinks, remote-origin requests, unauthenticated standalone requests, and a checkpoint ID not present in history.

### Step 4: Add target and viewport selection to both viewers

Update `src/viewer/index.html`, `src/viewer/viewer.js`, and `src/viewer/viewer.css` with accessible screen/component and viewport controls. Update `src/overlay.js` and `src/overlay.css` with compact equivalents. Keep one timeline and one selected checkpoint. The selectors must not add dots, filter checkpoints, or reset playback. Preserve selection across previous/next and playback. For an unavailable selected target/profile, keep that selection and show a clear missing-target message rather than falling back to `primary.png`. Ensure controls fit and remain operable at 390×844.

**Verify**: `npm run test:e2e` → E2E exits 0. Extend `tests/e2e/visual.test.ts` to configure a page and selector target with mobile (390×844, mobile/touch emulation) and desktop (1280×800) captures; assert PNG dimensions, target labels and viewport metadata, both UI selectors, changing targets without moving the iteration, selection across timeline navigation, missing-target behavior, accessible names, and mobile control fit. Confirm production build output still excludes Rewindry viewer/overlay assets as the existing test requires.

### Step 5: Record the new product behavior and evidence

Update `project status.md` with a new M5 follow-on row. Keep M5-07's existing statement limited to viewer/overlay fit unless new capture-dimension assertions pass. Record that screenshots are best-effort fresh renders and that source digest does not reproduce dynamic browser state. Do not claim old source checkpoints now have images. Update the docs changed in Step 1 with the verified configuration and current support boundary.

**Verify**: `npm run typecheck` → exit 0; `npm test` → all unit tests pass; `npm run test:e2e` → browser/Vite E2E passes; `npm run build` → exit 0. `git status --short` → only in-scope paths are modified, plus generated files already ignored by the repo.

## Test plan

- Model unit capture cases on `tests/capture.test.ts`; use its injected `capturePage` seam instead of launching a browser for validation/metadata edge cases.
- Model API security and response assertions on `tests/api.test.ts` and `tests/vite-plugin.test.ts`.
- Extend the existing end-to-end harness in `tests/e2e/visual.test.ts`; it already starts a temporary Vite app, Rewindry runtime, standalone viewer, and browser.
- Verify the stored image dimensions from PNG headers or Playwright `naturalWidth`/`naturalHeight`; mobile viewer-shell dimensions alone are insufficient evidence of mobile capture.
- Write no test that expects Rewindry to infer a screen/component from source code or reconstruct missing historical images.

## Done criteria

- [ ] Existing config without `preview.targets` still captures one 1280×800 root-page image as `primary.png`.
- [ ] Configured named routes and unique DOM-selector targets can each capture mobile and desktop viewport profiles, and each saved record keeps its route, selector, viewport, label, timestamp, and status.
- [ ] A bad target is reported without hiding successful sibling targets or corrupting the source checkpoint.
- [ ] Total image accounting includes every new PNG and stays within the existing workspace quota.
- [ ] Old `primary.json`/`primary.png` records and old `previewUrl` clients remain readable.
- [ ] Both viewer surfaces let users switch screen/component and viewport while staying on the same iteration; missing variants never silently fall back to another image.
- [ ] Local-only and authenticated API protections pass their tests; no source restore, remote sync, or persisted browser session is added.
- [ ] `npm run typecheck`, `npm test`, `npm run test:e2e`, and `npm run build` exit 0.
- [ ] `project status.md` and the status row in `plans/README.md` are updated with verified evidence.

## STOP conditions

Stop and report instead of improvising if:

- Any cited current-state excerpt or config path differs from the live repo after the drift check.
- A proposed target configuration requires changing SQLite or the source-checkpoint manifest; pause and propose a separate migration plan.
- Safe target image routing cannot preserve the existing loopback/authentication and symlink/size checks.
- The legacy `primary.png` contract cannot be preserved without changing an existing public API consumer.
- A page's component selector depends on arbitrary clicks, JavaScript injection, authenticated browser state, or remote network access. Report that the app needs a deterministic local route/fixture first.
- Capturing all configured variants cannot stay within existing screenshot and storage limits without weakening those limits.
- Any verification command fails twice after a focused repair attempt.

## Maintenance notes

Changing a route, selector, viewport, or target ID affects only future visual captures; historical source checkpoints remain immutable and retain their stored target catalogue. Keep API and viewer fallback handling for older records indefinitely unless a separately reviewed history migration is approved. Review target-ID validation and file-serving tests carefully because image paths are project-controlled metadata. Keep the historical screenshot labelled with its actual route and viewport, and never imply that a matching source digest reconstructs dynamic UI state. Component captures are locator screenshots from app-provided deterministic states, not framework-aware component history.
