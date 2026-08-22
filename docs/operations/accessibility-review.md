# Accessibility review

Two layers, honestly separated: what automation proves on every commit, and
what only a person with assistive technology can prove. Automation is a
floor, not a certificate.

## Automated, binding in CI (state: ✅ passing)

- **axe-core via Playwright** (`e2e/a11y.spec.ts`) against the running
  site and dashboard, desktop and mobile viewports: zero serious/critical
  violations is a hard failure.
- **Keyboard paths**: the public enquiry flow and the dashboard sign-in
  are driven entirely by keyboard in the e2e suite — focus visible, no
  traps, `aria-current` on active navigation.
- **Lighthouse accessibility ≥ 95** on the built site in CI, binding.
- Structural conventions enforced by the components themselves: one `h1`
  per page, labels tied to inputs (`visually-hidden` where the design
  hides them), tables with captions and header scopes, disclosure widgets
  as native `<details>`, status messages with `role="status"`/`alert`,
  and no-JS fallbacks for the public forms.

## Manual checklist (state: ⏳ NOT YET PERFORMED — pre-launch task)

To be executed by a person before DNS cutover, on staging, and recorded
here with date, tester, tools and findings:

- [ ] **Screen reader pass** — NVDA (Windows/Firefox) and VoiceOver
      (macOS/Safari or iOS): sign-in with MFA, the enquiry form end to
      end, the leads board, publishing a page, recording a payment.
- [ ] **Keyboard-only session** covering every dashboard module screen —
      no mouse, no trap, every action reachable.
- [ ] **200% zoom / 320px reflow**: no loss of content or function.
- [ ] **Colour and contrast spot-check** of the tenant's real brand
      palette (the fixture palette passes; the owner's palette must be
      re-checked when it arrives).
- [ ] **Bangla content** read with a screen reader that supports `bn` —
      `lang` attributes switch correctly on `bn-BD` pages.
- [ ] Forms: error announcement on submit, labels read with their
      inputs, honeypot invisible to AT users.

**Record of executions:** none yet. This checklist is a launch-gate item
in `docs/deployment/go-live.md`; the automated layer passing is not a
substitute, and this file must not claim otherwise.
