# Rewindry

Local visual history for code-driven product iterations.

Rewindry records local source checkpoints as you build. When a supported local Vite preview is available, it also captures a screenshot for the finished checkpoint. Review earlier iterations in a small development timeline or the standalone viewer, inspect historical files and diffs, and copy code without changing your working tree.

## Quick start

Requires Node.js 26 or newer. The verified persistent setup target is macOS on Apple silicon.

From the root of your project, run:

```sh
npx rewindry@latest setup
```

Then start your app with its usual development command, for example:

```sh
npm run dev
```

Setup creates a baseline and starts local source capture. In a supported Vite project, it adds a reversible development-only preview integration while preserving your existing dev command. It also detects installed coding agents and merges hooks only for editions with verified integrations. Review any project-trust prompt shown by your agent; Rewindry does not bypass it.

Once the preview is running, use your app and coding tools as usual. Changed, completed turns and groups of local edits become timeline checkpoints. When the dev preview is unavailable, source history can still be reviewed without screenshots.

The preview stays clear while the timeline is closed. Press `Alt+Shift+R` to open or close it, move the pointer to the bottom-centre trigger to reveal it, or tap the trigger's former position on touch devices. Press `Escape` to close the timeline.

## What you can do

- Browse a timeline of recorded source iterations and available screenshots.
- Inspect historical files and diffs, and copy their contents.
- Review Git history separately from Rewindry checkpoints.
- Continue capturing source while the dev server is stopped.
- Use the standalone viewer when the app preview is unavailable.
- See how one component, a whole screen, or a screen at one breakpoint changed across iterations (from a source build; see below).

The timeline is read-only: it does not restore, revert, apply, or execute historical code. It is a sequence of local browser captures, not a video recording.

## Screen and component history

> Not yet in the published npm package. Available from a source build (`npm run build`, then `node dist/cli.js …`).

Rewindry can keep a separate history for every screen and React component you work on, at mobile, tablet and desktop sizes. There is nothing to configure or press.

**How it learns screens.** While your Vite dev server runs with the Rewindry plugin, a small development-only recorder watches how you use the app in any browser: yours, a second browser, or a coding agent's test browser.
- It records page URLs, clicks, the Escape key and dropdown choices, each as a few ways to find that control again (test ID, role and label, short CSS path).
- When a click makes something new appear, such as a dialog, popover or sheet, the recorder saves how to get there from page load. Opening a screen once is enough.

**What it never records.** Typed text, input values, clipboard, cookies and browser storage. The dev server rejects any report that carries them.

**How it captures, with no browser open.** After each update (an agent turn or a group of edits), Rewindry renders screens in a background browser:
- It renders your landing page, plus every learned screen that uses a file you changed.
- It replays the saved clicks and screenshots each screen at every breakpoint.
- It cuts out every React component it can attribute to a source file.
- Identical screenshots and crops are stored once and recorded as unchanged. A history therefore shows only real visual changes.
- At most 36 screenshots are taken per update. Screens over that limit are recorded as skipped.
- If a saved click no longer matches anything, that screen is marked unreachable for the update and keeps its earlier images. The next time you open it in a browser, the path is relearned.

**Looking back.** Run `rewindry viewer` and choose **Screens**:
- *Component* shows one component's real versions.
- *Screen* shows a whole screen's versions.
- *Breakpoint* narrows either view to one size.
- Compare puts two versions side by side.
- *Code at this iteration* opens that iteration's files and diff.

Options in the `preview` object of `.rewindry/config.json`:

| Option | Default | Meaning |
| --- | --- | --- |
| `widget` | `true` | `false` hides the development timeline widget. Capture and learning keep running. You can also pass `rewindryPreviewPlugin(appId, { widget: false })`. Don't remove the plugin to hide the widget, because removing it stops capture. |
| `route` | `/` | The landing page that always gets history, for example `/?welcome=1`. |
| `profiles` | mobile 390×844 @2x, tablet 768×1024 @2x, desktop 1280×800 | Up to 6 breakpoints, each `{ "id", "label", "width", "height", "isMobile", "hasTouch", "deviceScaleFactor" }`. |

**Limits:**
- Component zoom needs a React development build. Other apps get screen-level history only.
- Screens that only appear on hover, or after typing, are not learned.
- Replays use your local dev server and data, so live backend data, sign-in state, time and randomness can make pixels differ from what you saw.
- Only Chromium rendering has been tested.

## Named visual captures

Named targets are an optional manual override for screens that the passive history cannot reach. Without them, the legacy per-iteration image is the root page at 1280×800. To capture specific screens or app-provided components at mobile and desktop sizes, add `targets` to the `preview` object in `.rewindry/config.json`:

