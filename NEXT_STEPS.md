# Hospital Bill Checker — Next Steps
_Last updated: 2026-03-31_

---

## 1. Production Smoke Test

The app now builds cleanly with `adapter-node`, so the highest-priority work is deployment validation rather than setup.

### What to verify after deploy
1. Upload a real PDF and a scanned image bill through the public site.
2. Confirm `/api/parse`, `/api/audit`, `/api/stats`, and `/api/live-users` behave correctly in production.
3. Confirm `data/stats.json` is writable in the runtime environment.
4. Verify the new homepage/results/contact flows:
   - Homepage feature cards render correctly
   - “Notice something wrong?” CTA links to `/contact-us`
   - Missing-codes anchor scrolls to the note below Billing Line Items
   - Share and dispute-letter icon buttons work on mobile and desktop

---

## 2. Run a Real-Bill Validation Pass

The biggest remaining product risk is audit quality on real hospital bills.

### Suggested pass
- Test the known sample PDFs in `examples/test-images/`
- Record extraction quality, missed codes, and noisy findings
- Check whether the dispute letter cites the right codes and dollar amounts
- Pay special attention to:
  - scanned/image-heavy bills
  - UB-04 style facility bills
  - repeated or ambiguous codes
  - false positives on Medicare-rate comparisons

Document the results in a fresh `examples/test-results-<date>.md`.

---

## 3. Clean Up Runtime/Data Artifacts

There are still a few cleanup items worth doing before broader launch.

- [ ] Decide whether `data/stats.json` should remain committed or move to ignored runtime state only
- [ ] Remove or repurpose `data/savings.json` if it is no longer used
- [ ] Remove `@sveltejs/adapter-auto` from `package.json` if `adapter-node` is the permanent deployment target
- [ ] Review copy for stale references to “share link” or the old feedback card layout in docs

---

## 4. SEO / Marketing Readiness

The product UX is in much better shape, but discoverability is still thin.

- [ ] Add richer OG metadata and a real social preview image
- [ ] Add `sitemap.xml`
- [ ] Add canonical tags for public pages
- [ ] Consider a small “example findings” or “sample bill” section for trust/SEO

---

## 5. Highest-Value Product Feature

The current homepage already points to the next major feature:

- [ ] Add hospital price transparency comparisons

Practical scope:
- ingest published hospital machine-readable price files or negotiated-rate summaries
- compare flagged charges against both Medicare benchmarks and hospital-published rates
- show whether a charge is high relative to Medicare, the hospital’s own price list, or both

This is the clearest next feature because it strengthens the pricing argument without changing the core flow.

---

## 6. Strong Follow-On Features

After hospital price data, the best follow-on options are:

- [ ] Insurance/EOB support to compare billed charges against payer adjudication details
- [ ] Manual line-item entry fallback when extraction fails
- [ ] Better dispute-letter export formats, especially polished PDF output
- [ ] More facility-level billing support such as revenue-code-aware review

---

## 7. Ongoing Quality Work

The app is functional; now the leverage is in reducing false positives and improving trust.

- [ ] Tune prompts using real-bill failures and missed-code reports from `/contact-us`
- [ ] Expand example coverage and keep a small regression set of representative bills
- [ ] Review analytics to see where users drop off: upload, processing, results, contact page
- [ ] Revisit wording around “potential overcharge” if users interpret it too definitively

---

## Current Commands

```bash
cd /root/projects/hospital-bill-checker
npm run check
npm run build
npm run dev -- --port 5173
```

Env file: `/root/projects/hospital-bill-checker/.env`
