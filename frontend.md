# Hospital Bill Checker — Frontend Redesign Plan

> **How to use this document**: Work through it section by section. Each section tells you exactly which file to edit, what to change, and what the result looks like. No vague instructions. Every color is a hex. Every font size is a pixel value. Every CSS block is copy-paste ready.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Fonts — How to Add Them](#2-fonts--how-to-add-them)
3. [Global CSS — `src/app.css`](#3-global-css--srcappcss)
4. [Layout — `src/routes/+layout.svelte`](#4-layout--srcrouteslayoutsvelte)
5. [LiveBanner — `src/lib/components/LiveBanner.svelte`](#5-livebanner)
6. [Homepage — `src/routes/+page.svelte`](#6-homepage--srcroutespagesvelte)
7. [FeatureRoadmap — Delete It](#7-featureroadmap--delete-it)
8. [ResultsSummary — `src/lib/components/ResultsSummary.svelte`](#8-resultssummary)
9. [LineItemCard — `src/lib/components/LineItemCard.svelte`](#9-lineitemcard)
10. [DisputeLetter — `src/lib/components/DisputeLetter.svelte`](#10-disputeletter)
11. [MissingCodesNote — `src/lib/components/MissingCodesNote.svelte`](#11-missingcodesnote)
12. [FeedbackForm — `src/lib/components/FeedbackForm.svelte`](#12-feedbackform)
13. [ShareButton — `src/lib/components/ShareButton.svelte`](#13-sharebutton)
14. [How It Works page — `src/routes/how-it-works/+page.svelte`](#14-how-it-works-page)
15. [Stats page — `src/routes/stats/+page.svelte`](#15-stats-page)
16. [Privacy page — `src/routes/privacy/+page.svelte`](#16-privacy-page)
17. [Contact Us page — `src/routes/contact-us/+page.svelte`](#17-contact-us-page)
18. [What to Delete](#18-what-to-delete)
19. [What to Add (New Elements)](#19-what-to-add-new-elements)
20. [Mobile Breakpoints Checklist](#20-mobile-breakpoints-checklist)

---

## 1. Design Philosophy

### Direction: "Medical Record" — Clinical Precision Meets Quiet Authority

This tool helps patients fight back against opaque hospital billing. It should feel like the most trustworthy document in the room — not a chatbot wrapper, not a startup landing page, not an AI toy.

**Reference points:**
- Stripe's confidence and precision (systematic color, tight grid, no fluff)
- Linear's intentional negative space and purposeful hierarchy
- The New York Times editorial grid — authoritative, readable, structured
- A well-maintained medical record — cream paper, dark ink, clear hierarchy

**What this is NOT:**
- No gradient blobs
- No "magic" / "AI-powered" language
- No teal pill badges floating over stock-style illustrations
- No rounded-everything, shadow-everything generic SaaS look

### The Visual Language in Five Points

1. **Cream paper base** (`#F5F4F0`) — warm, not cold. Documents, not dashboards.
2. **Forest green accent** (`#2D6A4F`) — authoritative, not startup-teal. This is a medical-legal color.
3. **Serif headlines** (`DM Serif Display`) — a humanist serif that says "document" and "trust." Not a tech font.
4. **Monospace for all data** (`IBM Plex Mono`) — billing codes, dollar amounts, CPT numbers. The data looks like data.
5. **Tight 6px radius** — precise, not bubbly. Cards feel like paper folders, not app cards.

### The One Thing Someone Will Remember

The typography pairing. When a user sees a large DM Serif Display heading alongside IBM Plex Mono billing codes, it reads immediately as: "this is a serious audit tool, not a chatbot."

---

## 2. Fonts — How to Add Them

### Step 1: Edit `src/app.html` (or wherever the `<head>` is in your SvelteKit project)

Add this inside the `<head>` tag, before any CSS:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
  rel="stylesheet"
/>
```

**Why these three fonts:**
- `DM Serif Display` — warm humanist serif. Reads authoritative, not stiff. Used only for the main H1/H2 headings.
- `DM Sans` — the exact designed companion to DM Serif. Highly legible, slightly wide. Used for all body/UI text.
- `IBM Plex Mono` — IBM's professional monospace. The standard for billing/data tools. Used for CPT codes, dollar amounts, letter text.

### Step 2: Verify in `app.css`

The `--font-display`, `--font-sans`, and `--font-mono` variables in the next section reference these fonts. The font loading above makes them available.

---

## 3. Global CSS — `src/app.css`

**Action: Replace the entire file contents with this.**

The current file has 45 lines. Replace all of it.

```css
/* ============================================================
   HOSPITAL BILL CHECKER — Design System
   ============================================================ */

@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

:root {
  /* --- Backgrounds ----------------------------------------- */
  --bg:              #F5F4F0;   /* warm cream paper */
  --bg-card:         #FEFEFE;   /* white card surface */
  --bg-subtle:       #EEECE7;   /* inset sections */
  --bg-ink:          #191918;   /* dark inverted sections */

  /* --- Text ------------------------------------------------- */
  --text-primary:    #111110;   /* warm near-black */
  --text-secondary:  #3D3D3A;   /* secondary prose */
  --text-muted:      #79776F;   /* labels, metadata */
  --text-ghost:      #B8B5AC;   /* placeholders, disabled */
  --text-on-dark:    #F5F4F0;   /* text on dark bg */

  /* --- Borders ---------------------------------------------- */
  --border:          #DDD9D2;   /* default */
  --border-strong:   #B8B4AC;   /* emphasis */
  --border-focus:    #2D6A4F;   /* focus ring */

  /* --- Accent: Forest Green --------------------------------- */
  --accent:          #2D6A4F;
  --accent-hover:    #1E4D38;
  --accent-light:    #EBF5EF;
  --accent-mid:      #4A9970;

  /* --- Status ----------------------------------------------- */
  --error:           #9B2335;
  --error-bg:        #FDF0F1;
  --error-border:    #E8BEC3;
  --warning:         #8B5A00;
  --warning-bg:      #FDF6E3;
  --warning-border:  #E8D5A3;
  --success:         #2D6A4F;
  --success-bg:      #EBF5EF;
  --success-border:  #9ECAB0;

  /* --- Placeholder highlights ------------------------------- */
  --placeholder:        #FEF3C7;
  --placeholder-border: #D97706;

  /* --- Typography ------------------------------------------- */
  --font-display: 'DM Serif Display', Georgia, 'Times New Roman', serif;
  --font-sans:    'DM Sans', system-ui, -apple-system, sans-serif;
  --font-mono:    'IBM Plex Mono', 'Courier New', Courier, monospace;

  /* --- Shape ------------------------------------------------ */
  --radius:     6px;
  --radius-lg:  10px;
  --radius-pill:999px;

  /* --- Shadows ---------------------------------------------- */
  --shadow-sm:  0 1px 2px rgba(17,17,16,0.05);
  --shadow:     0 2px 6px rgba(17,17,16,0.07), 0 1px 2px rgba(17,17,16,0.04);
  --shadow-md:  0 4px 16px rgba(17,17,16,0.09), 0 1px 4px rgba(17,17,16,0.05);
  --shadow-lg:  0 12px 40px rgba(17,17,16,0.12), 0 2px 8px rgba(17,17,16,0.06);

  /* --- Layout ----------------------------------------------- */
  --container:      680px;
  --container-wide: 900px;
}

/* ============================================================
   Reset & Base
   ============================================================ */

*, *::before, *::after {
  box-sizing: border-box;
}

html {
  font-family: var(--font-sans);
  font-size: 16px;
  background: var(--bg);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

body {
  margin: 0;
  min-height: 100vh;
  padding-top: 40px; /* LiveBanner height */
}

/* ============================================================
   Typography
   ============================================================ */

h1, h2, h3 {
  font-family: var(--font-display);
  font-weight: 400; /* DM Serif Display looks best at regular weight */
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

h4, h5, h6 {
  font-family: var(--font-sans);
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-primary);
}

p {
  line-height: 1.65;
  color: var(--text-secondary);
}

code, .mono {
  font-family: var(--font-mono);
}

/* ============================================================
   Cards
   ============================================================ */

.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

/* ============================================================
   Buttons
   ============================================================ */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 9px 18px;
  border-radius: var(--radius);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  border: none;
  text-decoration: none;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease,
              box-shadow 0.12s ease;
  white-space: nowrap;
  letter-spacing: 0.01em;
}

.btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

/* Primary: solid forest green */
.btn-primary {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 1px 3px rgba(45,106,79,0.25), inset 0 1px 0 rgba(255,255,255,0.08);
}
.btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 2px 6px rgba(45,106,79,0.30), inset 0 1px 0 rgba(255,255,255,0.08);
}
.btn-primary:active {
  background: var(--accent-hover);
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.15);
}

/* Secondary: outlined */
.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-strong);
}
.btn-secondary:hover {
  background: var(--bg-subtle);
  border-color: var(--border-strong);
  color: var(--text-primary);
}

/* Ghost: minimal */
.btn-ghost {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid transparent;
  padding: 8px 12px;
}
.btn-ghost:hover {
  background: var(--bg-subtle);
  color: var(--text-primary);
}

button:disabled {
  opacity: 0.38;
  cursor: not-allowed;
  pointer-events: none;
}

/* ============================================================
   Container
   ============================================================ */

.container {
  max-width: var(--container);
  margin: 0 auto;
  padding: 0 24px;
}

.container-wide {
  max-width: var(--container-wide);
  margin: 0 auto;
  padding: 0 24px;
}

/* ============================================================
   Utility
   ============================================================ */

.eyebrow {
  display: inline-block;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
}

.divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 0;
}
```

**Key changes from the old file:**
- `--bg` changed from `#FAFAF9` to `#F5F4F0` (warmer cream)
- `--bg-card` unchanged at `#FEFEFE` (slightly warmer than `#FFFFFF`)
- `--accent` changed from `#0D9488` (teal) to `#2D6A4F` (forest green)
- `--accent-hover` changed from `#0F766E` to `#1E4D38`
- `--font-sans` changed from `'Geist', 'Inter'` to `'DM Sans'`
- `--font-mono` changed from `'Geist Mono', 'JetBrains Mono'` to `'IBM Plex Mono'`
- Added `--font-display: 'DM Serif Display'` — new
- `--radius` stays at `6px` (unchanged — was already tight)
- Button styles now include `inset` shadow on primary for depth
- `h1, h2, h3` now default to `font-family: var(--font-display)` and `font-weight: 400`

---

## 4. Layout — `src/routes/+layout.svelte`

**Action: No structural changes.** The layout is fine. Only the LiveBanner component changes (see Section 5).

The `body { padding-top: 40px }` in app.css accounts for the fixed banner height. This stays.

---

## 5. LiveBanner

**File:** `src/lib/components/LiveBanner.svelte`

**Action: Replace the entire `<style>` block.** The HTML and script are unchanged.

Find and replace the entire `<style>...</style>` block (lines 31–112) with:

```css
<style>
  .notif-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    background: var(--bg-ink);        /* near-black instead of green */
    color: var(--text-on-dark);
    font-family: var(--font-mono);     /* monospace for data density */
    font-size: 12px;
    letter-spacing: 0.02em;
    height: 40px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }

  .notif-inner {
    width: 100%;
    max-width: var(--container-wide, 900px);
    margin: 0 auto;
    padding: 0 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    position: relative;
  }

  .notif-content {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .notif-item {
    display: flex;
    align-items: center;
    gap: 5px;
    color: rgba(245,244,240,0.65);   /* muted, not screaming */
  }

  .notif-item strong {
    color: #F5F4F0;
    font-weight: 600;
  }

  .sep {
    color: rgba(245,244,240,0.2);
    font-size: 10px;
  }

  /* Live dot: small, precise, green */
  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-mid, #4A9970);
    animation: blink 2s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.2; }
  }

  .stats-link {
    color: rgba(245,244,240,0.45);
    font-size: 11px;
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    flex-shrink: 0;
    transition: color 0.15s;
    position: absolute;
    right: 24px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .stats-link:hover {
    color: #F5F4F0;
  }
</style>
```

**Visual change:** Banner goes from `#065F46` (bright CMS green) to `#191918` (near-black). The data text uses IBM Plex Mono. The live dot is a subdued green. The overall effect is a Bloomberg/Linear-style system bar — not a marketing banner.

---

## 6. Homepage — `src/routes/+page.svelte`

This is the most significant change. I will describe the new structure screen by screen, then give you the exact CSS to replace.

### 6A. Upload Screen

**Current structure:**
```
<header> — centered H1 + p + trust badges
<drop-zone card> — dashed border
<file warning>
<format hint>
<Analyze Bill button>
<privacy note>
<FeatureRoadmap /> — DELETE
<FeedbackForm />
```

**New structure:**
```
<header> — left-aligned, serif headline, compact
<drop-zone> — solid border, no dashed, label-based UI
<format hint inline>
<Analyze Bill button> — full-width, larger
<trust row> — inline text with separators, not pill badges
<privacy note>
<FeedbackForm /> — moved here, no more FeatureRoadmap gap
```

#### Step 1: Change the header HTML (lines 168–178)

**Find:**
```html
<header style="text-align: center; margin-bottom: 40px;">
  <h1 style="font-size: 28px; font-weight: 700; margin: 0 0 8px;">Hospital Bill Checker</h1>
  <p style="color: var(--text-muted); margin: 0 0 16px; font-size: 16px;">
    Find errors. Dispute overcharges.
  </p>
  <div class="trust-badges">
    <span class="trust-badge">No login</span>
    <span class="trust-badge">No data stored</span>
    <span class="trust-badge">Privacy first</span>
  </div>
</header>
```

**Replace with:**
```html
<header class="upload-header">
  <h1 class="upload-title">Hospital Bill Checker</h1>
  <p class="upload-subtitle">Upload your itemized bill. We audit every charge against CMS data and write your dispute letter.</p>
</header>
```

#### Step 2: Change the drop zone HTML (lines 186–222)

**Find** the entire `<div class="drop-zone card" ...>` block (lines 186–222) and **replace with:**

```html
<label
  class="drop-zone"
  class:drag-over={dragOver}
  for="file-input"
  role="button"
  tabindex="0"
  aria-label="Drop zone for bill upload"
  ondragover={(e) => { e.preventDefault(); dragOver = true }}
  ondragleave={() => dragOver = false}
  ondrop={handleDrop}
  onkeydown={(e) => e.key === 'Enter' && document.getElementById('file-input')?.click()}
>
  <input
    id="file-input"
    type="file"
    accept=".pdf,.jpg,.jpeg,.png,.webp"
    style="display:none"
    onchange={handleFileInput}
    capture="environment"
  />

  {#if file}
    <div class="file-selected">
      <span class="file-icon-wrap">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </span>
      <div class="file-info">
        <span class="file-name">{file.name}</span>
        <span class="file-size">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
      </div>
      <span class="file-status">Ready</span>
    </div>
  {:else}
    <div class="drop-prompt">
      <span class="drop-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
      </span>
      <p class="drop-primary">Drop your bill here</p>
      <p class="drop-secondary">or click to browse — PDF, JPG, PNG up to 20 MB</p>
    </div>
  {/if}
</label>
```

**Note:** Changed from `<div>` to `<label for="file-input">` — this removes the need for the `onclick` handler on the outer element (the label click naturally triggers the input). Remove the old `onclick={() => document.getElementById('file-input')?.click()}` attribute since the label handles this.

#### Step 3: Change the format hint (line 228–230)

**Find:**
```html
<p style="text-align: center; color: var(--text-muted); font-size: 13px; margin: 8px 0 20px;">
  Works with PDF, JPG, PNG · Max 20MB
</p>
```

**Delete this paragraph entirely.** The format info is now inside the drop zone prompt text.

#### Step 4: Change the Analyze Bill button section (lines 232–241)

**Find:**
```html
<div style="text-align: center; margin-bottom: 24px;">
  <button
    class="btn btn-primary"
    style="font-size: 16px; padding: 12px 32px;"
    disabled={!file}
    onclick={startAudit}
  >
    Analyze Bill
  </button>
</div>
```

**Replace with:**
```html
<button
  class="btn btn-primary upload-cta"
  disabled={!file}
  onclick={startAudit}
>
  Analyze Bill
</button>
```

#### Step 5: Change the privacy note (lines 243–248)

**Find:**
```html
<p class="privacy-note">
  🔒 Your bill is processed and immediately discarded. We store nothing.
  <a href="/privacy" target="_blank" rel="noopener noreferrer" style="color: var(--accent);">Privacy policy</a>
  ·
  <a href="/how-it-works" target="_blank" rel="noopener noreferrer" style="color: var(--accent);">How it works</a>
</p>
```

**Replace with:**
```html
<div class="trust-row">
  <span class="trust-item">No login</span>
  <span class="trust-sep" aria-hidden="true">·</span>
  <span class="trust-item">No data stored</span>
  <span class="trust-sep" aria-hidden="true">·</span>
  <a href="/privacy" class="trust-link">Privacy policy</a>
  <span class="trust-sep" aria-hidden="true">·</span>
  <a href="/how-it-works" class="trust-link">How it works</a>
</div>
```

#### Step 6: Remove FeatureRoadmap (lines 250–252)

**Find and delete:**
```html
<div style="margin-top: 56px;">
  <FeatureRoadmap />
</div>
```

Delete these 3 lines entirely.

Also delete the import at the top of the script block (line 7):
```js
import FeatureRoadmap from '$lib/components/FeatureRoadmap.svelte'
```

#### Step 7: Change the FeedbackForm divider section (lines 254–256)

**Find:**
```html
<div style="margin-top: 28px; padding-top: 28px; border-top: 1px solid var(--border);">
  <FeedbackForm />
</div>
```

**Replace with:**
```html
<div class="feedback-section">
  <FeedbackForm />
</div>
```

### 6B. Processing Screen

**Current HTML** (lines 259–274): Simple centered layout with a card of steps.

**Action: Replace the entire `{:else if screen === 'processing'}` block** with:

```html
{:else if screen === 'processing'}
  <main class="container processing-screen">
    <div class="processing-inner">
      <p class="processing-label eyebrow">Analyzing</p>
      <h2 class="processing-title">Reviewing your bill</h2>
      <p class="processing-sub">Cross-checking each code against CMS data. This takes 20–60 seconds — do not close this tab.</p>

      <div class="steps-list">
        {#each STEPS as step, i}
          <div class="step-row" class:active={i === currentStep} class:done={i < currentStep}>
            <span class="step-indicator" aria-hidden="true">
              {#if i < currentStep}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              {:else if i === currentStep}
                <span class="spinner"></span>
              {:else}
                <span class="step-dot"></span>
              {/if}
            </span>
            <span class="step-label">{step}</span>
          </div>
        {/each}
      </div>
    </div>
  </main>
```

### 6C. Results Screen Header Row

**Current HTML** (lines 282–288):
```html
<div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
  <button class="btn btn-secondary" onclick={reset}>← New bill</button>
  <h2 style="margin:0; font-size:22px; font-weight:600;">Audit Results</h2>
  <div style="margin-left:auto; display:flex; gap:8px; flex-wrap:wrap;">
    <button class="btn btn-secondary" onclick={downloadAuditReport}>Download report</button>
  </div>
</div>
```

**Replace with:**
```html
<div class="results-header">
  <div class="results-header-left">
    <button class="btn btn-ghost results-back-btn" onclick={reset}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      New bill
    </button>
    <h2 class="results-title">Audit Results</h2>
  </div>
  <div class="results-header-actions">
    <button class="btn btn-secondary" onclick={downloadAuditReport}>Download report</button>
  </div>
</div>
```

### 6D. Results Screen — Section headings

**Find** (line 303–305):
```html
<div class="section-heading-row">
  <h3 class="section-heading">Billing Line Items</h3>
  <a class="section-link" href="#missing-codes">Missing codes</a>
</div>
```

No change needed to the HTML. The styling update in the CSS block below handles this.

### 6E. Replace the entire `<style>` block in `+page.svelte`

**Find** the entire `<style>` block (lines 348–516) and **replace with:**

```css
<style>
  /* ── Upload Screen ──────────────────────────────────── */

  .upload-header {
    margin-bottom: 32px;
  }

  .upload-title {
    font-family: var(--font-display);
    font-size: 38px;
    font-weight: 400;
    margin: 0 0 10px;
    line-height: 1.1;
    letter-spacing: -0.02em;
    color: var(--text-primary);
  }

  .upload-subtitle {
    font-size: 16px;
    line-height: 1.6;
    color: var(--text-muted);
    margin: 0;
    max-width: 52ch;
  }

  /* Drop zone — solid border, no dashed */
  .drop-zone {
    display: block;
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-lg);
    padding: 40px 28px;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    margin-bottom: 12px;
    background: var(--bg-card);
    box-shadow: var(--shadow-sm);
  }
  .drop-zone:hover,
  .drop-zone.drag-over {
    border-color: var(--accent);
    background: var(--accent-light);
  }
  .drop-zone:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  /* Drop prompt interior */
  .drop-icon {
    display: inline-flex;
    color: var(--text-muted);
    margin-bottom: 10px;
  }
  .drop-primary {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 500;
    color: var(--text-primary);
  }
  .drop-secondary {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  /* File selected state */
  .file-selected {
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
  }
  .file-icon-wrap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius);
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    color: var(--accent);
    flex-shrink: 0;
  }
  .file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .file-name {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-size {
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .file-status {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--accent-light);
    border: 1px solid var(--success-border);
    border-radius: var(--radius);
    padding: 3px 8px;
    flex-shrink: 0;
  }

  /* Warnings */
  .file-warning {
    color: var(--warning);
    font-size: 13px;
    text-align: left;
    margin: 0 0 8px;
    background: var(--warning-bg);
    border: 1px solid var(--warning-border);
    border-radius: var(--radius);
    padding: 10px 14px;
    line-height: 1.5;
  }

  .error-banner {
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    color: var(--error);
    border-radius: var(--radius);
    padding: 12px 16px;
    font-size: 14px;
    margin-bottom: 16px;
    line-height: 1.5;
  }

  /* CTA button — full-width, substantial */
  .upload-cta {
    width: 100%;
    padding: 14px 24px;
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 14px;
    letter-spacing: 0.01em;
  }

  /* Trust row — inline text, not pill badges */
  .trust-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 0;
  }
  .trust-item {
    color: var(--text-muted);
  }
  .trust-sep {
    color: var(--border-strong);
    font-size: 10px;
  }
  .trust-link {
    color: var(--text-muted);
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 2px;
  }
  .trust-link:hover {
    color: var(--text-primary);
  }

  /* Feedback section */
  .feedback-section {
    margin-top: 40px;
    padding-top: 40px;
    border-top: 1px solid var(--border);
  }

  /* ── Processing Screen ──────────────────────────────── */

  .processing-screen {
    padding-top: 80px;
    padding-bottom: 80px;
  }

  .processing-inner {
    max-width: 420px;
  }

  .processing-label {
    margin: 0 0 8px;
  }

  .processing-title {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 400;
    margin: 0 0 10px;
    color: var(--text-primary);
  }

  .processing-sub {
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0 0 36px;
  }

  /* Steps list */
  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .step-row {
    display: flex;
    align-items: center;
    gap: 14px;
    color: var(--text-ghost);
    font-size: 14px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    transition: color 0.2s;
  }
  .step-row:last-child {
    border-bottom: none;
  }
  .step-row.done {
    color: var(--success);
  }
  .step-row.active {
    color: var(--text-primary);
    font-weight: 500;
  }

  .step-indicator {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: inherit;
  }

  .step-dot {
    display: block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--border-strong);
    margin: 0 auto;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 1.5px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Results Screen ─────────────────────────────────── */

  .results-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }

  .results-header-left {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }

  .results-header-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .results-back-btn {
    gap: 4px;
    padding: 7px 12px;
    font-size: 13px;
  }

  .results-title {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 400;
    margin: 0;
    color: var(--text-primary);
  }

  .results-subtitle {
    color: var(--text-muted);
    font-size: 13px;
    font-family: var(--font-mono);
    margin: 2px 0 0;
    padding-left: 2px;
  }

  .section-heading {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0;
  }

  .section-heading-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 0 0 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }

  .section-link {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .section-link:hover {
    color: var(--text-primary);
  }

  .line-items-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .disclaimer {
    margin-top: 32px;
    font-size: 12px;
    color: var(--text-ghost);
    text-align: center;
    line-height: 1.7;
    max-width: 520px;
    margin-left: auto;
    margin-right: auto;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-subtle);
  }
</style>
```

---

## 7. FeatureRoadmap — Delete It

**File:** `src/lib/components/FeatureRoadmap.svelte`

**Action: Delete the file entirely.**

```bash
rm src/lib/components/FeatureRoadmap.svelte
```

**Also update `src/routes/+page.svelte`:**

1. Remove the import (line 7): `import FeatureRoadmap from '$lib/components/FeatureRoadmap.svelte'`
2. Remove the usage (lines 250–252):
   ```html
   <div style="margin-top: 56px;">
     <FeatureRoadmap />
   </div>
   ```

**What replaces it:** Nothing. The page is better without it. The FeedbackForm that follows provides enough content below the upload zone. Clean negative space is more trustworthy than a "What it does" feature list that reads as AI filler.

---

## 8. ResultsSummary

**File:** `src/lib/components/ResultsSummary.svelte`

**Action: Replace the entire `<style>` block** (lines 32–69) with:

```css
<style>
  .summary-strip {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1px;                    /* gap: 1px with bg creates ruled grid */
    background: var(--border);  /* the gaps show as border lines */
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: 28px;
  }

  @media (max-width: 600px) {
    .summary-strip {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  .stat {
    background: var(--bg-card);
    padding: 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  /* Colored top rule instead of colored text */
  .stat::before {
    content: '';
    display: block;
    height: 3px;
    border-radius: 2px;
    width: 28px;
    margin-bottom: 6px;
    background: var(--border-strong);
  }
  .stat.error::before    { background: var(--error); }
  .stat.warning::before  { background: var(--warning); }
  .stat.overcharge::before { background: var(--text-primary); }
  .stat.clean::before    { background: var(--success); }

  .stat-value {
    font-family: var(--font-mono);
    font-size: 26px;
    font-weight: 600;
    line-height: 1;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }

  .stat-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    line-height: 1.3;
  }

  /* Error count: crimson */
  .stat.error .stat-value    { color: var(--error); }
  /* Warning count: amber */
  .stat.warning .stat-value  { color: var(--warning); }
  /* Dollar amount: primary (no color — let the number speak) */
  .stat.overcharge .stat-value { font-size: 22px; }
  /* Clean count: forest green */
  .stat.clean .stat-value    { color: var(--success); }
</style>
```

**Visual change:** The 4-stat row now uses a "ruled grid" effect (1px gaps with background border color). Each stat has a 3px colored top rule instead of colored numbers. The values are larger, monospaced, more data-dense. Labels are all-caps small-caps — like a Bloomberg terminal or medical chart.

---

## 9. LineItemCard

**File:** `src/lib/components/LineItemCard.svelte`

**Action: Replace the entire `<style>` block** (lines 158–286) with:

```css
<style>
  /* Main container */
  .line-item {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    cursor: pointer;
    transition: border-color 0.12s, box-shadow 0.12s;
    user-select: none;
  }
  .line-item:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-sm);
  }
  .line-item:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  /* Left border stripe for flagged items */
  .line-item.has-finding {
    border-left-width: 3px;
  }
  .line-item.has-finding:has(.badge-error)   { border-left-color: var(--error); }
  .line-item.has-finding:has(.badge-warning) { border-left-color: var(--warning); }

  /* Main row */
  .item-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    gap: 12px;
  }

  .item-left  { display: flex; align-items: flex-start; gap: 10px; flex: 1; min-width: 0; }
  .item-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

  /* Badges */
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    padding: 3px 6px;
    border-radius: 3px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .badge-error   { background: var(--error-bg);   color: var(--error);   border: 1px solid var(--error-border); }
  .badge-warning { background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning-border); }
  .badge-clean   { background: var(--success-bg); color: var(--success); border: 1px solid var(--success-border); }

  /* Info stack */
  .item-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

  .item-code {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    display: flex;
    align-items: baseline;
    gap: 8px;
    letter-spacing: 0.02em;
  }

  .aapc-link {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 400;
    color: var(--text-ghost);
    text-decoration: none;
    letter-spacing: 0;
  }
  .aapc-link:hover { color: var(--accent); text-decoration: underline; }

  .item-desc {
    font-size: 13px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-sans);
  }

  .item-error-type {
    font-size: 10px;
    font-weight: 700;
    color: var(--warning);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    font-family: var(--font-mono);
  }

  .item-confidence {
    display: inline-flex;
    width: fit-content;
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 2px 5px;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .confidence-high   { background: var(--success-bg);  color: var(--success); border: 1px solid var(--success-border); }
  .confidence-medium { background: var(--warning-bg);  color: var(--warning); border: 1px solid var(--warning-border); }
  .confidence-low    { background: var(--error-bg);    color: var(--error);   border: 1px solid var(--error-border); }

  /* Right column */
  .item-amount {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 14px;
    color: var(--text-primary);
    letter-spacing: 0.01em;
  }

  .expand-toggle {
    color: var(--text-ghost);
    font-size: 10px;
    transition: color 0.12s;
  }
  .line-item:hover .expand-toggle { color: var(--text-muted); }

  /* Expanded detail panel */
  .item-detail {
    padding: 14px 16px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-subtle);
    animation: expand 0.12s ease-out;
  }

  @keyframes expand {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .detail-description {
    margin: 0 0 14px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--text-secondary);
  }

  .detail-clean {
    margin: 0;
    font-size: 14px;
    color: var(--success);
    font-weight: 500;
  }

  .detail-meta {
    margin: 8px 0 0;
    font-size: 13px;
    font-family: var(--font-mono);
    color: var(--text-muted);
  }

  /* Price comparison row */
  .price-comparison {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 13px;
    margin-bottom: 14px;
    padding: 10px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--font-mono);
  }
  .pc-billed   { color: var(--text-muted); }
  .pc-arrow    { color: var(--border-strong); }
  .pc-expected { font-weight: 600; color: var(--text-primary); }
  .pc-save     { color: var(--success); font-size: 12px; }
  .pc-zero     { color: var(--text-muted); font-style: italic; font-family: var(--font-sans); }
  .pc-mono     { font-family: var(--font-mono); }

  /* Detail data grid */
  .detail-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 20px;
    font-size: 13px;
    margin-bottom: 14px;
  }
  .detail-label { color: var(--text-muted); font-size: 12px; }
  .detail-value { font-weight: 500; font-family: var(--font-mono); color: var(--text-primary); }
  .text-error   { color: var(--error); }
  .text-warning { color: var(--warning); }

  .code-link {
    font-family: var(--font-mono);
    font-weight: 500;
    color: inherit;
    text-decoration: none;
  }
  .code-link:hover { text-decoration: underline; }

  /* Recommendation box */
  .detail-recommendation {
    font-size: 13px;
    background: var(--accent-light);
    border: 1px solid var(--success-border);
    border-radius: var(--radius);
    padding: 10px 14px;
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .detail-recommendation strong {
    color: var(--accent);
    font-weight: 600;
  }
</style>
```

**Visual changes:**
- Expand animation now includes a slight `translateY(-4px)` slide — more polished
- Badge border added — more defined, less flat
- Monospace used for badge text, error types, codes
- `background: var(--bg-subtle)` on expanded panel instead of `#FAFAFA`
- Recommendation box uses `var(--accent-light)` / `var(--success-border)`

---

## 10. DisputeLetter

**File:** `src/lib/components/DisputeLetter.svelte`

**Action: Replace the entire `<style>` block** (lines 233–379) with:

```css
<style>
  .letter-section {
    margin-top: 0;
  }

  /* Section header */
  .letter-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
    flex-wrap: wrap;
    gap: 10px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }

  /* The h3 title inside letter-header — override global serif */
  .letter-header h3 {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0;
  }

  .letter-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  /* Letter body: document feel */
  .letter-body {
    max-height: 520px;
    overflow-y: auto;
    padding: 28px 32px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-card);
    /* Subtle paper texture via box-shadow */
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), var(--shadow-sm);
  }

  /* Scrollbar styling */
  .letter-body::-webkit-scrollbar {
    width: 6px;
  }
  .letter-body::-webkit-scrollbar-track {
    background: var(--bg-subtle);
  }
  .letter-body::-webkit-scrollbar-thumb {
    background: var(--border-strong);
    border-radius: 3px;
  }

  /* The letter text itself */
  .letter-text {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.8;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
  }

  /* Highlighted placeholders */
  mark.placeholder {
    background: var(--placeholder);
    color: #92400E;
    border: 1px solid var(--placeholder-border);
    border-radius: 2px;
    padding: 0 3px;
    font-weight: 500;
    text-decoration: none;
  }

  .letter-note {
    font-size: 12px;
    color: var(--text-muted);
    margin: 10px 0 0;
    text-align: center;
  }

  /* Table inside letter */
  .table-wrapper {
    overflow-x: auto;
    margin: 10px 0;
  }

  .letter-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-family: var(--font-mono);
  }

  .letter-table th {
    background: var(--bg-subtle);
    padding: 8px 12px;
    text-align: left;
    font-weight: 600;
    border: 1px solid var(--border);
    white-space: nowrap;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .letter-table td {
    padding: 7px 12px;
    border: 1px solid var(--border);
    vertical-align: top;
    font-size: 12px;
  }

  .letter-table tr:nth-child(even) td {
    background: var(--bg-subtle);
  }

  /* Email send section */
  .email-section {
    margin-top: 18px;
    padding-top: 18px;
    border-top: 1px solid var(--border);
  }

  .email-label {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 10px;
  }

  .email-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .email-btn {
    font-size: 13px;
    padding: 8px 14px;
    gap: 8px;
    min-width: 110px;
  }

  .email-icon {
    display: inline-flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .email-icon svg,
  .gmail-icon svg,
  .outlook-icon svg,
  .yahoo-icon svg {
    width: 16px;
    height: 16px;
    display: block;
  }

  .email-note {
    font-size: 11px;
    color: var(--text-ghost);
    margin: 0;
    line-height: 1.5;
  }
</style>
```

**Also update one HTML line in the `<div class="letter-header">` block** (line 143):

**Find:**
```html
<h3 style="margin: 0; font-size: 16px; font-weight: 600;">Dispute Letter</h3>
```

**Replace with:**
```html
<h3>Dispute Letter</h3>
```

(Remove the inline style — the new CSS class `.letter-header h3` handles it.)

**Visual changes:**
- Letter section label is now all-caps small uppercase (document heading style)
- Letter body has custom scrollbar and subtle paper shadow
- Table headers are uppercase labels
- "Send directly" label is uppercase

---

## 11. MissingCodesNote

**File:** `src/lib/components/MissingCodesNote.svelte`

**Action: Replace the entire `<style>` block** (lines 25–65) with:

```css
<style>
  .missing-codes-note {
    padding: 16px 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-subtle);
    box-shadow: none;
  }

  .header {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 10px;
  }

  h3 {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    margin: 0;
  }

  p {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.65;
  }

  p + p {
    margin-top: 6px;
  }
</style>
```

**Also update the `<section>` opening tag** (line 8) to remove the gradient background and card class. Change:

```html
<section {id} class={`missing-codes-note card ${className}`.trim()}>
```

to:

```html
<section {id} class={`missing-codes-note ${className}`.trim()}>
```

**Visual change:** MissingCodesNote becomes a subdued callout box — it's informational context, not a featured card. It sits quietly under the line items.

---

## 12. FeedbackForm

**File:** `src/lib/components/FeedbackForm.svelte`

**Action: Replace the entire `<style>` block** (lines 123–312) with:

```css
<style>
  /* CTA mode (plain inline link) */
  .cta-plain h3 {
    font-family: var(--font-sans);
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 4px;
    color: var(--text-primary);
  }
  .cta-plain p {
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: var(--text-muted);
  }
  .cta-plain a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* Form mode */
  .feedback-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 28px;
    max-width: 520px;
    margin: 0 auto;
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 24px;
  }

  .card-accent-line {
    display: block;
    flex-shrink: 0;
    width: 3px;
    height: 38px;
    background: var(--accent);
    border-radius: 2px;
    margin-top: 3px;
  }

  .feedback-heading {
    font-family: var(--font-sans);
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 3px;
    line-height: 1.2;
  }

  .feedback-subtext {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .feedback-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.01em;
  }
  .optional { font-weight: 400; color: var(--text-ghost); }
  .required { color: var(--error); }

  .field-input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text-primary);
    font-family: var(--font-sans);
    transition: border-color 0.15s, box-shadow 0.15s;
    width: 100%;
  }
  .field-input:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(45,106,79,0.12);
  }
  .field-input::placeholder { color: var(--text-ghost); }
  .field-textarea { resize: vertical; min-height: 96px; }

  /* Star rating */
  .stars { display: flex; gap: 4px; }
  .star-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: 24px;
    color: var(--border-strong);
    line-height: 1;
    transition: color 0.1s, transform 0.1s;
  }
  .star-btn:hover,
  .star-btn.filled {
    color: var(--accent);
  }
  .star-btn:hover { transform: scale(1.12); }

  /* Submit */
  .feedback-submit {
    width: 100%;
    margin-top: 4px;
  }

  .feedback-error {
    color: var(--error);
    font-size: 13px;
    margin: 0;
  }

  /* Success state */
  .success-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 16px 0 8px;
    text-align: center;
    gap: 6px;
  }

  .success-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    background: var(--success-bg);
    border: 1px solid var(--success-border);
    color: var(--success);
    border-radius: 50%;
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .success-text {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    font-family: var(--font-sans);
  }

  .success-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
  }
</style>
```

**Visual changes:**
- Star color changes from teal to forest green
- Background input field uses `var(--bg)` (cream) instead of `var(--bg-main, var(--bg-card))`
- Success icon now uses border instead of background-only circle
- Font sizes and weights brought in line with system

---

## 13. ShareButton

**File:** `src/lib/components/ShareButton.svelte`

**Action: Replace the entire `<style>` block** (lines 75–153) with:

```css
<style>
  .share-section {
    margin-top: 24px;
  }

  .share-kicker {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 12px;
  }

  /* Clean card, no gradient blobs */
  .share-bubble {
    position: relative;
    padding: 20px 22px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: visible;  /* remove the speech-bubble tail */
  }

  /* Remove the old speech-bubble tail pseudo-element */
  .share-bubble::after { display: none; }

  .share-quote-mark {
    font-family: var(--font-display);
    font-size: 56px;
    line-height: 1;
    color: var(--border);
    margin-bottom: -8px;
    user-select: none;
  }

  .share-text {
    margin: 0;
    font-size: 14px;
    line-height: 1.7;
    color: var(--text-secondary);
  }

  .share-actions {
    display: flex;
    gap: 10px;
    margin-top: 18px;
    flex-wrap: wrap;
  }

  .share-action {
    gap: 8px;
    min-width: 116px;
    justify-content: center;
  }

  .action-icon {
    display: inline-flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .action-icon svg {
    width: 16px;
    height: 16px;
    display: block;
  }
</style>
```

**Visual changes:**
- The radial gradient blob background is removed — plain white card
- The speech-bubble pseudo-element `::after` is removed (it looked synthetic)
- The quote mark uses `var(--font-display)` (DM Serif) — it becomes a refined typographic detail
- "Share with others" kicker is now uppercase label style

---

## 14. How It Works Page

**File:** `src/routes/how-it-works/+page.svelte`

**Action: Replace the `<style>` block** (lines 192–328) with:

```css
<style>
  /* Back link */
  .back-link-wrap { margin-bottom: 36px; }
  .back-link-wrap a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: none;
    font-family: var(--font-sans);
  }
  .back-link-wrap a:hover { color: var(--text-primary); }

  /* Page title area */
  h1 {
    font-family: var(--font-display);
    font-size: 36px;
    font-weight: 400;
    margin: 0 0 8px;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }

  .page-subtitle {
    color: var(--text-muted);
    font-size: 15px;
    margin: 0 0 48px;
    line-height: 1.6;
  }

  /* Sections */
  .section {
    margin-bottom: 48px;
    padding-bottom: 48px;
    border-bottom: 1px solid var(--border);
  }
  .section:last-child { border-bottom: none; }

  .step-header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }

  /* Step number bubble */
  .step-num {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--bg-ink);
    color: var(--text-on-dark);
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    flex-shrink: 0;
  }

  h2 {
    font-family: var(--font-sans);
    font-size: 17px;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
  }

  p  { font-size: 15px; line-height: 1.7; color: var(--text-secondary); margin: 0 0 12px; }
  ul { font-size: 15px; line-height: 1.8; color: var(--text-secondary); margin: 0 0 12px; padding-left: 20px; }
  li { margin-bottom: 4px; }

  code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text-primary);
  }

  a { color: var(--accent); }
  a:hover { text-decoration: underline; }

  /* Callout boxes */
  .callout {
    background: var(--accent-light);
    border: 1px solid var(--success-border);
    border-radius: var(--radius);
    padding: 14px 18px;
    font-size: 14px;
    line-height: 1.65;
    margin-top: 14px;
    color: var(--text-secondary);
  }

  .callout-warning {
    background: var(--warning-bg);
    border-color: var(--warning-border);
  }

  /* CMS data table */
  .data-table {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    font-size: 14px;
    margin-top: 16px;
  }

  .data-row {
    display: grid;
    grid-template-columns: 1fr 2fr 2fr;
    border-bottom: 1px solid var(--border);
  }
  .data-row:last-child { border-bottom: none; }

  .data-row > span {
    padding: 12px 16px;
    border-right: 1px solid var(--border);
    line-height: 1.55;
  }
  .data-row > span:last-child { border-right: none; }

  .header-row {
    background: var(--bg-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  small { font-size: 12px; color: var(--text-muted); }

  /* Error types list */
  .error-types { display: flex; flex-direction: column; gap: 18px; margin-top: 16px; }

  .error-type {
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .error-type p { margin: 4px 0 0; font-size: 14px; color: var(--text-muted); }

  .error-tag {
    display: inline-flex;
    align-items: center;
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 3px 7px;
    border-radius: 3px;
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 3px;
  }
  .tag-error   { background: var(--error-bg);   color: var(--error);   border: 1px solid var(--error-border); }
  .tag-warning { background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning-border); }

  .reference-row {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 14px;
  }

  .reference-links { display: flex; gap: 10px; flex-wrap: wrap; }

  @media (max-width: 700px) {
    h1 { font-size: 28px; }

    .data-row {
      grid-template-columns: 1fr;
    }
    .data-row > span {
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
    .data-row > span:last-child { border-bottom: none; }

    .error-type { flex-direction: column; gap: 8px; }
  }
</style>
```

**Also update the inline styles in the HTML:** Replace the `<a href="/">` back link (line 8):

**Find:**
```html
<a href="/" style="display:inline-block; font-size:14px; color:var(--text-muted); text-decoration:none; margin-bottom:32px;">← Back</a>
```

**Replace with:**
```html
<div class="back-link-wrap"><a href="/">← Back</a></div>
```

Replace the `<p style="...">` subtitle (lines 11–13):

**Find:**
```html
<p style="color:var(--text-muted); font-size:14px; margin:0 0 40px;">
  Full transparency on every step — from upload to dispute letter.
</p>
```

**Replace with:**
```html
<p class="page-subtitle">Full transparency on every step — from upload to dispute letter.</p>
```

---

## 15. Stats Page

**File:** `src/routes/stats/+page.svelte`

**Action: Replace the `<style>` block** (lines 99–179) with:

```css
<style>
  /* Page heading */
  h1 {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 400;
    letter-spacing: -0.01em;
  }

  /* Stats grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1px;               /* ruled grid trick */
    background: var(--border);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: 32px;
  }

  @media (max-width: 480px) {
    .stats-grid { grid-template-columns: 1fr; }
  }

  /* Stat cards */
  .stat-card {
    background: var(--bg-card);
    padding: 24px 22px;
    position: relative;
  }

  .stat-card.accent {
    grid-column: span 2;
  }
  @media (max-width: 480px) {
    .stat-card.accent { grid-column: span 1; }
  }

  /* Live indicator */
  .stat-card.live {
    /* Left border stripe */
    box-shadow: inset 4px 0 0 var(--accent);
    padding-left: 20px;
  }

  .stat-header {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 6px;
  }

  .stat-label {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 6px;
    display: block;
  }

  .stat-value {
    font-family: var(--font-mono);
    font-size: 36px;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.02em;
    line-height: 1;
  }

  .stat-note {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  /* Live pulse dot */
  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent-mid, #4A9970);
    animation: pulse 2s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.25; }
  }

  .disclaimer {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    line-height: 1.65;
    max-width: 520px;
    margin: 0 auto;
    padding: 16px;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
</style>
```

**Also update the inline heading styles** (lines 47–54). Replace:

```html
<div style="margin-bottom: 32px;">
  <h1 style="font-size: 24px; font-weight: 700; margin: 0 0 6px;">Live Stats</h1>
  <p style="color: var(--text-muted); font-size: 13px; margin: 0;">
    Updated every 30 seconds
    {#if lastRefreshed > 0}· last refreshed {lastRefreshed}s ago{/if}
  </p>
</div>
```

With:

```html
<div style="margin-bottom: 40px;">
  <h1 style="margin: 0 0 6px;">Live Stats</h1>
  <p style="color: var(--text-muted); font-size: 13px; margin: 0; font-family: var(--font-mono);">
    Updated every 30 seconds{#if lastRefreshed > 0} · {lastRefreshed}s ago{/if}
  </p>
</div>
```

---

## 16. Privacy Page

**File:** `src/routes/privacy/+page.svelte`

**Action: Replace the `<style>` block** (lines 74–134) with:

```css
<style>
  .privacy-page {
    min-height: 100vh;
    background: var(--bg);
    padding: 40px 24px 80px;
  }

  .privacy-container {
    max-width: 640px;
    margin: 0 auto;
  }

  .back-link {
    display: inline-block;
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: none;
    margin-bottom: 36px;
  }
  .back-link:hover { color: var(--text-primary); }

  h1 {
    font-family: var(--font-display);
    font-size: 36px;
    font-weight: 400;
    color: var(--text-primary);
    margin: 0 0 4px;
    letter-spacing: -0.01em;
  }

  .last-updated {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-ghost);
    margin: 0 0 40px;
    letter-spacing: 0.02em;
  }

  h2 {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 36px 0 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  p {
    font-size: 15px;
    color: var(--text-secondary);
    line-height: 1.75;
    margin: 0 0 14px;
  }

  a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  a:hover { opacity: 0.8; }
</style>
```

**Visual changes:**
- H1 becomes DM Serif Display, large and light-weight
- H2 section headers become uppercase small labels with a bottom border (like legal document section headers)
- `last-updated` becomes monospaced, ghost color

---

## 17. Contact Us Page

**File:** `src/routes/contact-us/+page.svelte`

**Action: Replace the `<style>` block** (lines 43–144) with:

```css
<style>
  .contact-page {
    padding-top: 48px;
    padding-bottom: 80px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .back-link {
    display: inline-block;
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: none;
    margin-bottom: 4px;
  }
  .back-link:hover { color: var(--text-primary); }

  .hero {
    padding: 32px;
    border-radius: var(--radius-lg);
    background: var(--bg-card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-sm);
  }

  .eyebrow {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 10px;
    display: block;
  }

  h1 {
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 400;
    margin: 0;
    color: var(--text-primary);
    letter-spacing: -0.01em;
    line-height: 1.15;
  }

  .intro {
    margin: 12px 0 0;
    font-size: 15px;
    line-height: 1.7;
    color: var(--text-muted);
    max-width: 56ch;
  }

  .hero-points {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 18px;
  }

  .hero-points span {
    padding: 5px 10px;
    border-radius: var(--radius);
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .form-wrap {
    max-width: 680px;
  }

  .secondary {
    padding: 24px 28px;
    border-radius: var(--radius-lg);
    background: var(--bg-card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-sm);
  }

  .secondary h2 {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  .secondary ul {
    margin: 0 0 12px;
    padding-left: 18px;
    line-height: 1.8;
    color: var(--text-secondary);
    font-size: 14px;
  }

  .secondary p {
    margin: 0;
    color: var(--text-muted);
    line-height: 1.6;
    font-size: 14px;
  }

  @media (max-width: 640px) {
    .hero,
    .secondary {
      padding: 20px;
    }
    h1 { font-size: 24px; }
  }
</style>
```

**Visual changes:**
- Hero points change from teal pill badges to neutral gray tags (matches the reduced-pill approach)
- Serif H1 comes in
- Section H2 follows the uppercase label convention

---

## 18. What to Delete

A clear list of every deletion, for confirmation:

### Files to delete

| File | Action |
|---|---|
| `src/lib/components/FeatureRoadmap.svelte` | Delete the file entirely |

### Lines to delete from `src/routes/+page.svelte`

| Lines (approx.) | Content | Action |
|---|---|---|
| Line 7 | `import FeatureRoadmap from '$lib/components/FeatureRoadmap.svelte'` | Delete |
| Lines 250–252 | `<div style="margin-top: 56px;"><FeatureRoadmap /></div>` | Delete |
| Lines 228–230 | `<p style="...">Works with PDF, JPG, PNG · Max 20MB</p>` | Delete (now inside drop zone) |

### CSS patterns to delete

| Component | Pattern to delete |
|---|---|
| `LiveBanner` | `background: #065F46` — replace with `var(--bg-ink)` |
| `ShareButton` | `.share-bubble::after` pseudo-element block — remove |
| `ShareButton` | The `radial-gradient(circle at top left...)` background — remove |
| `ResultsSummary` | Individual `.stat.error`, `.stat.warning` colored text rules — replaced with `::before` top rules |

---

## 19. What to Add (New Elements)

### New CSS classes added and what they do

| Class | Location | Purpose |
|---|---|---|
| `.upload-header` | `+page.svelte` style | Left-aligned header with serif title |
| `.upload-title` | `+page.svelte` style | H1 using `var(--font-display)`, 38px |
| `.upload-subtitle` | `+page.svelte` style | Muted subtitle below title |
| `.drop-icon` | `+page.svelte` style | SVG icon wrapper inside drop zone |
| `.drop-primary` | `+page.svelte` style | Bold prompt text |
| `.drop-secondary` | `+page.svelte` style | Muted hint text |
| `.file-icon-wrap` | `+page.svelte` style | Square icon bg for selected file |
| `.file-info` | `+page.svelte` style | Column layout for file name + size |
| `.file-status` | `+page.svelte` style | "Ready" green badge |
| `.upload-cta` | `+page.svelte` style | Full-width primary button |
| `.trust-row` | `+page.svelte` style | Inline text trust items (replaces pill badges) |
| `.trust-item` | `+page.svelte` style | Individual trust string |
| `.trust-sep` | `+page.svelte` style | `·` separator |
| `.trust-link` | `+page.svelte` style | Underlined muted link |
| `.feedback-section` | `+page.svelte` style | Section wrapper with top border |
| `.processing-screen` | `+page.svelte` style | Processing screen container |
| `.processing-inner` | `+page.svelte` style | Max-width inner container |
| `.processing-label` | `+page.svelte` style | "Analyzing" eyebrow |
| `.processing-title` | `+page.svelte` style | Serif H2 |
| `.processing-sub` | `+page.svelte` style | Subtitle text |
| `.step-dot` | `+page.svelte` style | 5px dot for pending steps |
| `.results-header` | `+page.svelte` style | Results screen top bar |
| `.results-header-left` | `+page.svelte` style | Left group (back + title) |
| `.results-header-actions` | `+page.svelte` style | Right group (download button) |
| `.results-back-btn` | `+page.svelte` style | Ghost back button |
| `.results-title` | `+page.svelte` style | Serif H2 for results |

### New global utility classes added in `app.css`

| Class | Purpose |
|---|---|
| `.eyebrow` | All-caps 11px label, forest green, 0.1em spacing |
| `.btn-ghost` | Ghost button — transparent, no border, muted text |
| `.divider` | 1px border-top hr element |
| `.container-wide` | 900px wide variant |

### New SVG icons

Replace the following text/emoji icons with inline SVG throughout `+page.svelte`:

| Old | New HTML |
|---|---|
| `↑` in drop zone | Upload SVG (see Step 2 above) |
| `📄` file icon | File SVG (see Step 2 above) |
| `← New bill` | Arrow SVG + "New bill" text (see Step 6C) |
| `✓` in step indicator | Checkmark SVG (see Step 6B) |

---

## 20. Mobile Breakpoints Checklist

All breakpoints are already defined per-component. Here is a verification checklist:

### `+page.svelte` — ensure these responsive behaviors:

- [ ] `.upload-title`: Reduce to `28px` at `max-width: 480px`
  ```css
  @media (max-width: 480px) {
    .upload-title { font-size: 28px; }
    .drop-zone { padding: 28px 20px; }
    .upload-subtitle { font-size: 15px; }
  }
  ```
  Add this block to the `+page.svelte` `<style>` at the end.

- [ ] `.results-header`: Wraps correctly at `flex-wrap: wrap` (already set)
- [ ] `.results-title`: Reduce to `20px` at `max-width: 480px`
  ```css
  @media (max-width: 480px) {
    .results-title { font-size: 20px; }
  }
  ```

### `ResultsSummary.svelte` — ensure:

- [ ] `grid-template-columns: repeat(2, 1fr)` at `max-width: 600px` (already defined)

### `LineItemCard.svelte` — ensure:

- [ ] `.item-main` still reads at small widths. Add:
  ```css
  @media (max-width: 480px) {
    .item-desc { display: none; } /* on mobile, CPT code + amount is enough */
    .item-amount { font-size: 13px; }
  }
  ```

### `LiveBanner.svelte` — ensure:

- [ ] At `max-width: 480px`, the `.stats-link` is hidden to avoid overflow:
  ```css
  @media (max-width: 480px) {
    .stats-link { display: none; }
    .sep:last-of-type { display: none; }
  }
  ```

### `DisputeLetter.svelte` — ensure:

- [ ] Letter body reduces padding on mobile:
  ```css
  @media (max-width: 480px) {
    .letter-body { padding: 18px 16px; }
  }
  ```

---

## Summary of All Color Changes

For quick reference, here are every color token that changed from the old system:

| Token | Old value | New value | Notes |
|---|---|---|---|
| `--bg` | `#FAFAF9` | `#F5F4F0` | Warmer cream |
| `--bg-card` | `#FFFFFF` | `#FEFEFE` | Fractionally warmer |
| `--text-primary` | `#1C1917` | `#111110` | Deeper, warmer black |
| `--text-muted` | `#78716C` | `#79776F` | Nearly identical, updated var name |
| `--border` | `#E7E5E4` | `#DDD9D2` | Slightly warmer, more visible |
| `--accent` | `#0D9488` (teal) | `#2D6A4F` (forest green) | Core identity change |
| `--accent-hover` | `#0F766E` | `#1E4D38` | Matches new accent |
| `--font-sans` | `'Geist', 'Inter'` | `'DM Sans'` | Font identity change |
| `--font-mono` | `'Geist Mono', 'JetBrains Mono'` | `'IBM Plex Mono'` | Font identity change |
| `--font-display` | n/a (new) | `'DM Serif Display'` | New variable |
| LiveBanner bg | `#065F46` | `#191918` | Banner goes dark |
| Trust badges | `#F0FDFA` teal pills | Inline text, no pills | Removed pill aesthetic |
| FeatureRoadmap | exists | deleted | Entirely removed |
| `.stat` colored text | per-color text values | `::before` top rule strips | Data reads cleaner |

---

## Final QA Checks

After implementing all changes, verify:

1. **Font loading**: Open DevTools Network tab. Confirm `DM Serif Display`, `DM Sans`, `IBM Plex Mono` all load from Google Fonts. If they fail, the `@import` in `app.css` is the fallback.

2. **Accent color**: Do a global search for `#0D9488` and `#0F766E` in all `.svelte` and `.css` files. There should be none remaining. Any found should be replaced with `var(--accent)` or `var(--accent-hover)`.

3. **No teal remnants**: Search for `#F0FDFA` and `#99F6E4` — the old teal-tinted backgrounds. Replace with `var(--accent-light)` and `var(--success-border)` respectively.

4. **FeatureRoadmap**: Confirm the component file is deleted and no import/usage remains in `+page.svelte`.

5. **Mobile test at 375px width**: Check each screen — upload, processing, results. Use Chrome DevTools device simulation.

6. **Focus rings**: Tab through the upload form. The drop zone, file input trigger, and Analyze button should all show a visible `2px solid #2D6A4F` focus ring.

7. **DM Serif Display rendering**: Check that `h1` on the homepage renders in the serif font, not DM Sans. If both look the same, the font load likely failed — verify the `<link>` in `app.html`.
