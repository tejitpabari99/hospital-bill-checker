# Fix 05: Frontend and UI Fixes

> **AGENT INSTRUCTIONS:** You are implementing fix 05.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Fix five user-facing bugs across three pages: a garbled paragraph on the how-it-works page, inverted step numbers on the learn page, a false subtitle and hardcoded counts on the data page, a broken GFE input that silently sends NaN to the server, and a missing prerender declaration.

---

## Background

Five issues were found across the frontend:

- **F1 (CRITICAL):** `src/routes/how-it-works/+page.svelte` line 138 contains a garbled, nonsensical paragraph that appears to be two drafts accidentally merged. It ships to users on a medical application and will undermine trust.
- **F2 (IMPORTANT):** `src/routes/learn/+page.svelte` AI step numbering is inverted: check `11` = Classification, check `12` = Vision Extraction. But the actual pipeline runs Vision Extraction first (step 2) then Classification (step 3). The numbers shown to users do not match the real pipeline order.
- **F3 (IMPORTANT):** `src/routes/data/+page.svelte` subtitle says "All rates come directly from CMS — no third-party data is used" which is false (Hospital MRF data comes from Trilliant, a third-party aggregator). Also, the counts "4 updated quarterly" and "6 updated annually" are hardcoded and will silently drift.
- **F4 (IMPORTANT):** `src/routes/+page.svelte` — the GFE (Good Faith Estimate) input: `Number('$1,200.00')` returns `NaN`. This passes the `trim()` non-empty check, gets serialized as `NaN`, and the server returns a generic 400 error with no useful message.
- **F8 (MINOR):** `src/routes/how-it-works/+page.ts` is missing (`prerender = true`), making the how-it-works page inconsistent with the learn and data pages which are both pre-rendered.

---

## Task 1: Fix F1 — Replace garbled paragraph on how-it-works page

**File:** `src/routes/how-it-works/+page.svelte`

Find this exact paragraph (around line 138):

```html
    <p>Two error types require AI is not how the current audit pipeline works: billing findings are deterministic. Unbundling is detected by CMS NCCI rule lookup, drug checks use the 931-entry ASP dataset, and we prefer the Medicare NCCI file and fall back to the Medicaid Practitioner Services edition when needed.</p>
```

Replace with a clear, accurate paragraph:

```html
    <p>All billing error findings are deterministic — AI is not involved in any audit decision. Unbundling is detected by CMS NCCI lookup, drug overcharges use the CMS ASP dataset, and unit limits use CMS MUE edits. We use the Medicare NCCI PTP file and fall back to the Medicaid Practitioner Services edition for bill types not covered by Medicare NCCI. AI is used only for three mechanical tasks: reading bill images (Vision Extraction), classifying bill type, and formatting the dispute letter.</p>
```

---

## Task 2: Fix F2 — Correct the inverted step numbers on the learn page

**File:** `src/routes/learn/+page.svelte`

The pipeline order is: step 1 = PDF Upload, ... step 2 = Vision Extraction, step 3 = Classification, ... The checks array in this file currently has:

```javascript
    {
      id: 'classification',
      num: '11',
      title: 'Bill Type Classification',
      tag: 'AI',
      ...
    },
    {
      id: 'vision',
      num: '12',
      title: 'Vision Extraction',
      tag: 'AI',
      ...
    },
```

Swap the `num` values so Vision Extraction (which runs first in the pipeline) has the lower number:

```javascript
    {
      id: 'classification',
      num: '12',
      title: 'Bill Type Classification',
      tag: 'AI',
      ...
    },
    {
      id: 'vision',
      num: '11',
      title: 'Vision Extraction',
      tag: 'AI',
      ...
    },
```

Also swap the order of the two objects in the `checks` array so they appear in pipeline order (Vision first, then Classification):

```javascript
    // Move the vision block BEFORE the classification block
    {
      id: 'vision',
      num: '11',
      title: 'Vision Extraction',
      tag: 'AI',
      simple: `We use Google's Gemini AI to read your bill image or PDF...`,
      detailed: `...`,
    },
    {
      id: 'classification',
      num: '12',
      title: 'Bill Type Classification',
      tag: 'AI',
      simple: `Before we run any of the checks above...`,
      detailed: `...`,
    },
```

Keep all other content of each object identical — only swap the `num` values and reorder the two objects.

---

## Task 3: Fix F3 — Fix false subtitle and hardcoded counts on data page

**File:** `src/routes/data/+page.svelte`

**Part A — Fix false subtitle:**

Find (around line 171):

```html
    <p class="subtitle">Every dataset the app uses to check your bill. All rates come directly from CMS — no third-party data is used for pricing benchmarks.</p>
```

Replace with an accurate subtitle:

```html
    <p class="subtitle">Every dataset the app uses to check your bill. CMS rate schedules are used for all billing benchmarks. Hospital price data is sourced via Trilliant Health / Oria (a CMS-registered aggregator) and cached locally.</p>
```

**Part B — Fix hardcoded counts:**

Find these three hardcoded summary cards (around lines 179-186):

```html
    <div class="summary-card">
      <span class="summary-num">4</span>
      <span class="summary-label">Updated quarterly</span>
    </div>
    <div class="summary-card">
      <span class="summary-num">6</span>
      <span class="summary-label">Updated annually</span>
    </div>
