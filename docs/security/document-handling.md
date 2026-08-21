# Private document handling

NuESheba receives transcripts, certificates and national-ID scans from the
public service-request form. This document is the contract for how those bytes
are treated. The implementation lives in `apps/api/src/routes/documents.ts`,
`apps/api/src/providers/scanner.ts` and `apps/api/src/lib/file-signatures.ts`;
the lifecycle tests in `apps/api/tests/documents.test.ts` hold it to this.

## The lifecycle

```
visitor asks to upload      →  pending_upload   claim token issued, once
browser PUTs to R2             (direct; the API process never holds the file)
visitor confirms            →  verification     real size, magic bytes, SHA-256
                                 mismatch       →  rejected, object deleted
                            →  malware scan
                                 clean          →  clean
                                 infected       →  rejected, object deleted
                                 scanner error  →  scanning (retried nightly)
form submission             →  attach — by claim token, spent on use
staff download              →  clean only, denial and issuance both logged
retention sweep             →  expired, object deleted before the row says so
```

## Invariants

- **The private bucket has no public read**, and no code path produces a
  permanent URL for an object in it. Reading one takes an authorised request
  that mints a signed URL valid for minutes.
- **Possession of the claim token — not knowledge of a document id — is what
  attaches an upload to a submission.** The token is returned exactly once by
  the upload authorisation; the database holds only its hash; attachment
  spends it.
- **The uploader's declarations are claims; the stored object is the fact.**
  Real size, leading bytes and checksum are read back from storage at confirm
  time. A `.exe` wearing `application/pdf` is rejected with the detected type
  recorded, and the object deleted.
- **No download before a clean verdict.** `scanning` is not clean. A denied
  attempt is logged (`denied`), and a granted one writes its audit row
  _before_ the URL is generated — an access that cannot be recorded does not
  happen. `documents.download` is a separate permission from
  `documents.read`; staff see that a transcript exists without being able to
  open it until someone grants the second permission.
- **A scanner error is not a verdict.** The document stays `scanning`,
  downloadable by no one, and the nightly job retries it.
- **SVG is not a document type here.** It can carry script, and nothing about
  "upload your transcript" needs one.

## Scanner providers

`DOCUMENT_SCANNER` selects the implementation:

| Value    | Behaviour                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clamav` | clamd over TCP (`INSTREAM`), host/port/timeout from `CLAMAV_*`. The VPS deployment runs `clamav-daemon` beside the API.                                                                  |
| `stub`   | Flags the EICAR test string, passes everything else. Tests and local development; the API refuses to start with it in production.                                                        |
| `none`   | No scan. Verification still runs; the document records `not_scanned` rather than pretending. Warned at boot, and a production deployment with storage configured treats it as a blocker. |

## Abuse bounds on the public upload path

- 20 upload authorisations per address per hour.
- 40 confirms per address per hour.
- 500 documents per workspace per day — a botnet cannot turn the form into
  free bulk storage twenty megabytes at a time.
- 15 MB per object, with the size signed into the upload URL so the storage
  layer rejects anything larger regardless of what the API believed.
- An authorisation nobody completes expires in 24 hours and is swept.

## Retention

| State             | Kept for                                                              |
| ----------------- | --------------------------------------------------------------------- |
| `pending_upload`  | 24 hours                                                              |
| `rejected`        | 7 days (row only; the object is already gone)                         |
| `clean`, attached | 1 year default, pending a per-workspace policy                        |
| deletion request  | `DELETE /v1/documents/:id` — object first, then the row, both audited |

The sweep deletes the object before marking the row: a crash between the two
leaves a row claiming a document exists — which a person can investigate —
never a row claiming it is gone while the file remains readable.

## Verified by

`apps/api/tests/documents.test.ts`, running as the RLS-bound application
role: claim-token issuance and spending, executable-as-PDF rejection with
object deletion, size mismatch, infected verdict, scanner-error gating,
cross-submission theft of an attached document, download gating and both
audit rows, permission separation, and the retention sweep. The suite also
caught the sweep reading zero rows under RLS — the reason it now runs
`withoutTenantScope` like every other cross-tenant job.
