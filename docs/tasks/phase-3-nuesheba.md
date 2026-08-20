# Phase 3 — NuESheba

Where the platform becomes a live business. Three tasks — small, because if
this phase is large the platform is not reusable.

---

## TASK-301 — Config, branding, navigation

**Depends on** 206 · **Estimate** 2 days

Finalise `configs/nuesheba/business.json` with **real, verified** contact
details. Brand tokens from the visual identity. Navigation menus. Provision the
workspace.

**Acceptance**

- Phone, WhatsApp and email are the real values — the placeholders currently in
  the config are a launch blocker.
- `sameAs` lists the real social profiles and the Google Business Profile URL.
- NAP is identical in the footer, contact page, location page and
  `LocalBusiness` JSON-LD, because all four read from the config.
- `pnpm --filter @bos/business-types test` passes.

---

## TASK-302 — Service pages and guides

**Depends on** 205, 301 · **Estimate** 6 days

Ten service pages in the answer-first structure. National University guides,
requirements and FAQ. Location page for Gazipur. About and contact.

**Acceptance**

- Every service page opens with a direct answer above any marketing copy.
- Process steps carry realistic durations; pricing states a real policy,
  including "on request" where that is the truth.
- FAQ items are questions people actually ask, sourced from enquiries and
  Search Console — not invented to fill a schema slot.
- Each service links to related services and to the guides that explain it.
- **No mass-generated location pages.** One Gazipur page.
- Lighthouse ≥ 95 performance and ≥ 95 accessibility on a service page.

---

## TASK-303 — Service request form and document upload

**Depends on** 209, 404 · **Estimate** 4 days

The service request form: name, phone, WhatsApp, service, degree, passing year,
registration number, notes, optional document upload.

**Acceptance**

- Submitting creates a contact (deduped on E.164 phone) and a lead with this
  enquiry's attribution copied onto it.
- Uploaded documents land in the private bucket and are never publicly
  reachable — verified by attempting direct access.
- The form works on a low-end Android device over a slow connection, which is
  the realistic case.
- Bangla input is accepted and stored correctly.
- The applicant receives an acknowledgement with a reference and what happens
  next.
