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

The timeline is read-only: it does not restore, revert, apply, or execute historical code. It is a sequence of local browser captures, not a video recording.

## Named visual captures

By default, Rewindry captures the root page at 1280×800. To capture specific screens or app-provided components at mobile and desktop sizes, add `targets` to the `preview` object in `.rewindry/config.json`:

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

For a component capture, your app must render that component on a deterministic local route/state and mark one DOM root with a stable CSS selector. Rewindry takes a screenshot of that matching element; it does not discover framework components or click controls to create app state. The standalone viewer and dev overlay let you choose **Screen/component** and **Viewport** while staying on the same iteration. New targets apply to future captures automatically; older checkpoints keep their saved images until you run an explicit backfill.

### Backfilling older checkpoints

> Not yet in the published npm package. Available from a source build as `node dist/cli.js backfill --run-historical-source`.

`rewindry backfill --run-historical-source` adds missing visuals to checkpoints you already have. For each checkpoint, oldest first, it:

- rebuilds that checkpoint's saved files in a temporary folder under `.rewindry/tmp/` (never in your working copy), then deletes the folder;
- starts that checkpoint's saved Vite config on a private loopback port, reusing your project's currently installed `node_modules`. It never runs `npm install` or package scripts;
- captures every configured `preview.targets` screen and viewport that the checkpoint does not already have.

The flag is required because the command runs old project code. Without it, nothing is executed or written. Backfill never changes a checkpoint's source, digest, timestamp or Git history, never adds timeline points, and never replaces an existing image: a live `primary.png` stays byte-for-byte, and a replay only becomes `primary.png` when the checkpoint had none. Rerunning skips variants that already succeeded and retries ones that failed.

Replayed images are labelled **Replayed from saved source** in both viewers. They are a best-effort re-render, not the original screen: files outside the saved source, dependencies that changed since, environment variables, network data and browser state can all change the pixels. A checkpoint whose saved source no longer builds stays source-only, with the failure reason shown.

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

Project history is stored locally in `.rewindry/`. Rewindry does not require an account or upload project history to a Rewindry cloud service. The history can contain source code, and screenshots can show app data, so treat the project history like other private project files.

Screenshots are fresh renders from your local development preview. Environment variables, remote data, browser storage, and an existing tab's runtime state are not reconstructed. If a screenshot cannot be tied to a stable source state, Rewindry keeps the source checkpoint and reports the visual as unavailable rather than inventing a preview.

Agent prompt boundaries are only available for tested editions. For an unverified agent or an edit without a recognised turn boundary, Rewindry can record grouped local edits, but cannot promise one checkpoint per prompt. Changes in remote or unwatched worktrees are not captured until they appear in the monitored project.

## License

MIT. See [LICENSE](LICENSE).
