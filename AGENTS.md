# Rewindry repository instructions

- Read `DOCS/rewindry_mvp_prd.md`, `DOCS/rewindry_technical_spec_mvp.md`, `DOCS/rewindry_implementation_plan_mvp.md`, and `project status.md` before changing behavior.
- Update `project status.md` on every implementation turn: mark affected work in progress at the start, then record verified results and remaining gaps before ending. Keep every M0-M6 plan row and PRD 1-25 criterion honest. A fixture does not verify a real agent edition or OS lifecycle.
- Preserve the existing deleted root documentation and untracked `DOCS/` state unless explicitly asked to change it.
- Keep review read-only. Never add source restore/apply endpoints, remote history sync, or a claim that a source digest reproduces dynamic browser state.
- Use Node 26 for the observed local build. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:e2e`, and `npm run build` as appropriate. Browser E2E requires Playwright Chromium.
- Build the CLI with `npm run build`, then use `node dist/cli.js setup --dry-run` to inspect changes. Do not publish or claim `npx rewindry@latest` while `package.json` is private and release gates are open.
- Add a versioned, idempotent migration for any SQLite schema change. Test migration from the previous schema and failure rollback.