```

Replace with derived counts. First, confirm how the `sources` array is defined in the `<script>` section — each source object should have an `updateFrequency` or `frequency` field. If it does not, add one.

Look for the `sources` array in the `<script>` block of `src/routes/data/+page.svelte`. Each source entry should have something like `{ id: '...', name: '...', frequency: 'quarterly' | 'annual' | ... }`.

If the sources already have a frequency field, replace the hardcoded numbers with derived values:

```svelte
<script lang="ts">
  // Add these derived counts near the existing sources array:
  $: quarterlyCount = sources.filter(s => s.frequency === 'quarterly').length
  $: annualCount = sources.filter(s => s.frequency === 'annual' || s.frequency === 'annually').length
</script>
```

Then in the template, replace:

```html
    <div class="summary-card">
      <span class="summary-num">4</span>
      <span class="summary-label">Updated quarterly</span>
    </div>
    <div class="summary-card">
      <span class="summary-num">6</span>
      <span class="summary-label">Updated annually</span>
    </div>
```

with:

```html
    <div class="summary-card">
      <span class="summary-num">{quarterlyCount}</span>
      <span class="summary-label">Updated quarterly</span>
    </div>
    <div class="summary-card">
      <span class="summary-num">{annualCount}</span>
      <span class="summary-label">Updated annually</span>
    </div>
```

If the sources array does NOT have a frequency field yet, add `frequency: 'quarterly'` or `frequency: 'annual'` to each entry based on the actual CMS update schedule:
- Quarterly: NCCI, MUE, ASP, CLFS, OPPS
- Annual: MPFS, IPPS, DMEPOS, Ambulance, Hospital Directory

---

## Task 4: Fix F4 — Validate GFE input before sending to server

**File:** `src/routes/+page.svelte`

Find the code near line 162 that reads the GFE input:

```javascript
goodFaithEstimate: goodFaithEstimate.trim() ? Number(goodFaithEstimate) : undefined,
```

`Number('$1,200.00')` returns `NaN`. The server validator (`sanitizeMoney`) checks `typeof value !== 'number' || !Number.isFinite(value)` and throws a 400, but the user gets a generic error message.

Replace the GFE handling with:

```javascript
// Strip currency symbols and commas before parsing GFE input
const gfeTrimmed = goodFaithEstimate.trim()
let parsedGfe: number | undefined = undefined
if (gfeTrimmed) {
  const cleaned = gfeTrimmed.replace(/[$,\s]/g, '')
  const num = Number(cleaned)
  if (!Number.isFinite(num) || num < 0) {
    // Show an inline error to the user rather than sending NaN to the server
    gfeError = 'Please enter a valid dollar amount (e.g. 1200 or $1,200.00)'
    return  // stop form submission
  }
  parsedGfe = num
}
```

And in the `auditBody` object, change:

```javascript
goodFaithEstimate: goodFaithEstimate.trim() ? Number(goodFaithEstimate) : undefined,
```

to:

```javascript
goodFaithEstimate: parsedGfe,
```

You also need to add a `gfeError` reactive variable and display it in the template. Find the GFE input element and add an error display below it:

```svelte
<script lang="ts">
  let gfeError = ''
  // ... existing variables ...
</script>

<!-- In the template, find the GFE input and add: -->
{#if gfeError}
  <p class="field-error">{gfeError}</p>
{/if}
```

Clear `gfeError` at the start of the submit handler:

```javascript
gfeError = ''
```

---

## Task 5: Fix F8 — Add `+page.ts` with `prerender = true` to how-it-works page

**File:** `src/routes/how-it-works/+page.ts` (CREATE this file)

The `learn` and `data` pages both have `+page.ts` files with `prerender = true`. The `how-it-works` page is missing this file.

Create `src/routes/how-it-works/+page.ts`:

```typescript
export const prerender = true
```

Verify the learn and data pages have this too by checking:
- `src/routes/learn/+page.ts` — should contain `export const prerender = true`
- `src/routes/data/+page.ts` — should contain `export const prerender = true`

---

## Verification

- [ ] Visit `/how-it-works` — the garbled paragraph is gone; the replacement reads clearly
- [ ] Visit `/learn` — Vision Extraction shows as step 11, Classification shows as step 12
- [ ] Visit `/data` — subtitle no longer says "no third-party data"; quarterly/annual counts match actual source list
- [ ] On the main page, entering `$1,200.00` in the GFE field shows a clear inline error rather than a server 400
- [ ] Entering `1200` in the GFE field works correctly
- [ ] `npm run check` passes
- [ ] `npm run build` succeeds (prerender of how-it-works is included in build output)

---

## Commit

```bash
git add src/routes/how-it-works/+page.svelte src/routes/how-it-works/+page.ts src/routes/learn/+page.svelte src/routes/data/+page.svelte src/routes/+page.svelte
git commit -m "fix: ui — garbled how-it-works paragraph, learn step numbering, data page subtitle, GFE input validation, add prerender to how-it-works"
```
