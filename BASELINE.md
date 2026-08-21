# Baseline — verified state before the production build

Recorded before any change on `claude/business-os-production-els802`.
Every result below was **run, not assumed**, on a fresh clone with a clean
Postgres 16 and Redis 7.

| Field      | Value                                      |
| ---------- | ------------------------------------------ |
| Commit     | `8388cc809fe5913a76865f721f536d84601accb8` |
| Branch     | `main` (= `claude/business-os-production-els802` at start) |
| Node       | v22.22.2                                   |
| pnpm       | 10.33.0                                    |
| Postgres   | 16 (service), migrated from zero           |
| Redis      | 7 (service)                                |

## Results

| Check                                | Result | Detail                                                        |
| ------------------------------------ | ------ | ------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`     | pass   |                                                               |
| `pnpm format:check`                  | pass   |                                                               |
| `pnpm lint`                          | pass   | flat-config ESLint over every app and package                 |
| `pnpm typecheck`                     | pass   | 14 projects                                                   |
| `pnpm build`                         | pass   | site, dashboard, API. Requires `BOS_WORKSPACE_SLUG`; must not run with `NODE_ENV` exported as `development` (mixed React builds crash the export) |
| `pnpm --filter @bos/database test`   | pass   | 5 RLS assertions, as the migration owner orchestrating two app-role connections |
| `pnpm test`                          | pass   | 61 API tests + sanitize + business-types + database, `TEST_DATABASE_URL` as `bos_app` |
| `pnpm db:migrate` from zero          | pass   | migrations → RLS → grants                                     |
| `workspace:provision nuesheba`       | pass   | workspace, brand, location, pipeline, 6 stages, form          |
| `workspace:seed-smoke nuesheba`      | pass   | fixture service + 2 pages                                     |
| `pnpm smoke … --submit-form`         | pass   | 18/18 — including a real form submission creating a lead      |
| `pnpm redirects:verify`              | pass   | 0 redirects imported (vacuous but wired)                      |
| `pnpm check:readiness`               | **fail (by design)** | 5 blockers: placeholder phone, WhatsApp, email, street address, empty `sameAs` — all owner facts. CI runs this `continue-on-error`; the go-live checklist removes that. |

## Task-board state at baseline (docs/tasks/README.md)

Done: 101–108, 201, 204, 205, 206, 208, 303, 402, 403, 501, 502, 601, 602.
Open: 202 (section editor UI), 203 (media library), 207 (JSON-LD wiring),
209 (form-builder UI), 210 (WordPress adapter), 301/302 (NuESheba config and
pages), 401 (contacts UI), 404 (documents UI + scanning), 503/504 (automation
engine + builder), 505 (WhatsApp), 603 (analytics dashboard), 604 (Search
Console), 701 (SEO audit), 702 (AI suggestions), 801 (second tenant).

## Known launch blockers at baseline

1. `check:readiness` — the 5 owner-fact blockers above (tracked in
   `docs/owner-input-required.md`).
2. CI carries `continue-on-error` on the readiness job — removal is a go-live
   checklist item, deliberate until the owner facts arrive.
3. No CAPTCHA configured in the smoke stack (`TURNSTILE_SECRET_KEY` unset —
   the API warns at boot and refuses in production).

## Historical claims verified

The task board's "production vertical slice" claim is real: the slice runs
end-to-end from a clean database, and the smoke suite proves the pieces are
connected — content → service page → form → lead → dashboard sign-in gate,
with security headers, robots/noindex, JSON-LD, sitemaps and tenant isolation
checked along the way.
