# Security and data protection

## Tenant isolation

Covered in detail in [the database README](../database/README.md). The summary,
and the one thing to carry away:

Every tenant-scoped table has RLS **enabled and forced**. Policies are
discovered by looking for a `workspace_id` column rather than from a list, so a
new table cannot ship without the tenant predicate. Context is set per
transaction with `set_config(..., true)`, so a pooled connection cannot leak
one tenant's context into the next request. With no context set, every row
fails the predicate.

**The application must connect as `bos_app`** — `NOSUPERUSER`, `NOBYPASSRLS`,
no `CREATE`, DML only. RLS does not apply to superusers or `BYPASSRLS` roles,
so a connection string pointing at the wrong role opens every boundary while
the application looks entirely correct. This was caught in development by an
isolation test that passed trivially. `tests/rls.test.ts` now asserts both
directions, so the failure mode is documented in executable form.

`bos.bypass_rls` is a **discipline boundary, not a privilege boundary** — any
role can set a custom GUC. Its job is to make cross-tenant access conspicuous
in review. `withoutTenantScope()` is named to be greppable and belongs only in
the outbox dispatcher, the retention sweeper and migrations.

## Authentication

- Argon2id password hashing.
- Sessions are opaque tokens; only a SHA-256 hash is stored. Refresh rotates
  the token, and `replaced_by_session_id` makes reuse of a retired token
  detectable — the signal that a token has been stolen.
- TOTP MFA, required for `owner` and `admin`.
- Invitations store a token hash with an expiry; the token itself is never
  persisted.
- API keys store a hash plus a display prefix, so a key can be identified in
  the UI without being revealed.
- Failed logins are counted and throttled per account and per IP.

## Sensitive documents

This is the most consequential difference between this platform and the
WordPress-plus-plugins alternative. NuESheba's applicants upload transcripts,
certificates and national ID scans. In a default WordPress setup those land in
`/wp-content/uploads/` protected by nothing but an unguessable filename — which
is not protection, it is obscurity with a directory listing risk attached.

### The upload path

```
browser
  → API authorises the upload and mints a scoped, short-lived signed PUT URL
  → browser uploads directly to the private R2 bucket
  → API records a `documents` row: status = uploaded
  → queue: validate type by sniffing content, check size, scan
  → status = clean | rejected
```

The declared content type is not trusted; the type is sniffed server-side.

### The read path

```
request
  → authorise: workspace, role, and relationship to this document
  → write a document_access_log row  ← before the URL is issued
  → mint a signed GET URL with a short expiry
  → return it
```

The audit row is written **first**. If the audit write fails, the caller does
not get a link. An audit trail that is best-effort is not an audit trail.

### What the schema refuses to allow

- No public URL is ever stored. `documents.object_key` is a key in the private
  bucket, and it never appears in an event payload, a log line or an API
  response.
- The private bucket has no public access, no CDN in front of it, and no
  fallback path that serves from it directly.
- `retain_until` is set at upload from the workspace's policy. A nightly sweep
  deletes the object and marks the row. **Sensitive documents having no expiry
  should be a deliberate decision, not an oversight**, so the column exists and
  the sweeper looks at it.

### Access log

Every issuance, download, deletion and denial: who, when, from where, and the
expiry of the URL issued — so a leaked link can be bounded in time.

## Application security

| Control          | Implementation                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Input validation | Zod at every boundary; nothing untyped reaches a handler                                                                         |
| SQL injection    | Parameterised throughout via Drizzle                                                                                             |
| XSS              | React escapes by default; editor HTML is sanitised on **write**, so there is one definition of "safe" rather than two that drift |
| CSRF             | `SameSite=Lax` cookies, plus origin checks on state-changing routes                                                              |
| Clickjacking     | `X-Frame-Options: DENY` and `frame-ancestors 'none'` — older browsers honour only one                                            |
| Transport        | HSTS with preload                                                                                                                |
| Webhooks         | HMAC-SHA256, compared in constant time                                                                                           |
| Rate limiting    | Redis-backed, per IP and per account                                                                                             |
| Secrets          | Environment only, validated at boot; never committed, never logged                                                               |
| Log redaction    | `authorization`, `cookie`, `*.password`, `*.token` redacted in the logger config rather than at each call site                   |

Timing-safe comparison matters more than it looks: comparing signatures with
`===` leaks the length of the matching prefix, which is enough to forge a
signature byte by byte given enough attempts.

## Data protection

- **Consent is recorded, never assumed.** `contacts.marketing_consent_at` is
  null until someone actually consents.
- **Suppression is keyed on the address, not the contact.** An unsubscribe or
  hard bounce must survive a contact being deleted and re-imported.
- **Export and erasure** are supported per contact, including documents.
- **Retention** is per workspace: analytics events, form submissions and
  documents each have a policy, applied by the nightly sweep.

## Deployment requirements

1. `DATABASE_URL` uses `bos_app`. Migrations use a separate owner-role URL.
2. All secrets from a secret store; `.env` is never committed.
3. TLS everywhere, including database connections in production.
4. The private R2 bucket has no public access policy.
5. `BOS_ALLOW_INDEXING` is unset on every non-production deployment.
6. Backups are encrypted, and restores are **tested** — an untested backup is a
   hypothesis.
