# NuESheba

The platform's first tenant, and the reason it exists in `configs/` rather than
in application code: **NuESheba is configuration, not a codebase.** Nothing
under `apps/` or `packages/` mentions it. A second client is another directory
here, not a fork.

## What this config controls

| Field                             | Effect                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `businessType: education_service` | Chooses the module preset and the UI vocabulary — leads read as "Enquiries", appointments as "Consultations".                                                       |
| `modules`                         | Added on top of the preset. Documents, WhatsApp and local SEO matter more here than for a generic education service.                                                |
| `nap`                             | The single source of truth for name, address and phone. Feeds the footer, the contact page, `LocalBusiness` JSON-LD and email signatures — so they cannot disagree. |
| `locale`                          | `Asia/Dhaka`, BDT, English with Bangla planned. Appointment times and reminder scheduling read from here.                                                           |

## Site structure

Service pages carry the commercial intent, so each one is a complete answer
rather than a stub that funnels to a contact form:

```
/
├── services/
│   ├── academic-transcript/
│   ├── original-certificate/
│   ├── provisional-certificate/
│   ├── certificate-correction/
│   ├── name-correction/
│   ├── duplicate-certificate/
│   ├── migration-certificate/
│   ├── wes-sealed-envelope/
│   ├── attestation/
│   └── verification/
├── national-university/
│   ├── guides/
│   ├── requirements/
│   ├── notices/
│   └── faq/
├── locations/gazipur/
├── about/
├── contact/
├── blog/
└── service-request/
```

**One location page, not fifty.** NuESheba operates from Gazipur and serves
Bangladesh; generating a page per district would produce near-duplicate pages
with nothing specific to say, which is the pattern search engines treat as
scaled content abuse. `areaServed` in the config carries the coverage claim
instead.

## Service page structure

Every service page follows the same section order, defined in
`docs/architecture/04-seo-and-answer-engines.md`:

```
hero (with a direct answer under the H1)
what the service is  ·  who needs it  ·  requirements
process (with realistic timelines)
pricing policy  ·  common problems  ·  how NuESheba assists
local information  ·  FAQ  ·  related services  ·  CTA
```

The `answer` field on the hero exists so the page opens by answering the
question it targets, before any marketing copy.

## Sensitive documents

Applicants upload transcripts, certificates and national ID scans. These are
`documents`, never `media`: private R2 bucket, short-lived signed URLs, an
audit row written before every URL is issued, and a retention clock. See
`docs/architecture/07-security-and-data-protection.md`.

This is the single most consequential difference between this platform and the
WordPress-plus-plugins alternative, where an uploaded certificate lands in
`/wp-content/uploads/` behind nothing but an unguessable filename.

## Before launch — this config is not production-ready

`telephone`, `whatsapp`, `email` and `streetAddress` are **placeholders**, and
`sameAs` is empty. They are published as the business's NAP in `LocalBusiness`
structured data and in the footer of every page, so shipping them is worse than
shipping no structured data at all: inconsistent NAP data is difficult to
correct once it has propagated to aggregators.

The gate that enforces this:

```bash
pnpm check:readiness nuesheba
```

It exits non-zero while any blocker remains, and it runs in CI. Current
blockers:

| Field               | Why it blocks                                                               |
| ------------------- | --------------------------------------------------------------------------- |
| `nap.telephone`     | Published as the business's phone. Nobody answers `+8801700000000`.         |
| `nap.whatsapp`      | The WhatsApp acknowledgement is sent to this number.                        |
| `nap.email`         | Appears in the footer and receives every lead notification.                 |
| `nap.streetAddress` | "National University Gate" is a landmark, not a deliverable address.        |
| `nap.sameAs`        | An Organization claiming an entity with no corroborating profiles anywhere. |

And worth doing at the same time, though they do not block:

- `nap.latitude` / `nap.longitude`, taken from the Google Business Profile
  listing rather than a geocoder.
- `nap.googleBusinessProfileUrl` — for a local service business, this is most
  of local search visibility.
- `brand.logoUrl`, so the Organization node has a logo and social shares have
  an image.
- `legal.independenceDisclaimer`. NuESheba assists with National University
  documents and is **not affiliated with the university**; saying so plainly in
  the footer protects both the visitor and the site's own trustworthiness. The
  wording is a decision for the business, which is why the platform renders it
  verbatim rather than supplying one.

**None of these may be guessed.** They are facts about a business, and a
plausible-looking invention is worse than an obvious placeholder, because it
will not be caught.
