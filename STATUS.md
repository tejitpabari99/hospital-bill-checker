# Hospital Bill Checker — Project Status
_Last updated: 2026-03-30_

---

## DONE

### Core Pipeline
- [x] PDF upload → parse → audit → results UI (all 3 screens)
- [x] Text PDF path: pdf-parse extracts embedded text + CPT codes
- [x] Vision PDF path: Gemini Vision (`gemini-2.5-flash`) reads scanned/image PDFs
- [x] Audit: Gemini (`gemini-2.5-pro`) audits codes against MPFS/NCCI/ASP data
- [x] Results screen: findings, dispute letter with editable placeholders, share link
- [x] Magic bytes file validation on `/api/parse` (PDF/JPEG/PNG/WebP)
- [x] IP-based rate limiting on `/api/audit` (5 req/min per IP)

### Architecture: Child Process Isolation
All three operations that can fatally crash Node.js run in isolated child processes:
```
pdf-extract.mjs    ← pdfjs-dist Worker crash (window.location)
vision-extract.mjs ← Gemini Vision API call
claude-worker.mjs  ← Gemini audit API call
```
Each child: reads JSON from stdin → calls its service → writes `{ text }` or `{ error }` to stdout → exits.
`GEMINI_API_KEY` is explicitly passed via `env:` in spawn options (Vite does not inject .env into child process.env).

### UI / Results
- [x] Price comparison on each line item: shows billed vs. expected for upcoding, unbundling, duplicate, pharmacy_markup, icd10_mismatch
- [x] AAPC lookup link on every CPT code (`https://www.aapc.com/codes/cpt-codes/{code}`)
- [x] Standard code description (`standardDescription`) shown per finding
- [x] Dispute letter: HTML table rendering for markdown tables in preview
- [x] Dispute letter: plain text output for copy/download/email — strips `**bold**`, `_italic_`, `## headings`, converts tables to bullet lists
- [x] Dispute letter: email send buttons (Gmail, Outlook, Yahoo, native mailto)
- [x] ShareButton component

### Live Stats & Analytics
- [x] `data/stats.json` — persistent file-backed stats: `bills_checked`, `errors_found`, `reviews_flagged`, `savings_total`
- [x] In-memory write lock (promise chain) for concurrent file writes
- [x] In-memory session heartbeat map for `users_online` count
- [x] LiveBanner: sticky top bar (`position: fixed; top: 0; z-index: 1000`) showing live stats + blinking dot
- [x] Stats pre-loaded server-side in `+layout.server.ts` — no null flash on page load
- [x] `/api/stats` GET endpoint, `/api/stats/heartbeat` POST endpoint
- [x] GA4 gtag.js added to `app.html` (`G-GMWL0YK5SJ`, `send_page_view: false`)
- [x] `$effect` SPA page_view tracking in `+layout.svelte`
- [x] GA4 Realtime API (`BetaAnalyticsDataClient`) with 60s server-side cache → `/api/live-users`
- [x] Service account key at `~/.secrets/ccd-ga4-hospital-bill-reader-key.json`
- [x] `src/lib/analytics.ts` — full event tracking:
  - `page_view`, `audit_started`, `audit_completed`, `bill_parse_error`
  - `file_selected`, `file_too_large`, `new_bill_started`
  - `line_item_expanded`, `cpt_code_lookup`
  - `dispute_letter_copied`, `dispute_letter_downloaded`, `dispute_letter_emailed`
  - `share_copied`, `share_twitter`

### Pages
- [x] `/` — main upload + results page
- [x] `/how-it-works` — 6-section transparency page (upload, Gemini Vision, CMS datasets, 5 error types, dispute letter, limitations)
- [x] `/stats` — live stats dashboard with 30s polling
- [x] `/privacy` — privacy policy

### Feedback
- [x] `FeedbackForm` component — star rating (optional), email (optional), message; Formspree ID `mvzvkepd`
- [x] Added to home page (no rating) and results section (with rating)
- [x] Styled as polished card with accent bar, success state, full-width submit

### Bug Fixes
- [x] GEMINI_API_KEY not in child process.env (Vite env isolation) — fixed by explicit `env:` in spawn
- [x] Deprecated model names 404 — updated to `gemini-2.5-flash` / `gemini-2.5-pro`
- [x] Backtick template literal parse error in `claude.ts` — escaped to `\`standardDescription\``
- [x] `$env/static/private` doesn't export `env` object — fixed `ga4-realtime.ts` to use `$env/dynamic/private`
- [x] Pharmacy markup showing only ratio — now derives expected price
- [x] Banner null flash on load — fixed with server-side pre-load in `+layout.server.ts`

---

## KNOWN ISSUES / LIMITATIONS

- GA4 live users count has 60s cache lag (quota constraint — 10 req/min free tier)
- `adapter-auto` build warning: no production environment detected. Needs adapter-node for Railway/Render deploy.
- Two minor Svelte warnings (non-breaking): `state_referenced_locally` in layout, a11y label on star rating group

---

## Environment Variables Required
```
GEMINI_API_KEY=...
GA_MEASUREMENT_ID=G-GMWL0YK5SJ
GA_PROPERTY_ID=530375710
GOOGLE_APPLICATION_CREDENTIALS=/root/.secrets/ccd-ga4-hospital-bill-reader-key.json
```

---

## File Map

```
src/lib/server/
  pdf.ts                  — PDF parsing orchestration (text + Vision paths)
  pdf-extract.mjs         — Child process: pdfjs text extraction
  vision-extract.mjs      — Child process: Gemini Vision PDF reading (gemini-2.5-flash)
  claude.ts               — Audit orchestration (builds prompt, spawns worker)
  claude-worker.mjs       — Child process: Gemini audit API call (gemini-2.5-pro)
  stats.ts                — Stats read/write with write lock + session heartbeat
  ga4-realtime.ts         — GA4 Realtime API wrapper with 60s cache

src/lib/
  analytics.ts            — gtag event helpers (all tracked events)

src/lib/components/
  LiveBanner.svelte        — Fixed-top stats bar
  LineItemCard.svelte      — Per-finding card with price comparison + AAPC link
  DisputeLetter.svelte     — Letter preview + copy/download/email actions
  ShareButton.svelte       — Share to Twitter / copy link
  FeedbackForm.svelte      — Formspree feedback card (showRating prop)
  ResultsSummary.svelte    — Summary stats after audit

src/routes/
  +layout.svelte           — SPA page_view tracking, stats heartbeat, LiveBanner
  +layout.server.ts        — Server-side pre-load of stats + GA4 live users
  +page.svelte             — Main page (upload + results)
  how-it-works/+page.svelte
  stats/+page.svelte
  privacy/+page.svelte
  api/parse/+server.ts     — POST /api/parse (magic bytes validation)
  api/audit/+server.ts     — POST /api/audit (rate limiting + stats increment)
  api/stats/+server.ts     — GET /api/stats
  api/stats/heartbeat/+server.ts — POST /api/stats/heartbeat
  api/live-users/+server.ts — GET /api/live-users (GA4 + fallback)

data/
  stats.json               — Runtime stats (bills_checked, errors_found, etc.)
  mpfs.json                — Medicare Physician Fee Schedule rates
  ncci.json                — NCCI bundling rules
  asp.json                 — ASP drug price data
```
