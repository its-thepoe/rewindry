# Rewindry compatibility

Last verified: 10 October 2026. These are observed combinations, not promises for newer host editions.

| Surface | Status | Evidence |
| --- | --- | --- |
| macOS arm64, Node 26.0.0 | Verified | User-level LaunchAgent bootstrapped and restarted with one preserved checkpoint; one-command setup/uninstall passed. |
| React 19 / Vite 8.3.4 | Verified | Original dev command, real Chromium capture, in-app timeline, offline retry, compiler-error fallback and production exclusion passed. |
| Codex CLI 0.144.4 | Verified after hook trust | Real `UserPromptSubmit`/`Stop` shared a turn ID; a Codex edit produced one immutable checkpoint and the correct Vite screenshot. Project hooks require Codex trust review. |
| Cursor IDE 3.24.9 | Unverified | Candidate adapter and config merge have fixture tests only. Setup does not install Cursor hooks. |
| Cursor Agent 2026.07.23-e383d2b | Unsupported for confirmed turns | No verified paired start/end boundary. |
| Claude Code | Unverified | Claude Desktop 2.31226.1 is present, but no Claude Code CLI or real hook-turn fixture was available. Setup does not install Claude hooks. |
| Other OS, Node or Vite versions | Unverified | Source capture may work, but persistent setup and visual replay are not claimed. |

Current package status: local build only. `package.json` is private; `npx rewindry@latest setup` is not published yet. Supported setup runs `node dist/cli.js setup` from this checkout after `npm ci && npm run build`.

Historical screenshots are fresh local-browser renders of the recorded source. Environment variables, external data and an existing tab's HMR runtime state are not reconstructed. When proof is insufficient, the checkpoint remains source-only.
