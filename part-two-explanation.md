# Hospital Bill Checker — Part Two Deep Dive

*Analysis date: 2026-04-01*

---

## 1. What Changed After `steps-two.md` Was Written

`steps-two.md` was created in commit `40b8609` ("Checkpoint current step-two implementation"). Two commits followed.

### Commit `3f518a5` — "Refine results layout and report export" (2026-03-31 17:09)

12 files changed, 929 insertions, 213 deletions. This was the largest single post-step-two commit.

**New files:**
| File | Purpose |
|---|---|
| `src/lib/results.ts` | New module: `buildResultSections()` organises findings into typed display sections (`unbundling`, `duplicate`, `pharmacy_markup`, `upcoding`, `icd10_mismatch`, `above_hospital_list_price`, `other`, `clean`). Keeps unbundling pairs together and groups duplicate CPTs. |
| `src/lib/results.test.ts` | 118-line test suite for the new results module |
| `src/lib/result-report.test.ts` | 199-line test suite for PDF report generation |
| `src/lib/components/DisputeLetter.test.ts` | 40-line test suite for DisputeLetter |
| `src/lib/components/ShareButton.test.ts` | 22-line test suite for ShareButton |

**Modified files (key changes):**
- `src/lib/result-report.ts` — Major PDF report rewrite. Removed flat card layout; added grouped section bands with colour headers, inline benchmark rates, and savings estimates. Removed the dispute-letter appendix from the PDF. New helpers: `drawWrappedText`, `drawSummaryStrip`, `groupFindings`, `drawGroupHeader`, `drawFindingCard`, `FINDING_GROUPS`.
- `src/routes/+page.svelte` — Results list now rendered through `buildResultSections`; processing step labels simplified (e.g. "8,150 NCCI rules" wording removed). New CSS classes: `.result-section`, `.result-group`, `.result-group-title`, `.result-group-cards`.
- `src/lib/components/ShareButton.svelte` — Expanded to multi-platform sharing (LinkedIn, Facebook, WhatsApp added alongside Twitter).
- `src/lib/analytics.ts` — Added `trackShareOpened(platform)` generic tracker; refactored `trackShareTwitter` to delegate to it.
- `src/lib/components/DisputeLetter.svelte` — Added `formatTableRowsForEmail()` helper for plain-text email rendering of dispute table rows.
- `src/lib/components/LineItemCard.svelte` — Refactored and reduced (~36 lines removed).

**What the `above_hospital_list_price` savings calculation adds:**
`getPriceComparison` in `result-report.ts` now computes an additional savings bucket: when a billed amount exceeds the hospital's own MRF gross charge, the overcharge above that list price is recorded separately.

### Commit `d04051e` — "Add cached NCCI source archive" (2026-03-31 17:35)

One file: `data/ncci-q2-2026.zip` (68.2 MB). Caches the full CMS NCCI Q2 2026 source data locally so `scripts/build_ncci.py` can run without a network download.

### What `steps-two.md` Was About

The document diagnosed why the same PDF produced different audit findings across runs (CPT pair 70450+70486 was inconsistently flagged). Six root causes were identified and fixed:

1. **Critical:** `ncci.json` had only 4 hardcoded entries instead of the ~280,000 real CMS pairs — the AI was guessing from training memory.
2. **Critical:** Gemini was called without `temperature=0` (default ~1.0), making every run stochastic.
3. **Medium:** Model not pinned — `gemini-2.5-flash` first, then `gemini-2.5-pro`, with different reasoning between them.
4. **Medium:** `mpfs.json` had only 24 E&M codes, no radiology rates — no benchmark for 70xxx codes.
5. **Medium:** Audit prompt had no radiology-specific unbundling rules.
6. **Lower:** Vision extraction also non-deterministic (no temperature set).

The document is marked "ALL STEPS COMPLETED."

---

## 2. LLM vs. Deterministic: Who Does Each Check?

The system uses a hybrid architecture. Deterministic checks run first and are treated as authoritative; the LLM fills in judgment-requiring checks and cannot override deterministic results.

### Stage 1 — Parse (`POST /api/parse`)

