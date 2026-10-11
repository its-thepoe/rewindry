# Failure and recovery

Rewindry keeps source history under each project's `.rewindry` directory. Most failures pause new capture; they do not remove completed checkpoints. Do not delete `.rewindry` when diagnosing a problem.

## Check capture health

Run these commands from the project root:

```sh
rewindry status
rewindry doctor
```

`status` reports source-capture state, checkpoint count, source-storage use, workspace registration, and preview configuration. `doctor` also prints the daemon socket, observed writes, and diagnostics. A nonzero exit or `Daemon offline` means new source capture is not active.

## Recover common failures

| Symptom | Meaning | Recovery |
| --- | --- | --- |
| `Daemon offline. Source capture is not active.` | The user service is not answering. | Run `rewindry setup` from the project root, then check `rewindry status` again. Existing `.rewindry` history is preserved. |
| `Workspace needs re-registration.` | The registered project path no longer exists, often after moving the project. | From the moved project, run `rewindry setup --rebind-moved`. This explicitly rebinds the old registration and refreshes reversible integrations. |
| `Workspace is not registered.` | The daemon is running for other roots, but not this project. | Run `rewindry setup` from this project's root. |
| `Source capture: paused, storage limit reached` | The configured source-history budget is exhausted. | Existing checkpoints remain readable. Review `rewindry doctor` and `.rewindry` storage before changing capture limits; Rewindry does not automatically delete history to make room. |
| `Visual capture: unavailable` | Source capture can continue, but no usable preview is registered. | Start the supported local Vite dev command and verify its configured route. Use `rewindry viewer` to inspect saved history without a live preview. |
| `visual unavailable`, `source changed`, or preview-readiness diagnostics | A screenshot could not be tied to a stable preview state. | Keep the source checkpoint; fix the compiler or dev-server issue and make a later edit. Rewindry does not relabel an unverified image as successful. |
| Watcher or malformed-journal diagnostic | A filesystem event was missed or journal data could not be replayed. | Check `rewindry doctor`. Watcher errors trigger a digest rescan. Do not hand-edit journal records; retain the project store and report persistent diagnostics. If a journal path is reported as a symlink, inspect its target before making any filesystem change. |
| Setup reports a permission or LaunchAgent error | macOS refused the user-level background-service operation. | Use the diagnostic to identify the denied operation. Do not assume the service is active; retry `rewindry setup` after correcting the permission. |

## Inspect history when capture is unavailable

Run `rewindry viewer` in the project root and open the local URL it prints. The standalone viewer reads completed history without requiring the dev server. If a checkpoint object is corrupt or missing, the viewer reports it as unavailable; it never substitutes current source bytes for historical content.

Uninstalling the integration also preserves history:

```sh
rewindry uninstall
```

This removes Rewindry's registered integration for the selected workspace, not its `.rewindry` source history.

## Known recovery limits

- Machine sleep/wake and reboot behavior has not been verified on the supported host yet.
- Real OS permission denial and real disk exhaustion have not been induced; current evidence uses deterministic failure injection.
- Cursor and Claude Code lifecycle capture is not enabled until their real-host boundary probes pass.
- A moved workspace requires explicit `--rebind-moved`; Rewindry does not guess that two paths are the same project.
