# Demo Consultancy (fixture tenant)

A deliberately **fictional** second tenant. Its purpose is TASK-801: proving
the platform carries no NuESheba assumptions — different business type
(`professional_service`), different country (`US`, `+1` phone normalisation,
`USD`, `America/Chicago`), different module set (no WhatsApp, no document
uploads, scheduling on), different vocabulary in the dashboard.

Everything in `business.json` is invented on purpose and safe to be invented:
`example.com` addresses, a `555` phone number, a named-fictional legal
entity. It must never be deployed publicly; it exists so CI validates that a
second directory under `configs/` provisions, builds and navigates correctly
with zero code changes.