| Step | Type | Detail |
|---|---|---|
| File type detection | **Deterministic** | Magic bytes: PDF `%PDF`, JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP `RIFF…WEBP` |
| File size limit | **Deterministic** | 20 MB hard cutoff |
| Bill OCR / extraction | **LLM** (Gemini 2.5 Flash, `vision-extract.mjs`, `temperature=0`) | Extracts `lineItems[]`, `cptCodes[]`, `hospitalName`, `accountNumber`, `dateOfService`. Handles UB-04 vs CMS-1500 distinction in prompt; returns `errorMessage` for EOBs or blurry scans. |
| CPT/HCPCS normalisation | **Deterministic** | Strips leading zeros; enforces regex `^([0-9]{5}|[JGABC][0-9]{4})$`; discards 4-digit Revenue Codes and internal charge codes. |

### Stage 2 — Audit (`POST /api/audit`)

#### 2a — Deterministic Pre-Checks (run before any LLM call)

These run in `audit-rules.ts`. Their findings are injected into the LLM prompt as a `promptNote` instructing the model not to contradict or duplicate them.

| Check | Type | Data Source | Confidence |
|---|---|---|---|
| **NCCI Unbundling** | **Deterministic** | `ncci.json` (full CMS PTP edit table, ~280,000 pairs) | Always `high` |
| **Duplicate Billing** | **Deterministic** | Bill itself (code deduplication within the claim) | Always `high` |
| **Pharmacy Markup** | **Deterministic** | `asp.json` (CMS ASP rates). Flags if `billedAmount > ASP_rate × units × 1.06 × 4.5` | Always `high` |

**NCCI logic detail:** If a CPT is a Column 2 code and its Column 1 (comprehensive) code is also on the bill, it is flagged. Modifier `-59` / `XE` / `XP` / `XS` / `XU` downgrades to `warning` if `modifierCanOverride: true`; otherwise remains `error` regardless.

#### 2b — LLM Findings (Gemini 2.5 Pro, `temperature=0`)

The LLM receives: all line items as JSON + a `buildDataContext` string filtered to codes present on the bill (NCCI hits, MPFS rates, ASP limits, 5 hardcoded radiology bundling rules) + the `promptNote` listing confirmed deterministic findings.

The model is instructed to find only these three judgment-based issues:

