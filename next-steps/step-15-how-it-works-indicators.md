# Step 15: How-It-Works — Deterministic vs AI Indicators

> **AGENT INSTRUCTIONS:** You are implementing step 15.
> Work in `/root/projects/hospital-bill-checker`. Steps 00–14 must be complete.
> Read `next-steps/README.md` for full project context.

**Goal:** Update `/how-it-works` page to add visible UI badges showing which steps are deterministic
(SQL rule lookup) vs AI-assisted (LLM). Keep the page's existing step-by-step structure.

**Files to modify:**
- `src/routes/how-it-works/+page.svelte` — add badges and update step descriptions

---

## Task 1: Define badge styles

- [ ] Open `src/routes/how-it-works/+page.svelte`
- [ ] Add CSS classes in the `<style>` block (or in the global styles if using app.css):

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 9999px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  white-space: nowrap;
  margin-left: 8px;
  vertical-align: middle;
}

.badge-deterministic {
  background: #d1fae5;
  color: #065f46;
  border: 1px solid #6ee7b7;
}

.badge-ai {
  background: #ede9fe;
  color: #4c1d95;
  border: 1px solid #c4b5fd;
}

.badge-deterministic::before {
  content: "⚡";
  font-size: 10px;
}

.badge-ai::before {
  content: "✦";
  font-size: 10px;
}
```

---

## Task 2: Update step headers with badges

Find each numbered step in the page and add the appropriate badge:

- [ ] **Step 1 — Upload:** No badge (user action)

- [ ] **Step 2 — Vision extraction:** Add AI badge

Change:
```html
<h2>Gemini Vision reads the bill</h2>
```
To:
```html
<h2>Gemini Vision reads the bill <span class="badge badge-ai">AI</span></h2>
```

- [ ] **Step 3 — Classification (new):** Add as new step between extraction and rule checks.
  Insert after step 2:

```html
<section class="section">
  <div class="step-header">
    <span class="step-num">3</span>
    <h2>Bill type is classified <span class="badge badge-ai">AI</span></h2>
  </div>
  <p>After extraction, a second AI call classifies the bill as one of four types:</p>
  <ul>
    <li><strong>Practitioner</strong> — physician/professional services (CMS-1500)</li>
    <li><strong>Outpatient Hospital</strong> — hospital departments (UB-04)</li>
    <li><strong>DME Supplier</strong> — durable medical equipment</li>
    <li><strong>Inpatient</strong> — hospital admission with DRG</li>
  </ul>
  <p>The bill type determines which CMS fee schedules and coding rules apply. A practitioner bill is checked against MPFS; an outpatient facility bill is checked against OPPS; a DME bill uses the DMEPOS fee schedule.</p>
</section>
```

- [ ] **Step 3 (now Step 4) — CMS rule checks:** Add deterministic badge. Re-number to 4.

```html
<h2>We check against CMS datasets <span class="badge badge-deterministic">Deterministic</span></h2>
```

Update the table section to list all current datasets (not just the original 4):

```html
<div class="data-table">
  <div class="data-row header-row">
    <span>Dataset</span><span>What it is</span><span>Bill types</span>
  </div>
  <div class="data-row">
    <span>NCCI PTP</span>
    <span>Procedure-to-Procedure bundling edits — codes that can't be billed together</span>
    <span>All</span>
  </div>
  <div class="data-row">
    <span>MUE</span>
    <span>Medically Unlikely Edits — maximum units per service</span>
    <span>All</span>
  </div>
  <div class="data-row">
    <span>MPFS</span>
    <span>Medicare Physician Fee Schedule — benchmark rates for physician services</span>
    <span>Practitioner</span>
  </div>
  <div class="data-row">
    <span>OPPS</span>
    <span>Outpatient Prospective Payment System — facility rates for hospital outpatient</span>
    <span>Outpatient</span>
  </div>
  <div class="data-row">
    <span>CLFS</span>
    <span>Clinical Laboratory Fee Schedule — lab test benchmark rates</span>
    <span>All</span>
  </div>
  <div class="data-row">
    <span>ASP</span>
    <span>Average Sales Price — CMS drug payment limits for Part B injectables</span>
    <span>All</span>
  </div>
  <div class="data-row">
    <span>DMEPOS</span>
    <span>DME Fee Schedule — equipment and supply rates by state</span>
    <span>DME</span>
  </div>
  <div class="data-row">
    <span>IPPS/DRG</span>
    <span>Inpatient DRG weights — reference for inpatient admission groupings</span>
    <span>Inpatient</span>
  </div>
  <div class="data-row">
    <span>Hospital MRF</span>
    <span>Hospital's own published prices — compared against billed charges</span>
    <span>All</span>
  </div>
</div>
```

- [ ] **Step 5 — Dispute letter:** Add AI badge.

```html
<h2>We generate a dispute letter <span class="badge badge-ai">AI</span></h2>
```

Update the description:
```html
<p>Once all deterministic checks are complete, the findings are passed to the AI to draft a formal dispute letter. The AI does not invent findings — it only formats the deterministic results into professional language, citing CMS policy references.</p>
```

---

## Task 3: Add a legend at the top of the page

- [ ] After the page subtitle, add a legend explaining the badges:

```html
<div class="badge-legend">
  <p><strong>Key:</strong></p>
  <span class="badge badge-deterministic">Deterministic</span>
  <span style="margin: 0 8px;">= Rule-based lookup from CMS data tables — same result every time, no AI guesswork.</span>
  <br style="margin-bottom: 8px;">
  <span class="badge badge-ai">AI</span>
  <span style="margin: 0 8px;">= Uses Gemini to read or interpret content where structured data alone is insufficient.</span>
</div>
```

Add style:
```css
.badge-legend {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 32px;
  font-size: 14px;
  line-height: 2;
}
```

---

## Task 4: Add data staleness note

- [ ] Near the CMS datasets table, add:

```html
<div class="callout" style="margin-top: 16px;">
  <strong>Data freshness:</strong> CMS data is updated quarterly (NCCI, MUE, ASP, CLFS, OPPS) or annually (MPFS, IPPS, DMEPOS, Ambulance). Data may be up to 30 days stale relative to the CMS publication date. Hospital MRF data is cached locally for up to 7 days.
  See the <a href="/data">data sources page</a> for full refresh schedules.
</div>
```

---

## Task 5: Run dev server and visually verify

- [ ] `npm run dev -- --port 5173`
- [ ] Open `http://localhost:5173/how-it-works`
- [ ] Verify badges appear on each step
- [ ] Verify legend is visible
- [ ] Verify on mobile (resize browser to 375px width)
- [ ] Stop dev server

---

## Task 6: Run check and build

- [ ] `npm run check && npm run build`

---

## Task 7: Commit

```bash
cd /root/projects/hospital-bill-checker
git add src/routes/how-it-works/+page.svelte
git commit -m "feat: add deterministic/ai badges and updated dataset table to how-it-works"
```
