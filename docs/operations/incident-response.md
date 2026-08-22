# Incident response

Who does what when something is on fire. Written for a team of one to three
people — no bridge calls, no pager rotations, just an order of operations
that holds when adrenaline is high.

## Severity

| Level | Meaning                                                         | Examples                                                               | Response            |
| ----- | --------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------- |
| SEV-1 | Personal data at risk, or the business cannot receive enquiries | Document bucket exposure, credential leak, site down in business hours | Drop everything now |
| SEV-2 | A core flow degraded with a workaround                          | Confirmations queued but not sending, dashboard down, scans failing    | Same working day    |
| SEV-3 | Annoyance, no data risk                                         | A failing automation, stale analytics, one broken page                 | Next working day    |

## The order of operations, always

1. **Stabilise** — stop the bleeding before diagnosing. Disable the feature
   (automation off, form disabled, DNS to the old site), revoke the
   credential, or take the API down; a closed shop is better than a leaking
   one for SEV-1.
2. **Preserve** — copy the relevant logs and `audit_log` rows out NOW.
   Restarts and retention will eat evidence.
3. **Diagnose and fix** — the runbook has the mechanics per scenario.
4. **Communicate** — see below.
5. **Write it down** — a post-incident note in the repo: what happened, when,
   what limited it, what changes. One page, honest, no blame.

## Playbook: leaked credential (API key, DB password, edge secret)

1. Rotate at the provider immediately; deploy the new value.
2. `EDGE_SHARED_SECRET`: rotate in both the Worker and the API in one deploy
   window; the cron tolerates a missed run.
3. Session secret compromise: rotating `AUTH_SESSION_SECRET` plus deleting
   Redis access tokens signs everyone out; refresh reuse detection evicts
   anything replayed.
4. Search `audit_log` and provider dashboards for use of the old credential
   during the exposure window; treat any hit as a possible SEV-1 breach.

## Playbook: suspected document exposure (SEV-1)

1. Stabilise: revoke the R2 API token serving signed URLs (kills every
   outstanding URL), disable document download permission grants.
2. Preserve: export `document_access_log` — every mint and every denial is
   in it, with actor and timestamp; that log is the difference between
   "maybe everything" and a named list.
3. Establish scope from the log, not from imagination.
4. If real people's documents were accessed by the wrong party: the owner
   informs them plainly and promptly, and checks whether Bangladesh's data
   protection rules and any university agreements require notification.
   Deleting the evidence is never a response.

## Playbook: malicious or compromised staff account

1. Dashboard → members: demote/remove; sessions screen: revoke all their
   sessions (or sign-out-everywhere as them via support procedure).
2. `audit_log` filtered by the user id reconstructs what they touched.
3. Rotate anything they could read (edge secret, provider keys) —
   permissions said what they _should_ reach, the audit says what they did.

## Communication

- Enquirers are customers of a service business, not users of software:
  if enquiries were lost, the honest move is calling/WhatsApping the
  affected people, which the CRM's data makes possible.
- The status answer during SEV-1/2 is the owner's WhatsApp/phone line, which
  runs independently of this platform.

## After every SEV-1/2

- The post-incident note lands in `docs/operations/incidents/` within a
  week, and at least one preventing change (test, guard, alert, runbook
  step) merges with it. An incident that changes nothing will repeat.
