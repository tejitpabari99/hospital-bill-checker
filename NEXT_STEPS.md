# Hospital Bill Checker — Next Steps
_Last updated: 2026-03-30_

---

## 1. Deploy to Production (Highest Priority)

The app is fully functional locally and via ngrok. It needs a real server deployment.

### What to do
1. **Install node adapter**
   ```bash
   npm install @sveltejs/adapter-node
   ```
   Edit `svelte.config.js` — change:
   ```js
   import adapter from '@sveltejs/adapter-auto'
   ```
   to:
   ```js
   import adapter from '@sveltejs/adapter-node'
   ```

2. **Deploy to Railway** (recommended — free tier, persistent filesystem)
   - Go to railway.app → New Project → Deploy from GitHub repo
   - Set environment variables in Railway dashboard:
     ```
     GEMINI_API_KEY=<your key>
     GA_MEASUREMENT_ID=G-GMWL0YK5SJ
     GA_PROPERTY_ID=530375710
     GA_SERVICE_ACCOUNT_KEY=<paste the entire contents of ~/.secrets/ccd-ga4-hospital-bill-reader-key.json as a single-line JSON string>
     ```
   - Note: use `GA_SERVICE_ACCOUNT_KEY` (inline JSON), not `GOOGLE_APPLICATION_CREDENTIALS` (file path won't work on Railway). The code in `ga4-realtime.ts` already handles both — it checks `GA_SERVICE_ACCOUNT_KEY` first.
   - Ensure `data/` directory is writable (Railway persistent volumes or just Railway's ephemeral disk — stats will reset on redeploy, which is acceptable for now)

3. **Add domain** — after first deploy, connect `hospitalbillchecker.com` (or whatever domain) in Railway settings

4. **Verify `data/stats.json` path** — currently `process.cwd() + '/data/stats.json'`. On Railway this will be `/app/data/stats.json`. Make sure the `data/` folder is committed (it is, with the initial `stats.json`).

---

## 2. Test Real Hospital PDFs in Production

Once deployed, run all baseline PDFs through the live Gemini pipeline and document results.

PDFs to test (in `examples/` folder or download from links in `examples/test-images-links.md`):
- `HCA-hospital-bill.pdf` — verify Revenue Code sanitization (`070486` → `70486`)
- `Riverside-bill.pdf` — verify `potentialOvercharge` is non-zero
- `VCU-bill.pdf` — first full end-to-end run
- `Sentara-bill.pdf` — first full end-to-end run
- `medical-bill-ocr-sample.pdf` — scanned bill
- `medical-bill-generated.pdf` — investigate repeated `12345` codes

Document findings in `examples/test-results-<date>.md`.

---

## 3. SEO & Discoverability

The app has no SEO. Do this before any public sharing.

- Add `<svelte:head>` meta tags to `+page.svelte`:
  ```html
  <title>Hospital Bill Checker — Free AI-Powered Bill Audit</title>
  <meta name="description" content="Upload your hospital bill and our AI finds overcharges, duplicate codes, and billing errors in seconds. Free, no login required." />
  <meta property="og:title" content="Hospital Bill Checker" />
  <meta property="og:description" content="..." />
  <meta property="og:image" content="/og-image.png" />
  ```
- Create `/static/og-image.png` (1200×630px) — a simple branded card
- Add `/static/sitemap.xml` with the 4 public routes (`/`, `/how-it-works`, `/stats`, `/privacy`)
- Add `<link rel="canonical">` tags

---

## 4. Minor Code Cleanup

Small items that are quick to fix:

- [ ] **Remove `pdf-extract.mjs`** — text extraction via pdfjs child process is no longer used. Dead code.
- [ ] **Add `data/stats.json` to `.gitignore`** — it's runtime state, shouldn't be committed. Add a `data/stats.json.example` with zeroed values instead.
- [ ] **Fix Svelte warning**: `state_referenced_locally` in `+layout.svelte` line 9 — wrap `data.initialStats` in `$derived` instead of reading directly
- [ ] **`savings` API endpoint** — `src/routes/api/savings/+server.ts` still exists as old name. It was renamed to `/api/stats` but the old file may still be there — check and remove if so.

---

## 5. Quality of Results

Once real PDFs are tested:

- [ ] **Tune audit prompt** if findings are too noisy or miss obvious errors — focus on upcoding and unbundling (highest value for patients)
- [ ] **Add confidence score** per finding — ask Gemini to return `"confidence": "high" | "medium" | "low"` and show it in `LineItemCard.svelte`
- [ ] **Improve dispute letter** — review generated letters against real bills. Common issues to watch for:
  - Placeholder values not filled in (e.g., `[PATIENT NAME]` still blank)
  - Wrong dollar amounts cited
  - Generic language not specific to the actual error type found

---

## 6. Next Features (Pick One)

After deployment and testing, here are the highest-value features to add next:

### A. Downloadable dispute letter as PDF
- `jspdf` is already installed
- Generate a formatted PDF with header, patient info, itemized findings table, and signature line
- Add "Download as PDF" button next to the existing "Download .txt" button in `DisputeLetter.svelte`

### B. ICD-10 code input
- Some bills don't include diagnosis codes
- Add an optional text field after upload: "Do you know your diagnosis codes? (optional)"
- Pass these to the audit prompt to improve `icd10_mismatch` detection accuracy

### C. Multiple dispute letter tones
- After audit, let user choose: "Polite inquiry" / "Formal dispute" / "Escalation to billing manager"
- Pass the selected tone to `claude-worker.mjs` prompt

### D. Line item manual entry fallback
- For bills where Vision fails to extract codes, show a simple table where users can type in CPT codes and amounts
- Pass this manual data into the audit pipeline

---

## 7. Bigger Ideas (Future)

- **Hospital overbilling tracker** — aggregate anonymous findings data by hospital name, build a public leaderboard of worst offenders
- **Mobile camera flow** — optimized UX for photographing paper bills on a phone
- **Insurance appeal letters** — expand beyond hospital bills to denied insurance claims
- **Multi-language** — Spanish first
- **Patient advocacy handoff** — after letter generation, show links to CFPB, state insurance commissioner, or patient advocacy orgs
- **CMS data auto-refresh** — cron job quarterly to re-run `scripts/build_*.py`

---

## Current Dev Workflow (for reference)

```bash
# Start local dev
cd /root/projects/hospital-bill-checker
npm run dev -- --port 5173

# Start ngrok tunnel (run in a separate terminal, unset proxy vars first)
env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY -u ALL_PROXY -u all_proxy -u grpc_proxy -u GRPC_PROXY ngrok http 5173

# Kill everything and restart clean
ps aux | grep -E "ngrok|vite|node" | grep -v grep | awk '{print $2}' | xargs -r kill -9

# Build for production
npm run build
```

**Env file location:** `/root/projects/hospital-bill-checker/.env`
**GA service account key:** `~/.secrets/ccd-ga4-hospital-bill-reader-key.json`
**Formspree form ID:** `mvzvkepd` (hardcoded in `FeedbackForm.svelte`)
**GA4 Measurement ID:** `G-GMWL0YK5SJ` | **Property ID:** `530375710`
