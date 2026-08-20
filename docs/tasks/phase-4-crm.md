# Phase 4 — CRM

Four tasks. TASK-404 is the security-critical one.

---

## TASK-401 — Contacts and companies

**Depends on** 105 · **Estimate** 4 days

Contact CRUD with deduplication on E.164 phone and lowercased email. Custom
fields per workspace. Merge, preserving both histories. Activity timeline.
Import and export.

**Acceptance**

- Two submissions from the same phone number produce one contact and two leads.
- Merging preserves every activity, lead, message and document from both.
- The timeline renders a contact's full history in one query.
- Export includes everything held about a person, for data-subject requests.
- Consent state is never inferred; unset means unset.

---

## TASK-402 — Leads, pipeline, tasks, timeline

**Depends on** 401 · **Estimate** 6 days

Lead CRUD with source and attribution. Configurable pipelines and stages. Drag
to change stage. Assignment. Tasks with due dates. Notes and tags. Filtering
and saved views.

**Acceptance**

- Stages are workspace-configurable without a migration.
- Changing stage emits `lead.stage_changed` and appends to the timeline.
- Conversion rate per stage is computed from `stage_changed_at`, so it reflects
  actual movement rather than current state.
- Overdue tasks emit `task.overdue` exactly once.
- A 10,000-lead workspace lists and filters in under 300 ms.

---

## TASK-403 — Lead capture from forms

**Depends on** 402, 209 · **Estimate** 2 days

Wire form submissions to contact and lead creation with attribution, in one
transaction, emitting `form.submitted` and `lead.created` through the outbox.

**Acceptance**

- Contact, lead, submission and both events commit atomically — a failure
  leaves none of them.
- Attribution is copied onto the lead and does not change when the contact
  returns later.
- A duplicate submission within the dedupe window does not create a second lead.
- The form's configured pipeline, stage and service are applied.

---

## TASK-404 — Private document store

**Depends on** 401 · **Estimate** 5 days

The upload and read paths from
[07 — Security](../architecture/07-security-and-data-protection.md). Signed
PUT and GET URLs, server-side type sniffing, virus scanning, audit logging,
retention sweep, and the dashboard viewer.

**Acceptance**

- No code path returns a permanent URL to a private object — verified by a test
  that greps the response of every documents endpoint.
- A `document_access_log` row is written **before** a signed URL is returned;
  if the audit write fails, no URL is issued, and a test proves it.
- Signed URLs expire within 5 minutes and are single-purpose.
- The declared content type is ignored; a `.pdf` that is actually an executable
  is rejected.
- `retain_until` is set at upload, and the nightly sweep deletes both the object
  and marks the row.
- Direct access to the private bucket without a signature returns 403 —
  confirmed against the live bucket, not assumed from configuration.
- Downloading another workspace's document is impossible under RLS, with a test.
