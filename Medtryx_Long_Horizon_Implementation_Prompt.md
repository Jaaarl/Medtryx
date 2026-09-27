# Medtryx long-horizon implementation prompt

Copy the prompt below into a Codex coding session opened at this project folder. Git is already initialized on `main`; the repository has no commits yet, and the four Markdown documents are currently untracked.

```text
Build Medtryx into a pilot-ready web application, working through the roadmap one complete feature bundle at a time. Continue from the current repository state until the release checklist in the roadmap is satisfied or a genuine external decision blocks the remaining work.

Read these files first:
1. Medtryx_Simplified_Web_Product_and_Technical_Specification.md — product requirements and acceptance criteria.
2. Medtryx_Web_Tech_Stack_and_Roadmap.md — chosen stack, architecture, phase order, and release gates.

These two files are the source of truth. Medtryx_Product_and_Technical_Specification.md is older reference material only; do not bring its Android, lot/expiry, bundles, or other deferred features into the MVP unless I explicitly change the scope.

Implementation constraints:
- Frontend: React, TypeScript, Vite, Tailwind CSS, and React Router browser routing.
- Backend: Node.js, TypeScript, Express, Zod validation, SQLite on one local server, and the supporting libraries named in the roadmap.
- Only the owner can create, edit, deactivate, or import inventory products, change stock and prices, view cost/profit data, and approve reversals. A cashier may select existing active inventory products and add them to a checkout cart, then complete sales.
- Each stock receipt has its own unit acquisition cost. The SKU has one current selling price. Use moving weighted-average cost and save COGS on sale lines.
- SC/PWD and tax calculations are line-level; keep approved rounding and immutable sale snapshots. Sale, stock quantity, stock value, and internal ID must commit atomically.
- Backups are unencrypted but access-restricted, with a separate second copy and a tested restore.
- Use synthetic data for development and tests. Keep development, test, and live data separate.

How to work:
1. Inspect the workspace, Git status, and any existing code or instructions before editing. Git is already initialized: do not run git init again. Add an appropriate .gitignore and make the first baseline commit containing the current Markdown documents. Do not include secrets, database files, backups, build output, or node_modules in Git. Preserve any existing user work.
2. Create IMPLEMENTATION_STATUS.md with a small ordered list of feature bundles drawn from the roadmap. For each bundle, record its scope, dependencies, acceptance checks, status, and important decisions. Keep this file current as work progresses.
3. Build the next bundle end to end: schema/migration, server logic and authorization, browser UI where applicable, and the meaningful tests needed for its risk. Keep the bundle small enough to review in one diff. Examples are authentication, owner-only catalog, stock receipts and costing, tax engine, checkout finalization, reversals and shifts, reports, and backup/restore.
4. Run the relevant checks for that bundle: formatting/lint, TypeScript typecheck, focused unit and integration tests, build, and browser tests where a browser workflow changed. Fix failures before moving on. Verify the acceptance criteria in the two source documents. Do not add tests that merely copy the implementation.
5. Update IMPLEMENTATION_STATUS.md and any affected documentation, review the diff, and make one Git commit for the completed bundle. Use a clear message such as feat(catalog): add owner-only product management. Include its migration, code, tests, and documentation in that commit. Do not mix unrelated features or commit a failing bundle.
6. Continue to the next bundle without waiting for approval after every commit. Send me concise progress updates at milestones with the completed bundle, checks run, commit hash, and next bundle.
7. If a requirement is unclear, make a documented reasonable choice when it is reversible. Ask me only when an answer would materially change tax/accounting policy, legal/compliance behavior, deployment, or the product scope. Continue independent work while awaiting that answer.
8. Before calling the app pilot-ready, complete the roadmap release checklist, test backup restore and simultaneous last-unit sales, verify cashier/owner permissions through direct API calls, and test the actual planned browsers/local network. Report any checklist item that needs physical hardware or owner/professional sign-off as pending; do not claim it passed without evidence.

At the end of each session, leave IMPLEMENTATION_STATUS.md accurate enough for a new session to resume from the next bundle. In the final report, list completed bundles and commit hashes, checks and results, remaining work, and decisions needed from me. Do not deploy to the live pharmacy or use real customer data without my explicit authorization.
```

To resume in a later session, use:

```text
Continue Medtryx from IMPLEMENTATION_STATUS.md. Read the two source-of-truth specification files, inspect Git history and the working tree, then implement, verify, and commit the next incomplete feature bundle using the long-horizon prompt's rules. Keep going through the roadmap unless a genuine external decision blocks the remaining work.
```