| Check | Type | Grounding Data |
|---|---|---|
| **Upcoding** (E&M codes 99201–99285 billed too high for diagnosis) | **LLM** | MPFS rates injected as context |
| **Unbundling** (non-NCCI / radiology pairs not in the PTP table) | **LLM** | NCCI hits + 5 radiology rules injected as context |
| **ICD-10 Mismatch** (diagnosis doesn't justify the procedure) | **LLM** | Diagnosis codes on bill |

**Post-LLM merge (deterministic):** LLM findings that overlap with codes already caught by the deterministic layer are dropped. Summary totals (`potentialOvercharge`, etc.) are **fully recomputed in code** — the LLM's arithmetic is not trusted.

#### 2c — Hospital Price Transparency Lookup (Deterministic)

- State code extracted from hospital name via regex on 2-letter uppercase tokens.
- `lookupHospitalPrices(hospitalName, state, codes)` → derives a filesystem slug → checks a local SQLite cache (24-hour TTL) → if stale, runs `scripts/fetch_hospital_mrf.py` as a subprocess to fetch the hospital's CMS MRF.
- Returns `grossCharge`, `discountedCash`, `minNegotiated`, `maxNegotiated` per CPT code.
- **Above-Hospital-List-Price check (deterministic):** for any line item with no existing finding where `billedAmount > grossCharge`, creates a `warning` with `confidence: high`.

#### 2d — Dispute Letter Generation (LLM, Call 2)

The LLM writes a dispute letter from the merged findings. Required structure is enforced by prompt: right-to-dispute opening → itemised table → request for corrected bill or written justification → citation to 42 CFR 405.374 → signature block with exact placeholder strings (`[Your Full Name]`, `[Today's Date]`, etc.).

### Key Architectural Points

- **The LLM is Gemini, not Claude.** Despite the file names `claude.ts` / `claude-worker.mjs`, all inference calls go to `gemini-2.5-pro` (with `gemini-2.5-flash` as a 503-fallback).
- **Deterministic findings are authoritative.** They are written to the prompt as facts the LLM must not contradict.
- **The LLM is given grounding data.** CMS rate tables are filtered to only the codes on the current bill and injected as context, anchoring the model in actual data rather than training memory.

---

## 3. Hospital Search — How It Works

### Algorithm

Hospital name matching is **normalised exact-string lookup**, not fuzzy and not LLM-based.

**Index key format:** `{normalized_name}|{state_lowercase}` — e.g. `abbott northwestern hospital|mn`

**`normalize_name` function (Python, `build_hospital_index.py`):**
1. Lowercase
2. Unicode NFKD
3. Strip non-ASCII
4. Replace non-alphanumeric with spaces
5. Collapse whitespace

**Lookup (in `fetch_hospital_mrf.py`):**
1. Apply same normalisation to the query name.
2. If state is known: try exact key `normalized|state`.
3. No state: scan all keys matching `normalized|*`.
4. **Fallback if no index hit:** strip generic words ("hospital", "medical", "center", etc.), assemble candidate domains (`www.{slug}.org`, `.com`, etc.), make HTTP HEAD requests, look for `/cms-hpt.txt` or `/.well-known/cms-hpt.txt` with an `mrf-url:` line.

**Implication:** If the hospital name in the bill is slightly different from the CMS registry (e.g., "St. Mary's" vs "Saint Marys"), no index match is found and the system falls back to heuristic domain guessing, which may or may not succeed.

### Data Store

- Index file: `src/lib/data/hospital_index.json` (~7,000 hospitals from CMS Hospital General Information)
- Price cache: SQLite `.db` file per hospital slug under `data/mrf_cache/`, 24-hour TTL

---

## 4. Data Freshness: What Is Current, What Is Stale

| Dataset | File | Version | Period | Status |
|---|---|---|---|---|
| **MPFS** | `src/lib/data/mpfs.json` | RVU26A (2026 Annual, January release) | Full year 2026 | **Current** |
| **CLFS** | `src/lib/data/clfs.json` | 26CLABQ2 | Q2 2026 (Apr–Jun 2026) | **Current** |
| **NCCI** | `src/lib/data/ncci.json` | Medicare PTP Q2 2026 (v321r0) + Medicaid fallback | Apr 1 – Jun 30, 2026 | **Current** |
| **ASP** | `src/lib/data/asp.json` | Q3 2025 (July 2025 pricing file) | Jul 1 – Sep 30, 2025 | **Outdated — 3 quarters behind** |
| **Hospital Index** | `src/lib/data/hospital_index.json` | CMS Hospital General Information | Monthly refresh (not dated in file) | Likely current |

**Only stale dataset: ASP.** As of 2026-04-01, Q2 2026 (effective April 1, 2026) is the current quarter. `scripts/build_asp.py` hardcodes URLs only through `july-2025-asp-pricing-file.zip`. The `ASP_URLS` list needs the `april-2026-asp-pricing-file.zip` URL added.

---

## 5. What Are the "Other Files" Inside Each Download ZIP?

Each CMS source ZIP contains multiple files. The build scripts use one and silently ignore the rest.

### MPFS ZIP (`rvu26a.zip`)
- **Used:** `PPRRVU2026_Jan_nonQPP.xlsx` (or first file matching `nonqpp`, then `pprrvu`, then any `.xlsx`)
- **Ignored:** QPP variants, PDF documentation

### CLFS ZIP (`26clabq2.zip`)
- **Used:** First parseable file in preference order: `.csv` → `.txt` (tilde-delimited) → `.xlsx`
- **Ignored:** Section 508-accessible alternative format alongside the main data file

### NCCI ZIPs (4 part files for Medicare + 1 Medicaid fallback)
- **Used:** The practitioner PTP `.TXT` file from each of the 4 part ZIPs (files named `-f1` through `-f4`); all merged
- **Ignored:** Hospital outpatient PTP edits, DME PTP edits (also in the ZIPs, but different edit categories)
- **Local cache:** `data/ncci-q2-2026.zip` (68 MB) — allows offline build

### ASP ZIP (`july-2025-asp-pricing-file.zip`)
- **Used:** CSV file (more reliable encoding); falls back to XLS/XLSX
- **Ignored:** Section 508-accessible alternative version

**How to know which file to download:** `DATA.md` is the source of truth. It lists the exact URL, expected filename, version, effective dates, and which build script consumes it for each dataset.

---

## 6. Code Types Used in Medical Billing — Full Reference

The project handles the professional/outpatient core well but is missing several code types found on real hospital bills.

### Codes Present in the Project

| Code Type | Status | Notes |
|---|---|---|
| **CPT (Level I HCPCS)** | Full | Primary identifier; `LineItem.cpt` field; CPT descriptions map in code |
| **HCPCS Level II** | Partial | `LineItem.cpt` also accepts HCPCS (J, G, Q, A, B, C prefixes validated); ASP data covers J-codes |
| **Modifiers** | Full | `LineItem.modifiers[]`; `-59`, `XE`, `XP`, `XS`, `XU` handled for NCCI override logic |
| **ICD-10-CM** | Partial | `LineItem.icd10Codes[]` field; `icd10_mismatch` finding type; no deterministic rule table — LLM only |
| **NCCI Edits** | Full | Full PTP table in `ncci.json`; deterministic unbundling detection |
| **MPFS** | Full | `mpfs.json`; benchmark rates for upcoding and markup calculations |
| **CLFS** | Full | `clfs.json`; lab code rate fallback when MPFS rate is absent |
| **ASP Drug Pricing** | Full | `asp.json`; deterministic pharmacy markup detection |

### Codes NOT in the Project (and Why They Matter)

| Code Type | What It Is | Why It's Missing / What Adding It Would Enable |
|---|---|---|
| **Revenue Codes (UB-04)** | 4-digit codes identifying the hospital department/service category on institutional claims (e.g., 0450 = Emergency Room, 0636 = Drug requiring specific ID). Required on every UB-04. Over 1,000 defined codes. | Currently filtered out by CPT normalisation. Adding them would enable detection of miscategorised service types (e.g., a pharmacy code billed under a surgical revenue code). Proprietary: maintained by NUBC/AHA. |
| **NDC Codes** | 10/11-digit FDA drug product identifiers (labeler + product + package). Appear on itemised pharmacy line items alongside HCPCS J-codes. | Not in `LineItem`. Adding them would enable precise drug identification beyond J-codes and cross-reference against FDA pricing data. Free/public from FDA. |
| **MS-DRG** | 3-digit CMS inpatient grouping codes that determine flat Medicare payment for a hospital admission (v42, FY2025). | Project is outpatient-focused. For inpatient bills, the DRG payment should roughly match the sum of line items — overbilling relative to the DRG is a red flag. Free/public from CMS. |
| **ICD-10-PCS** | 7-character codes for inpatient procedures (separate from CPT, used only on UB-04 inpatient claims). | Project uses CPT for all procedures. PCS codes are inpatient-only and would require a different audit model. Free/public from CMS. |
| **APC Codes** | CMS grouping system for hospital outpatient payments (OPPS). Each CPT on an outpatient UB-04 maps to an APC that sets the facility payment rate. | Project uses MPFS (physician rates) as benchmark. For facility/outpatient claims, OPPS APC rates are the correct benchmark. Free/public from CMS. |
| **ASC Payment Groups** | CMS payment groupings for procedures performed in ambulatory surgery centres. Uses CPT codes but separate payment rates. | Not referenced. Relevant for bills from ASC facilities. Free/public from CMS. |

---

## 7. Authoritative Websites for Every Code Type

### CPT Codes (Level I HCPCS)
- **Official (AMA, paid license required for production):** https://www.ama-assn.org/practice-management/cpt
- **Free lookup (personal use):** https://catalog.ama-assn.org/Catalog/cpt/cpt_search.jsp
- **Note:** CPT is proprietary. Any database embedding CPT codes in a commercial product requires an AMA license.

### ICD-10-CM (Diagnosis Codes) — Free / Public
- **CMS (authoritative source + downloads):** https://www.cms.gov/medicare/coding-billing/icd-10-codes
- **CDC interactive browser:** https://icd10cmtool.cdc.gov/
- **Free reference with search:** https://www.icd10data.com

### ICD-10-PCS (Inpatient Procedure Codes) — Free / Public
- Same CMS page: https://www.cms.gov/medicare/coding-billing/icd-10-codes
- Annual files released each October.

### HCPCS Level II — Free / Public
- **CMS (authoritative):** https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system
- **Quarterly update files:** https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system/quarterly-update
- **Free reference with search:** https://hcpcs.codes/

### MS-DRG (Diagnosis Related Groups) — Free / Public
- **CMS:** https://www.cms.gov/medicare/payment/prospective-payment-systems/acute-inpatient-pps/ms-drg-classifications-and-software
- **Free lookup:** https://www.icd10data.com/ICD10CM/DRG

### Revenue Codes (UB-04) — Proprietary (NUBC/AHA)
- **Official (subscription required):** https://www.nubc.org/
- **Free reference (unofficial but comprehensive):** https://www.findacode.com/ub04-revenue/

### NDC Codes — Free / Public (FDA)
- **FDA NDC Directory:** https://www.fda.gov/drugs/drug-approvals-and-databases/national-drug-code-directory
- **openFDA API:** https://open.fda.gov/data/ndc/
- **DailyMed (NLM, with drug labeling):** https://dailymed.nlm.nih.gov/dailymed/

### NCCI Edits (PTP + MUEs) — Free / Public
- **CMS NCCI overview:** https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits
- **PTP edits download:** https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits
- **MUEs download:** https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues

### MPFS (Medicare Physician Fee Schedule) — Free / Public
- **CMS:** https://www.cms.gov/medicare/payment/fee-schedules/physician

### CLFS (Clinical Laboratory Fee Schedule) — Free / Public
- **CMS:** https://www.cms.gov/medicare/payment/fee-schedules/clinical-laboratory-fee-schedule-clfs
- **CY2026 public use files:** https://www.cms.gov/medicare/payment/fee-schedules/clinical-laboratory-fee-schedule-clfs/files

### ASP Drug Pricing — Free / Public
- **CMS:** https://www.cms.gov/medicare/payment/part-b-drugs/asp-pricing-files

### APC (Ambulatory Payment Classifications / OPPS) — Free / Public
- **CMS Hospital Outpatient PPS:** https://www.cms.gov/medicare/payment/prospective-payment-systems/hospital-outpatient
- **Free lookup:** https://www.findacode.com/apc/

### ASC Payment — Free / Public
- **CMS:** https://www.cms.gov/medicare/payment/prospective-payment-systems/ambulatory-surgical-center-asc

### Provider Taxonomy Codes — Free / Public
- **CMS:** https://www.cms.gov/medicare/enrollment-renewal/providers-suppliers/health-care-taxonomy

### SNOMED CT (Clinical Terms — Less Common in Billing)
- **SNOMED International:** https://www.snomed.org/
- **NLM (free US access via UMLS):** https://www.nlm.nih.gov/healthit/snomedct/index.html

---

## Summary: The Biggest Gaps to Address

1. **ASP data is 3 quarters out of date.** Update `build_asp.py` to point at the April 2026 file (`april-2026-asp-pricing-file.zip`).
2. **Hospital name matching is brittle.** Exact normalised match means minor name variations produce no match. A fuzzy/edit-distance fallback (e.g., trigram similarity) before the domain-guessing heuristic would dramatically improve hit rates.
3. **Revenue codes are stripped.** Adding them to `LineItem` would enable a whole new class of miscategorisation checks on UB-04 bills.
4. **NDC codes absent.** Pharmacy line items lose drug-level precision without them.
5. **APC rates not used.** For outpatient facility claims, MPFS physician rates are the wrong benchmark — OPPS APC rates are the correct one.
6. **ICD-10 mismatch is LLM-only.** A supplementary deterministic table of common procedure→diagnosis validity rules would make this check more consistent and auditable.