```json
{
  "preview": {
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
        "route": "/?screen=board",
        "selector": "[data-rewindry-target=\"bingo-board\"]",
        "viewports": [
          { "id": "mobile", "label": "Mobile", "width": 390, "height": 844, "isMobile": true, "hasTouch": true }
        ]
      }
    ]
  }
}
```

For a named component capture, your app must render that component on a deterministic local route/state and mark one DOM root with a stable CSS selector. Rewindry takes a screenshot of that matching element. Named targets do not use learned clicks or component discovery; those belong to the screen and component history above. The standalone viewer and dev overlay let you choose **Screen/component** and **Viewport** while staying on the same iteration. New targets apply to future captures automatically; older checkpoints keep their saved images until you run an explicit backfill.

### Backfilling older checkpoints

> Not yet in the published npm package. Available from a source build as `node dist/cli.js backfill --run-historical-source`.

`rewindry backfill --run-historical-source` adds missing visuals to checkpoints you already have. For each checkpoint, oldest first, it:

- rebuilds that checkpoint's saved files in a temporary folder under `.rewindry/tmp/` (never in your working copy), then deletes the folder;
- starts that checkpoint's saved Vite config on a private loopback port, reusing your project's currently installed `node_modules`. It never runs `npm install` or package scripts;
- captures every configured `preview.targets` screen and viewport that the checkpoint does not already have;
- replays your learned screens at every breakpoint against that checkpoint's own files, adding per-screen and per-component history for iterations that were never screenshotted.

The flag is required because the command runs old project code. Without it, nothing is executed or written. Backfill never changes a checkpoint's source, digest, timestamp or Git history, never adds timeline points, and never replaces an existing image: a live `primary.png` stays byte-for-byte, and a replay only becomes `primary.png` when the checkpoint had none. Rerunning skips variants that already succeeded and retries ones that failed.

Replayed images are labelled **Replayed from saved source** in both viewers and on the Screens page. Click paths are learned from today's app, so an old iteration that has no such control is recorded as unreachable for that screen. They are a best-effort re-render, not the original screen: files outside the saved source, dependencies that changed since, environment variables, network data and browser state can all change the pixels. A checkpoint whose saved source no longer builds stays source-only, with the failure reason shown.

## Commands

Run these from the project root:

| Command | Description |
| --- | --- |
| `npx rewindry@latest setup --dry-run` | Preview setup changes without writing files. |
| `npx rewindry@latest setup` | Install or refresh Rewindry for this project. Safe to rerun. |
| `npx rewindry@latest status` | Check source capture, workspace registration, and preview configuration. |
| `npx rewindry@latest doctor` | Show status plus service and capture diagnostics. |
| `npx rewindry@latest viewer` | Open saved history in the standalone local viewer. |
| `npx rewindry@latest setup --rebind-moved` | Explicitly register a project after moving its directory. |
| `npx rewindry@latest uninstall` | Remove this project's Rewindry integrations and service registration; keep its history. |

## Compatibility

The current verified setup is macOS arm64 with Node.js 26. The verified preview combination is React 19 with Vite 8.3.4. Other operating systems, Node versions, and framework configurations are not yet verified.

Agent support is edition-specific:

| Agent edition | Current evidence |
| --- | --- |
| Codex CLI 0.144.4 | Real turn lifecycle and edit capture verified. A project-trust approval may be required. |
| Claude Code 2.1.296 | Real turn lifecycle and consecutive edit capture verified. |
| Cursor IDE 3.24.9 | Paired lifecycle hooks verified; edit-to-checkpoint capture is still unverified. |
| Other editions and agents | Local source changes may be grouped by inactivity, but one checkpoint per prompt is not guaranteed. |

See [the compatibility notes](DOCS/compatibility.md) for the evidence and caveats behind these claims.

## Local data and fidelity

Project history is stored locally in `.rewindry/`. Rewindry does not require an account or upload project history to a Rewindry cloud service. The history can contain source code, screenshots and component crops can show app data, and learned screens store the labels and text of controls you clicked. Treat the project history like other private project files.

Screenshots are fresh renders from your local development preview. Environment variables, remote data, browser storage, and an existing tab's runtime state are not reconstructed. If a screenshot cannot be tied to a stable source state, Rewindry keeps the source checkpoint and reports the visual as unavailable rather than inventing a preview.

Agent prompt boundaries are only available for tested editions. For an unverified agent or an edit without a recognised turn boundary, Rewindry can record grouped local edits, but cannot promise one checkpoint per prompt. Changes in remote or unwatched worktrees are not captured until they appear in the monitored project.

## License

MIT. See [LICENSE](LICENSE).
