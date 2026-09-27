# Medtryx web application

Medtryx is being built in roadmap bundles for one pharmacy on one local server. Product scope and release gates are in the [simplified specification](Medtryx_Simplified_Web_Product_and_Technical_Specification.md) and [implementation roadmap](Medtryx_Web_Tech_Stack_and_Roadmap.md). Current progress and decisions are in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Local development

The roadmap target is Node.js 24 LTS. The current development environment may use another Node version; run the app with Node 24 before pilot deployment.

1. Copy `.env.example` to `.env` and use unique local credentials if you need an owner account.
2. Run `npm install` from the repository root.
3. Run `npm run db:migrate` to apply migrations to the selected environment's database.
4. For a fresh development database only, set `MEDTRYX_OWNER_EMAIL` and `MEDTRYX_OWNER_PASSWORD` in `.env`, then run `npm run db:create-owner`. Bootstrap refuses to add an owner once that environment has any users.
5. Run `npm run dev`. Vite is available at `http://127.0.0.1:5173`; Express listens on `http://127.0.0.1:3001` and Vite proxies `/api` requests.

`APP_ENV` selects an isolated SQLite file: `development`, `test`, or `live`. By default files are under the ignored `data/` directory. Do not copy development or test databases into live use. The test suite creates synthetic users and isolated test databases. No default staff accounts or real customer data are included.

The local browser development server uses HTTP. App session cookies remain `Secure` by default; browsers permit secure cookies on loopback hosts. `COOKIE_SECURE=false` is reserved for the automated HTTP test server. Pilot network access requires the planned local HTTPS reverse proxy and trusted certificates, which are not configured yet.

## Checks

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e` (requires Playwright Chromium; uses only a separate synthetic test database)

The first bootstrap is intentionally a command-line operation so there is no public registration route. Owners create and deactivate subsequent owner or cashier accounts under **Settings**. Staff can change their own password after signing in.
