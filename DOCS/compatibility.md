# Rewindry compatibility

Last verified: 11 October 2026. These are observed combinations, not promises for newer host editions.

| Surface | Status | Evidence |
| --- | --- | --- |
| macOS arm64, Node 26.0.0 | Verified | User-level LaunchAgent bootstrapped and restarted with one preserved checkpoint; one-command setup/uninstall passed. |
| React 19 / Vite 8.3.4 | Verified | Original dev command, real Chromium capture, in-app timeline, offline retry, compiler-error fallback and production exclusion passed. |
| Codex CLI 0.144.4 | Lifecycle and edit probes verified; hook trust review pending | Real `UserPromptSubmit`/`Stop` shared a turn ID; a Codex edit produced one immutable checkpoint and the correct Vite screenshot. Project hooks still require the user's trust review. |
| Cursor IDE 3.24.9 | Lifecycle verified; edit capture pending | Real `beforeSubmitPrompt` and `stop` hooks shared `conversation_id` and `generation_id`; sanitized fixture retained. CLI probes are not counted as IDE evidence. A real edit-to-Rewindry-checkpoint probe remains before release. |
| Cursor Agent 2026.07.23-e383d2b | Unsupported for confirmed turns | No verified paired start/end boundary. |
| Claude Code 2.1.296 | Verified | Real paired hooks shared `session_id` and `prompt_id`; two consecutive changed prompts produced two checkpoints with exact final bytes, including three separate edits followed by a 30-second in-turn pause. Setup automatically installs hooks for this edition. |
| Other OS, Node or Vite versions | Unverified | Source capture may work, but persistent setup and visual replay are not claimed. |

Current package status: `rewindry@0.1.4` is published on npm with the `latest` tag. A fresh `npx rewindry@latest setup --dry-run` succeeded from a separate project directory. The verified persistent setup path is macOS with Node 26; broader host/platform and product-release validation remain open.

Setup probes installed agent CLI versions without requiring provider sign-in. It automatically merges project hooks only for editions with verified real-host turn boundaries, including Cursor IDE 3.24.9; other detected editions are reported but left unchanged. No manual hook-config editing is expected from users. A host may still require an explicit project-trust approval.

Historical screenshots are fresh local-browser renders of the recorded source. Environment variables, external data and an existing tab's HMR runtime state are not reconstructed. When proof is insufficient, the checkpoint remains source-only.
