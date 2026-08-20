# Automation engine

## Events

Modules do not call each other. CRM emits `lead.created`; the automation engine
decides what happens. Adding a reaction never means editing the code that
produced the event.

`@bos/events` holds the canonical catalogue — 38 names across CRM, capture,
scheduling, messaging, commerce, content, SEO, reputation and webhooks.

Three rules:

- Names are `<entity>.<past-tense-verb>` and **never change once shipped**.
- Payloads carry ids plus the few fields a condition might branch on. They are
  not a snapshot of the record — consumers re-read what they need, so an event
  cannot go stale between publish and consume.
- Adding an optional field is compatible. Removing or retyping one is not:
  introduce `<name>.v2`.

Every envelope carries `workspaceId`. Nothing crosses the bus without a tenant,
which is what makes one automation engine safe to run for many businesses.

## The transactional outbox

```
BEGIN
  INSERT INTO leads …
  INSERT INTO event_outbox (name, payload, idempotency_key, …)
COMMIT
                    ↓
        dispatcher polls event_outbox
                    ↓
             Cloudflare Queue
                    ↓
       automation engine + other consumers
```

Publishing to a queue inside a transaction is a distributed-commit problem in
disguise: publish before commit and you announce a lead that rolled back;
publish after and a crash in between loses it silently. The outbox makes the
event and the change atomic and moves the failure somewhere retryable.

The consequence is **at-least-once delivery**, so every consumer must be
idempotent. That is why `idempotency_key` is a required column on the outbox
_and_ on `messages` — the send path is an upsert on it, so a retried step
cannot send a second email.

A partial index (`WHERE status = 'pending'`) keeps the dispatcher's scan small
regardless of how much history accumulates.

## Definitions

An automation is `trigger → [condition] → steps`, stored as validated JSON.
Data rather than code, for two reasons: a non-developer can build one in the
dashboard, and a running instance can be resumed after a deploy. A JavaScript
closure could do neither.

### Triggers

| Kind       | Fires on                                    |
| ---------- | ------------------------------------------- |
| `event`    | A catalogue event                           |
| `schedule` | Cron, in the workspace's time zone          |
| `manual`   | A user action in the dashboard              |
| `webhook`  | An inbound request to a per-automation slug |

### Conditions

A `match` of `all`/`any` over predicates, each a comparator against a dot path
into the run context: `equals`, `contains`, `starts_with`, `greater_than`,
`in`, `is_set`, and their negations.

Evaluation is **pure and synchronous** — no fetching. Branching must be
reproducible from a stored run context when replaying or debugging, which rules
out conditions that go and look things up.

Comparison coerces across string/number, because values arrive from JSON, form
posts and webhooks where `"5"` and `5` routinely mean the same thing. It never
treats null and 0, or empty string and false, as equal.

### Steps

| Type             | Behaviour                                     |
| ---------------- | --------------------------------------------- |
| `action`         | One of 11 actions, with a retry policy        |
| `wait`           | Durable sleep — survives restarts and deploys |
| `wait_for_event` | Waits for a correlated event, with a timeout  |
| `branch`         | Nested `then` / `otherwise`                   |

Actions: `send_email`, `send_sms`, `send_whatsapp`, `create_task`,
`assign_user`, `update_lead`, `add_tag`, `remove_tag`, `call_webhook`,
`generate_ai_content`, `notify_admin`.

`branch` is how "no response after 2 hours?" is expressed — `wait`, then
`wait_for_event` with a timeout, then branch on whether it arrived. No
special-case step type is needed.

## Versioning

Editing an automation creates a new version. **A run pins the version it
started on.**

Sequences run for days. Without this, editing a nurture sequence changes what a
customer receives halfway through it, in a way nobody observes and nobody can
reconstruct afterwards. `automation_runs.automation_version_id` uses
`ON DELETE RESTRICT`: a version cannot be deleted while a run still references
it.

## Run state

`automation_runs` holds status, context, and either `resume_at` (sleeping) or
`waiting_for_event` (blocked). Two partial indexes serve the scheduler's hot
paths and stay small as completed runs accumulate.

`automation_run_steps` records every attempt, with output merged back into the
run context. A failed step is visible with its reason and attempt count rather
than inferred from a gap.

### Re-entry

`once_per_entity` (default), `once_per_contact`, or `always`, enforced by a
partial unique index on `dedupe_key`. A duplicate form submission must not
enrol the same lead twice.

## Where runs execute

Durable, multi-step, long-waiting execution is what Cloudflare Workflows is
built for — persistence between steps, retries, sleeps and waiting on external
events, all surviving restarts. That is the intended home for run execution
(TASK-503).

The engine is designed so that placement is swappable: definitions,
conditions and step semantics live in `@bos/automation` with no runtime
dependency, and the first implementation is a database-backed scheduler polling
`resume_at`. If Workflows turns out to be the wrong fit, the executor moves and
the definitions do not.

## Worked example

```
lead.created
  └── condition: event.payload.serviceSlug = "academic-transcript"
        ├── send_whatsapp   acknowledgement template
        ├── send_email      what to expect, documents needed
        ├── assign_user     round-robin among consultants
        ├── wait            2 hours
        ├── wait_for_event  lead.stage_changed, timeout 2h
        └── branch (timed out)
              ├── send_whatsapp  follow-up
              ├── wait           24 hours
              └── create_task    "Call this applicant" · due tomorrow
```

Every step is idempotent on the run's key, so a retried dispatch re-runs the
step without sending a second WhatsApp message.

## Failure handling

| Failure                     | Response                                                   |
| --------------------------- | ---------------------------------------------------------- |
| Action throws               | Retry with backoff, up to `maxAttempts`                    |
| Retries exhausted           | Run marked `failed` with the reason; admin notified        |
| Queue message fails         | Individually retried, then dead-lettered — never dropped   |
| Run exceeds `maxRunSeconds` | Failed and reported, so a stuck run is visible             |
| Definition invalid          | Rejected at save time by the Zod schema, never at run time |

Queue messages are acknowledged individually rather than per batch: one
poisoned message must not force 24 healthy ones to be redelivered, and a
redelivered message that already sent an email is the exact failure the
idempotency keys exist to prevent.
