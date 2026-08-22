# Backup and restore (operations index)

The full procedure — what is backed up, where, how to restore each store,
verification steps — lives in
[`docs/deployment/backup-and-restore.md`](../deployment/backup-and-restore.md)
and is maintained there. This page is the _operational_ half: the drill and
its record. A backup nobody has restored from is a hypothesis.

## The drill (monthly, ~30 minutes)

1. Take the latest production Postgres backup and restore it into a
   scratch database (never over production).
2. `pnpm run db:migrate` against the restored copy (must be a no-op or apply
   cleanly).
3. Point a locally-run API at it and walk the smoke test
   (`pnpm smoke … --submit-form`).
4. Spot-check one private document: metadata row present, R2 object
   retrievable via a freshly minted URL, access logged.
5. Record the drill below. Time it — the number is your real RPO/RTO, not
   the one on the label.

## Drill record

| Date       | Backup taken | Restore ok | Smoke ok | Minutes | By  | Notes                                                                                  |
| ---------- | ------------ | ---------- | -------- | ------- | --- | -------------------------------------------------------------------------------------- |
| _none yet_ | —            | —          | —        | —       | —   | First drill is a go-live checklist item (owner-gated: needs production infrastructure) |
