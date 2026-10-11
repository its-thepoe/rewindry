# rewindry

## Project documents

| Document | Purpose |
| --- | --- |
| [MVP product requirements](rewindry_mvp_prd.md) | User promise, scope, journeys, and acceptance criteria |
| [MVP technical specification](rewindry_technical_spec_mvp.md) | Proposed architecture, data model, integrations, and security boundaries |
| [MVP implementation plan](rewindry_implementation_plan_mvp.md) | Delivery sequence, tests, and release gates |

## Review at a glance — 10 October 2026

The original plans remain intact. Each document ends with a **Design and product engineering review addendum** containing proposed changes, the reason for each change, and concrete validation or implementation steps. These are recommendations awaiting a product decision; they do not silently replace the original requirements.

**User-confirmed UI direction:** The timeline is for moving through recorded iterations. Show the visual and time; keep the live current working state last. Capture type and edit grouping are automatic internal rules, not choices or badges. Do not add thumbnails, changed-file counts, separate lanes, or filters. This corrects the earlier review's UI suggestions and takes precedence over them when planning the interface.

**Highest-impact recommendations:**

1. Keep the interaction to moving between recorded iterations and the live current state. Show the visual and time; capture and grouping happen automatically behind the scenes.
2. Prove one compelling, verified visual journey on one supported macOS + React/Vite + agent combination before committing to every adapter, Git import, and persistent installer path.
3. Treat a matching source digest as evidence about files, not proof that the browser rendered that exact source or the same UI state.
4. Keep historical source access isolated from application JavaScript, including third-party scripts running in the dev preview.
5. Fix eligible-file coverage and workspace identity before claiming that a checkpoint represents the whole app.

**Decision order:** run the product and integration spikes in the implementation-plan addendum, choose the first supported environment, then accept or reject the proposed scope changes before coding the full MVP. The existing PRD's one-confirmed-turn policy remains the starting hypothesis.
