# Phase 5 — Automation

Five tasks. This is where the platform stops being a nicer CMS and starts
saving people time.

---

## TASK-501 — Event outbox and dispatcher

**Depends on** 402 · **Estimate** 3 days

Write events to `event_outbox` inside the business transaction. A dispatcher
that polls, publishes to the Cloudflare Queue, and marks rows dispatched with
backoff and a dead-letter path.

**Acceptance**

- An event is never published for a transaction that rolled back, and never
  lost for one that committed — proven by a test that fails the transaction
  after the outbox insert.
- The dispatcher is idempotent; running two instances does not double-publish.
- Outbox lag is a metric with an alert. A stalled dispatcher is the failure
  most likely to go unnoticed.
- Dead-lettered messages are inspectable and replayable from the dashboard.

---

## TASK-502 — Email provider adapter and sending

**Depends on** 401 · **Estimate** 4 days

An `EmailProvider` interface with Resend, SMTP and SES implementations.
Template rendering against a whitelisted context. Suppression checks before
every send. Delivery webhooks into `message_events`.

**Acceptance**

- Switching provider is an environment change; no calling code moves.
- A suppressed address is never sent to, whatever the caller asks for.
- The same `idempotency_key` sends exactly once, verified under concurrent
  retries.
- Template rendering cannot reach outside its context — no arbitrary property
  access, no template injection.
- Bounces and complaints add to suppression automatically.

---

## TASK-503 — Automation engine

**Depends on** 501, 502 · **Estimate** 8 days

Execute definitions: trigger matching, condition evaluation, all four step
types, retries, durable waits, `wait_for_event` with correlation and timeout,
and re-entry enforcement.

Start with a database-backed scheduler polling `resume_at`. Move execution to
Cloudflare Workflows once the semantics are settled — the definitions carry no
runtime dependency, so this is a swap rather than a rewrite.

**Acceptance**

- A run survives a deploy mid-`wait` and resumes correctly.
- Editing an automation does not change what an in-flight run does.
- Every action is idempotent on the run key; a retried step does not send twice.
- `wait_for_event` correlates on the right entity and honours its timeout.
- Re-entry policy is enforced by the database, not by application checks.
- A run exceeding `maxRunSeconds` fails visibly rather than hanging.

---

## TASK-504 — Automation builder UI

**Depends on** 503, 107 · **Estimate** 6 days

Visual trigger/condition/action builder. Step configuration forms generated
from action schemas. Run history with per-step status. Test-run against a
sample entity.

**Acceptance**

- A non-developer can build the NuESheba lead sequence without help.
- Invalid definitions cannot be saved.
- Run history shows each step's status, output and failure reason.
- A test run does not send real messages.
- Editing a live automation warns that in-flight runs keep the old version.

---

## TASK-505 — WhatsApp channel

**Depends on** 502 · **Estimate** 4 days

WhatsApp Business API adapter. Template management and approval status.
Inbound reply capture into the timeline. Session-window handling.

**Acceptance**

- Only approved templates are sent outside a session window, because the
  platform blocks it rather than the provider rejecting it.
- Replies land on the contact's timeline and emit `whatsapp.replied`.
- Delivery status updates `messages`.
- Opt-out is honoured across channels via the shared suppression list.
