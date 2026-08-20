# NuESheba V1

The first tenant, concretely. Everything here is `configs/nuesheba/` plus
content rows — no application code names this business.

## Configuration

```jsonc
{
  "slug": "nuesheba",
  "businessType": "education_service",
  "siteUrl": "https://nuesheba.com",
  "nap": { "addressLocality": "Gazipur", "addressCountry": "BD", … },
  "locale": { "defaultLocale": "en", "supportedLocales": ["en", "bn-BD"],
              "timeZone": "Asia/Dhaka", "currency": "BDT" },
  "modules": ["ops.documents", "comms.whatsapp", "reputation.local_seo"]
}
```

The `education_service` preset supplies CRM, content, SEO, services,
scheduling, email, tasks and analytics. The three additions above reflect what
matters more here than for a generic education business: applicants upload
documents, WhatsApp is the primary channel in Bangladesh, and local presence at
the National University gate is a real differentiator.

Vocabulary follows from the preset — leads read as **Enquiries**, appointments
as **Consultations**.

## Site structure

```
/
├── services/
│   ├── academic-transcript/          ├── duplicate-certificate/
│   ├── original-certificate/         ├── migration-certificate/
│   ├── provisional-certificate/      ├── wes-sealed-envelope/
│   ├── certificate-correction/       ├── attestation/
│   ├── name-correction/              └── verification/
├── national-university/
│   ├── guides/  ├── requirements/  ├── notices/  └── faq/
├── locations/gazipur/
├── about/  ├── contact/  ├── blog/  └── service-request/
```

**One location page.** NuESheba operates from Gazipur and serves Bangladesh.
Generating a page per district would produce near-duplicate pages with nothing
specific to say — the pattern search engines treat as scaled content abuse.
`areaServed: ["Bangladesh"]` carries the coverage claim instead.

## Service page structure

Every service page follows the answer-first order from
[04 — SEO](04-seo-and-answer-engines.md). The hero's `answer` field opens the
page by answering its target question:

> **Academic Transcript Assistance**
> A National University academic transcript is usually issued in 15-20 working
> days once your application and fees are accepted.

Then: what it is · who needs it · requirements · process with realistic
durations · timeline and pricing policy · common problems · how NuESheba helps ·
local information · FAQ · related services · CTA.

This structure serves a person in a hurry first. That it also suits featured
snippets, voice results and AI retrieval is a consequence, not the goal — and
there is no markup that would substitute for it.

## Entity graph

```
NuESheba (Organization)  ──location──→  Gazipur (LocalBusiness)
    ├── offers ──→ Academic Transcript Assistance (Service)
    ├── offers ──→ Certificate Attestation (Service)
    ├── offers ──→ … 8 more
    ├── areaServed ──→ Bangladesh (Place)
    ├── employee ──→ consultants (Person)
    └── sameAs ──→ social profiles, Google Business Profile
```

`about: National University Bangladesh` links guides and notices to the
institution they concern, so the topical relationship is explicit rather than
inferred from keyword repetition.

## Lead flow

```
visitor lands on /services/academic-transcript
   → "Get assistance"
   → form: name · phone · WhatsApp · service · degree · passing year
            · registration number · notes · document upload (optional)
   → contact created or matched on E.164 phone
   → lead created, with this enquiry's attribution copied onto it
   → lead.created
        ├── WhatsApp acknowledgement
        ├── email: what happens next, documents needed
        ├── assigned to a consultant
        ├── wait 2h → no stage change? → follow-up
        └── wait 24h → still nothing? → task: "Call this applicant"
   → consultation booked
   → customer
```

Contacts dedupe on E.164 phone, because in this market the phone number is the
identity and the same person will submit two forms with two spellings of their
name.

## Document handling

Applicants upload transcripts, certificates and national ID scans. These are
`documents`, not `media`:

- Private R2 bucket, no public access, no CDN in front.
- Signed URLs with a short expiry, issued per authorised request.
- An audit row written **before** each URL is issued.
- Content type sniffed server-side; the declared type is not trusted.
- `retain_until` set from the workspace policy, swept nightly.

This is the single most consequential difference from the
WordPress-plus-plugins alternative, where the same certificate would sit in
`/wp-content/uploads/` behind an unguessable filename and nothing else.

## Local SEO

NAP lives in one place — the config — and feeds the footer, the contact page,
the location page, `LocalBusiness` JSON-LD and email signatures. They cannot
disagree, because there is nowhere for them to disagree.

**The placeholder phone, WhatsApp and email in `configs/nuesheba/business.json`
must be replaced with real, verified values before the site is indexable.**
Inconsistent NAP data is difficult to correct once it has propagated to
aggregators. `sameAs` and the Business Profile URL should be filled at the same
time.

## Delivery order

| Phase | What NuESheba gets                                  |
| ----- | --------------------------------------------------- |
| 1     | Platform foundation — done and verified end to end  |
| 2     | CMS, renderer, SEO engine, sitemaps, indexing       |
| 3     | This config, the 10 service pages, forms, branding  |
| 4     | CRM: enquiries, pipeline, tasks, timeline           |
| 5     | Automations: WhatsApp and email sequences           |
| 6     | Analytics, Search Console, conversion attribution   |
| 7     | SEO audits, content suggestions, AI visibility      |
| 8     | Extract the second tenant, prove the platform claim |

Phase 8 is where the architecture is actually tested. Until a second business
runs on this codebase with nothing but a config change, "reusable" is a claim,
not a fact.
