# Threat model

What we protect, from whom, and the specific mechanism that does it. Every
mitigation below names real code so this document decays visibly instead of
silently.

## Assets, in order of blast radius

1. **Applicants' private documents** — transcripts, certificates, national ID
   scans. Regulated-adjacent personal data belonging to people who are not
   users of the system and cannot protect themselves.
2. **Session credentials** — a stolen staff session reads every enquiry.
3. **The CRM dataset** — names, phone numbers, enquiry text.
4. **The public site's integrity** — an injected script on a page that
   collects personal data is asset #1 by another door.
5. **Tenant isolation** — one client must never read another's rows.

## Actors

- Anonymous internet traffic (bots, scrapers, spam, opportunistic attackers)
- A visitor with a crafted request (parameter tampering, IDOR attempts)
- A phished or careless staff member
- A malicious or compromised staff account (insider)
- A compromised upstream (npm dependency, WordPress plugin on an imported
  site, a webhook sender impersonating Meta)
- The platform operator's own mistakes (the most frequent attacker of all)

## Trust boundaries and their guards

### Internet → public site and API

- Every route must declare its access class or the API refuses to boot:
  the `onRoute` collector + `assertEveryRouteIsClassified` (apps/api/src/app.ts),
  with a fail-closed 403 for anything unclassified at runtime
  (lib/context.ts). "Forgot to add auth" is a failed boot, not an exposure.
- The single unauthenticated write path (form submission) stacks honeypot,
  fill-time scoring, per-IP and per-form rate limits, Turnstile when
  configured, stored-definition validation and a content-derived idempotency
  key (routes/forms-public.ts).
- CSP with nonces and `strict-dynamic`, no `unsafe-inline` scripts; CORS is
  an allow-list with credentials, never a wildcard.
- `trustProxy` defaults to loopback-only, so `X-Forwarded-For` from a direct
  connection cannot spoof rate-limit identity (resolveTrustProxy, app.ts).

### Browser → session

- Opaque tokens, SHA-256-hashed at rest; browsers get HttpOnly cookies only
  and never see a token in JSON (`tokenTransport` split, auth/routes.ts).
- Refresh rotation is atomic (`SELECT … FOR UPDATE`), and any reuse of a
  rotated token revokes the whole session family in the same transaction —
  an attacker who wins the race is evicted by the victim's replay
  (auth/service.ts).
- MFA (TOTP) for privileged roles; sessions screen lists and revokes
  devices; sign-out-everywhere exists and works.

### Staff → data (authorisation)

- RBAC is a flat, reviewable permission table with per-role ceilings on
  extra grants (lib/permissions.ts). UI hiding is a courtesy; the API
  re-checks every request.
- Tenant isolation is Postgres row-level security under a least-privilege
  role (`bos_app`); every tenant-scoped query runs inside `withWorkspace`,
  cross-tenant jobs must opt in via `withoutTenantScope`, and the test
  harness refuses superuser connections so RLS tests cannot be vacuous.
- Workspace identity comes from the membership check, never from a
  client-supplied id; a foreign workspace answers 404, not 403.

### Documents (asset #1)

- Private bucket, no public ACL. Uploads are claimed with single-use hashed
  claim tokens; confirmation verifies real size, magic bytes and SHA-256;
  scanning (ClamAV or stub in dev) gates every download to `clean` status.
- Downloads mint short-lived URLs only after an audit row commits
  (audit-before-URL); denials are audited in a separate transaction so a
  rolled-back request still leaves a trace. Retention sweeps expire and
  delete on schedule. See docs/security/document-handling.md for the full
  lifecycle.

### Machine ↔ machine

- Edge Worker → API: shared secret compared in constant time; internal
  routes are never CORS-reachable.
- Meta → webhook: `X-Hub-Signature-256` verified over the raw body with
  `timingSafeEqual`; no secret configured means deliveries are refused, not
  trusted (routes/webhooks-whatsapp.ts).
- Outbound automation webhooks: https-only, HMAC-signed (`x-bos-signature`).
- Google Search Console: read-only scope, service-account JWT minted with
  node:crypto — no long-lived OAuth refresh token to leak.

### AI boundary

- Providers receive page text and return **suggestions**; there is no code
  path from model output to published content. The system prompt forbids
  inventing business facts; the platform's owner-fact policy
  (docs/owner-input-required.md) is the same rule for humans.

## Cross-cutting

- Secrets live in the environment, never the repository; logs redact
  authorization, cookies, tokens and passwords at the logger config level
  (app.ts redact list), so no call site can forget.
- Analytics is first-party and pseudonymous: rotating salted visitor hashes,
  no raw IPs stored, and a deny-list strips PII-shaped keys from event
  properties before they are written (routes/internal.ts).
- Supply chain: pnpm lockfile with frozen installs in CI, Dependabot weekly,
  CodeQL on every push, `pnpm audit` advisory in CI and binding in the
  release gate.

## Accepted risks (known, deliberate)

- CI's smoke stack runs the compiled API with `NODE_ENV=development` because
  the production guard (correctly) refuses to start without real providers;
  the guard itself is unit-tested instead.
- With Turnstile enforced, no-JS visitors cannot submit the form (a CAPTCHA
  requires script); honeypot+timing remain for tenants who choose no
  Turnstile.
- ClamAV catches known malware only; the scanner interface exists so a
  stronger engine can replace it without touching the lifecycle.
- Single-region managed Postgres at launch; the backup/restore procedure
  (docs/operations/backup-restore.md) is the mitigation until the business
  justifies more.
