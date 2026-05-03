# Learning Plan 1 — Diagrams to Create

This file specifies the two diagrams that should be created for the `/learn` page (step 16).
The `/learn` page has placeholder `<div>` sections waiting for these diagrams.

Once created, replace the `diagram-placeholder` divs with `<img>` tags pointing to the files.
Store diagram files in `static/diagrams/`.

---

## Diagram 1: Full Process Flow — Start to End

**Purpose:** Show what happens when a patient uploads a bill — every step from upload to dispute letter.

**Target location on `/learn` page:** Section titled "The Full Process" (first diagram section).

**Filename to use:** `static/diagrams/process-flow.svg` (or `.png`)

### What the diagram must show

The flow is a top-to-bottom or left-to-right pipeline with two swim lanes:
- **Left lane: AI steps** (purple, labeled "AI")
- **Right lane: Deterministic steps** (green, labeled "Rule-based")

```
PATIENT UPLOADS BILL (PDF or image)
          │
          ▼
┌─────────────────────────┐
│  VISION EXTRACTION      │  ← AI (Gemini Flash vision)
│  Read bill → extract    │
│  codes, amounts, names  │
└─────────────┬───────────┘
              │
              ▼
┌─────────────────────────┐
│  BILL CLASSIFICATION    │  ← AI (Gemini Flash text)
│  practitioner / outpt   │
│  / dme / inpatient      │
└─────────────┬───────────┘
              │
              ▼
    ┌─────────────────────────────────────────┐
    │  DETERMINISTIC CHECKS (run in parallel)  │  ← All SQL lookups
    │                                          │
    │  ① NCCI — unbundling pairs              │
    │  ② MUE — max units                      │
    │  ③ MPFS — physician rate                │
    │  ④ CLFS — lab test rate                 │
    │  ⑤ ASP — drug price                     │
    │  ⑥ OPPS — outpatient APC rate           │
    │  ⑦ IPPS/DRG — inpatient reference       │
    │  ⑧ DMEPOS — equipment rate              │
    │  ⑨ Ambulance — transport rate           │
    │  ⑩ Hospital MRF — own published price   │
    └─────────────┬───────────────────────────┘
                  │
                  ▼ Findings list (structured data)
┌─────────────────────────┐
│  DISPUTE LETTER         │  ← AI (Claude)
│  Format findings into   │
│  professional letter    │
│  with CMS citations     │
└─────────────┬───────────┘
              │
              ▼
    PATIENT RECEIVES LETTER + FINDINGS
```

**Visual style notes:**
- AI steps: purple background (#ede9fe), purple border (#c4b5fd)
- Deterministic steps: green background (#d1fae5), green border (#6ee7b7)
- Arrows: simple dark gray
- Font: clean sans-serif
- Add small ⚡ icon on deterministic steps and ✦ icon on AI steps
- The deterministic block should look like one wide box (they run together, not sequentially)

---

## Diagram 2: Medicare Rate System — How Rates Are Built

**Purpose:** Show where all the CMS benchmark rates come from and how they relate to each other.
This is the hierarchy of Medicare payment systems.

**Target location on `/learn` page:** Section titled "How Medicare Rates Are Built" (second diagram section).

**Filename to use:** `static/diagrams/medicare-rates.svg` (or `.png`)

### What the diagram must show

A tree/hierarchy showing: the type of service determines which fee schedule applies.

```
                    CMS MEDICARE PAYMENTS
                           │
           ┌───────────────┼───────────────────┐
           │               │                   │
    PART B SERVICES   OUTPATIENT HOSPITAL   INPATIENT HOSPITAL
           │               │                   │
    ┌──────┴──────┐    ┌───┴────────────┐  ┌───┴──────────────┐
    │             │    │                │  │                   │
PHYSICIAN      LAB   APC Rate        IPPS DRG Weights
SERVICES     TESTS  (OPPS)           (fixed per diagnosis)
    │          │       │
   MPFS       CLFS   Grouped by
    │          │     Ambulatory
   RVU × CF  annual  Payment
   = rate   payment  Classification
    │       limit     (APC)
    │
PART B DRUGS
   (ASP+6%)
    │
ASP Fee Schedule
```

**Additional elements to show in the diagram:**

**RVU calculation box** (show this as an inset or callout near MPFS):
```
MPFS Rate = (Work RVU × GPCI_w)
          + (PE RVU × GPCI_pe)
          + (MP RVU × GPCI_mp)
          × Conversion Factor ($33.29)
```
Label this as "How physician rates are calculated"

**Bill type routing arrows** (show which bill type uses which schedule):
- Practitioner bills → MPFS, CLFS, ASP
- Outpatient Hospital bills → OPPS, CLFS, ASP
- DME bills → DMEPOS, CLFS, ASP
- Inpatient bills → IPPS/DRG

**Fee schedules summary table** (small table at the bottom):
| Schedule | Applies to | Updated |
|----------|-----------|---------|
| MPFS | Doctor visits, procedures | Annually |
| CLFS | Lab tests | Annually |
| ASP | Injected drugs | Quarterly |
| OPPS | Hospital outpatient | Annually |
| IPPS | Hospital inpatient | Annually |
| DMEPOS | Equipment | Annually |
| Ambulance | Transport | Annually |

**Visual style notes:**
- Top-level "CMS" node: dark navy (#1e293b)
- Fee schedule nodes: light blue (#eff6ff) with blue border (#93c5fd)
- Bill type labels: gray badges
- Font: clean sans-serif
- Arrows show "which bill type routes to which schedule"
- MPFS RVU formula shown in a small bordered callout box

---

## Implementation: Replacing the Placeholders

Once diagrams are created, in `src/routes/learn/+page.svelte`:

Find:
```html
<div class="diagram-placeholder">
  <p>[Diagram: End-to-end process ...]</p>
  <p class="diagram-note">Diagram will be inserted here (see learning-plan-1.md)</p>
</div>
```

Replace with:
```html
<img
  src="/diagrams/process-flow.svg"
  alt="End-to-end hospital bill checking process flow"
  class="diagram-img"
/>
```

And for the second placeholder:
```html
<img
  src="/diagrams/medicare-rates.svg"
  alt="Medicare rate system hierarchy — how CMS rates are built"
  class="diagram-img"
/>
```

Add to `<style>`:
```css
.diagram-img {
  width: 100%;
  height: auto;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
}
```

---

## Tools for Creating the Diagrams

**Recommended:** Excalidraw (excalidraw.com) — free, exports SVG, supports hand-drawn style.

**Alternative:** draw.io / diagrams.net — more formal, also exports SVG.

**For the RVU formula:** Can be a simple HTML/CSS callout in the SVG using text elements.

**File format:** SVG preferred (scales to any screen size). PNG at 2x resolution (1200px wide)
as fallback if SVG is hard to produce.

---

## After Diagrams Are Added

Remove this file or mark it complete. Update `next-steps/README.md` to note that diagram
assets are in `static/diagrams/`.
