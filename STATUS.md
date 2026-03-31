# Hospital Bill Checker — Project Status
_Last updated: 2026-03-31_

---

## DONE

### Core Pipeline
- [x] PDF/image upload → parse → audit → results flow
- [x] Text PDF path via `pdf-parse`
- [x] Vision PDF/image path via Gemini Vision (`gemini-2.5-flash`)
- [x] Audit path via Gemini (`gemini-2.5-pro`) with MPFS/NCCI/ASP reference data
- [x] Downloadable audit report
- [x] Magic-bytes file validation on `/api/parse` (PDF/JPEG/PNG/WebP)
- [x] IP-based rate limiting on `/api/audit`

### Architecture
- [x] Child-process isolation for crash-prone or external-service work
- [x] Explicit env passing into child processes for Gemini access
- [x] `adapter-node` is installed and active in `svelte.config.js`

### Results Experience
- [x] Results summary strip with counts and potential overcharge
- [x] Line item cards with expand/collapse details
- [x] Price comparison row on supported finding types
- [x] AAPC lookup link on every CPT code
- [x] Standard code descriptions and confidence labels in findings
- [x] Dispute letter preview with markdown-table rendering
- [x] Copy/download/email flows for dispute letters
- [x] Icon-based email launch buttons in the dispute letter
- [x] Share section redesigned as a quote-style bubble with icon actions
- [x] Missing-codes anchor link beside Billing Line Items
- [x] Missing-codes note moved directly below the line items list

### Homepage / Content
- [x] Homepage upload flow and results flow live on `/`
- [x] Homepage feature roadmap section with current-feature cards
- [x] Prominent “Learn more about how it works” link from the homepage feature section
- [x] “Coming next” section trimmed to hospital price list / facility rate comparisons
- [x] `/how-it-works` page restored to the step-by-step transparency layout
- [x] `/how-it-works` expanded with additional external references (CMS, AMA, HHS, CFR)
- [x] `/privacy` page
- [x] `/stats` page

### Feedback / Contact
- [x] Results page and homepage now use a plain CTA: “Notice something wrong?”
- [x] New `/contact-us` page for full issue reporting
- [x] `FeedbackForm` supports both CTA mode and full form mode
- [x] Formspree-backed report form with optional rating and email

### Live Stats & Analytics
- [x] File-backed stats in `data/stats.json`
- [x] Heartbeat-based live users count
- [x] Live banner preloaded server-side
- [x] `/api/stats`, `/api/stats/heartbeat`, `/api/live-users`
- [x] GA4 pageview + product event tracking
- [x] Tracking for letter actions, share actions, CPT lookups, and audit events

### Validation
- [x] `npm run check` passes cleanly
- [x] `npm run build` passes cleanly

---

## CURRENT PUBLIC SURFACES

- `/` — upload, processing, results, homepage feature roadmap
- `/how-it-works` — step-by-step methodology and references
- `/contact-us` — issue reporting / missed-code reporting
- `/stats` — live stats dashboard
- `/privacy` — privacy policy

---

## KNOWN ISSUES / LIMITATIONS

- GA4 live users count has intentional cache lag
- Audit quality still needs more production testing against real hospital bills
- `data/stats.json` is runtime state and `data/savings.json` still exists as older leftover data
- Hospital facility price transparency data is not integrated yet; current pricing benchmarks are Medicare-based
- Findings are still advisory only, not definitive billing determinations

---

## ENVIRONMENT VARIABLES

```bash
GEMINI_API_KEY=...
GA_MEASUREMENT_ID=G-GMWL0YK5SJ
GA_PROPERTY_ID=530375710
GOOGLE_APPLICATION_CREDENTIALS=/root/.secrets/ccd-ga4-hospital-bill-reader-key.json
```

For Railway-style deployment, the GA service account can also be passed inline as `GA_SERVICE_ACCOUNT_KEY`.

---

## FILE MAP

```text
src/lib/server/
  pdf.ts                  — parse orchestration (text + vision paths)
  vision-extract.mjs      — child process: Gemini Vision extraction
  claude.ts               — audit orchestration
  claude-worker.mjs       — child process: Gemini audit call
  stats.ts                — file-backed stats + heartbeat state
  ga4-realtime.ts         — GA4 realtime wrapper

src/lib/components/
  ResultsSummary.svelte   — top-level results stats
  LineItemCard.svelte     — line-item review UI
  DisputeLetter.svelte    — letter preview + copy/download/email actions
  ShareButton.svelte      — quote-style share UI
  FeedbackForm.svelte     — CTA mode + full report form mode
  FeatureRoadmap.svelte   — homepage feature cards / future feature callout
  MissingCodesNote.svelte — results explanation for omitted revenue/internal codes
  LiveBanner.svelte       — fixed live-stats banner

src/routes/
  +page.svelte            — homepage + upload + results
  how-it-works/+page.svelte
  contact-us/+page.svelte
  privacy/+page.svelte
  stats/+page.svelte
  api/parse/+server.ts
  api/audit/+server.ts
  api/stats/+server.ts
  api/stats/heartbeat/+server.ts
  api/live-users/+server.ts

data/
  stats.json              — runtime stats
  stats.json.example      — seed/example stats file
  savings.json            — older leftover runtime artifact
```
