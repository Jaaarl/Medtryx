# V1 implementation plan and record

## Attribution

- Plan: GPT-6.1 Sol
- Implementation: GPT-6 Luna xhigh

This document records the scoped v1 work and its verification status. The current feature contract is [V1_SPECIFICATION.md](V1_SPECIFICATION.md); deployment procedures are maintained in [DEPLOYMENT_AND_RECOVERY.md](DEPLOYMENT_AND_RECOVERY.md).

## Plan summary

1. **Preserve saved database meaning.** Persist one currency per database; default new databases to PHP, allow USD only when initializing a new empty database, and pin legacy financial databases and backups to PHP. Reject currency mismatches before migrations or restore changes. Do not reset live data or rewrite historical amounts.
2. **Expose and enforce the installation contract.** Use the shared `AppConfig` schema and public `/api/config` response (`currency`, `currencySymbol`, `locale`, `businessTimeZone`). Keep business-date behavior in Manila. Enforce PHP-only SC/PWD/BNPC behavior on the server, including policy writes and CSV import paths, while keeping generic regular-sale tax policy and approval available.
3. **Bootstrap the browser safely.** Wait for validated `/api/config` before rendering pages that display money. On failure, show a clear retry state with no assumed PHP display.
4. **Use one precise money formatter.** Centralize symbol, locale, and currency-aware labels. Format money from exact integer cents with sign and decimal precision intact. Cache the locale formatter after bootstrap. Replace fixed PHP symbols and labels across the app, sales, receipts, activity views, and currency-aware exports. Use installation currency in downloaded import templates and exported financial CSVs.
5. **Align interface typography.** Use shared semantic type tokens for page headings, cards, body/table text, buttons, labels, and form controls while preserving responsive layouts and receipt print hierarchy.
6. **Document the operational release path.** Run CI on Node 24 and deploy only through a reviewed manual workflow restricted to the `v1` ref. Package and identify the exact revision, run live preflight and a pre-migration safety snapshot, then install the release. Treat host, domain, credentials, secondary storage, backup protection, and restore rehearsal as operator setup that must be completed on the real VPS.
7. **Publish one current v1 reference and clear frontend lint debt.** Replace competing specifications and stale status/roadmap/prompt documents with pointers to the current specification and runbook. Refactor the four existing inventory-page set-state-in-effect cases without disabling lint rules or adding unrelated workflow changes.

## Implementation notes

- Existing migration files remain unchanged. The database startup path checks the saved currency for compatibility before applying migrations; no reset or new migration was applied for this work. Legacy financial data without currency metadata is treated as PHP, and restore compatibility checks prevent silently relabeling saved values.
- `apps/web/src/currency.ts` is the shared formatter. It uses `BigInt` cents for fixed-precision values and locale formatting for monetary API strings; it throws if a caller formats money before configuration is ready.
- Currency choice is installation metadata, not an exchange-rate feature. A stored database currency cannot be changed to relabel existing amounts.
- Regional benefit fields, policy settings, and report details are hidden in USD in the web UI. Server enforcement remains authoritative. Dynamic owner import templates and monetary exports carry the installation currency.
- Existing PHP workflows remain in place. Manila timezone formatting remains explicit even when the display locale is `en-US`.
- The deployment workflow is manual, restricted to `v1`, and deploys a specific reviewed revision. The repository includes examples and a VPS runbook; no claim is made that the host or a recovery rehearsal is already configured.
- The main product specification describes current code behavior and its limits; it does not claim external provider retention is controlled by Medtryx.

## Validation record

No tests were added or run for this work. Targeted ESLint on `apps/web/src/inventory-pages.tsx` and targeted web typecheck passed. Full repository lint, typecheck, and build passed; the Vite build emitted a large-chunk warning (>500 kB). `bash -n` passed for the deployment shell script, and the deployment workflow YAML parsed successfully.

Local read-only verification returned HTTP 200 from `/api/health` and reported PHP from `/api/config`. Counts for users, products, sales, sale lines, shifts, cash movements, expenses, stock events, and audit events matched the before-check snapshot. The migration count remained 28 before and after verification. No database reset or new migration was applied, no live transaction data was written, and no deployment or push was performed. Repository-wide `npm run format:check` passed.
