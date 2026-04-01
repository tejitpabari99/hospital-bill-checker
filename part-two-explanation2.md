# Hospital Bill Checker — Part Two Analysis: Improvements & Next Steps

*Analysis date: 2026-04-01*

---

## 1. Making LLM Checks Deterministic

The three LLM-based audit checks (upcoding, non-NCCI unbundling, ICD-10 mismatch) can all be significantly hardened with deterministic data. The LLM should become an *explainer* of deterministic findings, not the *detector*.

### 1.1 Upcoding

**Current state:** LLM uses training knowledge to judge whether an E&M code (99201–99285) is too high for the diagnoses present. Inherently stochastic.

**What makes this hard to fully determinize:** E&M level is determined by three axes — Medical Decision Making (MDM), physician total time, and History+Physical. Total time and H+P are invisible from a bill. No code encodes how long the encounter was.

**What CAN be determinized:**

The MPFS `description` field already encodes the MDM tier for every E&M code (e.g., "Office o/p new sf 15 min" = straightforward, "Office o/p est hi 40 min" = high MDM). This gives a direct CPT → required MDM tier mapping.

On the ICD-10 side, a tiered lookup table mapping ICD-10 three-digit categories (~2,000 categories) to their maximum plausible MDM level is buildable. Examples:
- `Z00` (routine exam), `Z23` (vaccine) → max MDM: **straightforward**
- `J06` (URI), `K21` (GERD) → max MDM: **low**
- `E11` (T2DM), `I10` (hypertension) → max MDM: **low–moderate**
- `I21` (MI), `J18` (pneumonia), `C34` (lung cancer) → max MDM: **high**

If `required MDM tier > max ICD-10 MDM tier` → deterministic upcoding flag, confidence: high.

**Remaining LLM role:** Write the plain-English explanation. "Your bill charges 99215 (high complexity) but the diagnoses listed suggest low-complexity care. Consider requesting documentation justifying this level." The LLM is explaining a rule violation, not discovering one.

**Data source:** ICD-10-CM Tabular List (FY2026 XML, free from CMS). Supplemented by a hand-built ~2,000-row ICD-10 category → MDM tier table.

**Effort:** 2–3 days for the mapping table + integration.

---

### 1.2 Non-NCCI Unbundling

**Current state:** The NCCI PTP table (8,150 entries) covers the main deterministic unbundling. The LLM handles: radiology TC/PC splits, APC packaging, add-on codes, and MUE unit violations.

**What can be determinized next:**

**MUE (Medically Unlikely Edits) — Highest ROI next step:**
- CMS publishes per-code maximum units per date of service.
- Format: same as NCCI, quarterly Excel download.
- Source: https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues
- ~12,000 CPT/HCPCS codes covered.
- Would eliminate the entire unit-count class of unbundling errors deterministically (e.g., 99215 billed 5 units in one day = automatic flag).
- Build script: near-identical to `build_ncci.py`.

**Hospital Outpatient PTP Edits:**
- CMS publishes a separate PTP edit table for facility (UB-04) claims — currently the project uses the practitioner PTP table only.
- Relevant when bills are from a facility, not just a physician practice.
- Source: same CMS NCCI page, different download.
- Format: same tab-delimited `.txt` structure.

**OPPS Comprehensive/Conditional Packaging:**
- CMS Outpatient PPS Addendum B lists which CPT codes are "packaged" (Status Indicator = N) or conditionally packaged (Q1–Q4) into a comprehensive APC.
- When a major procedure is billed, packaged ancillary services cannot be billed separately.
- Source: CMS Hospital Outpatient PPS page, quarterly Excel Addendum B.
- Adds ~5,000–8,000 packaging rules.

**Remaining LLM role after these additions:** Genuinely novel clinical combinations not covered by any table — a very narrow residual.

---

### 1.3 ICD-10 Mismatch

**Current state:** Pure LLM, low confidence. The LLM is applying general clinical knowledge with no grounding data.

**What can be determinized — the highest-value opportunity:**

CMS publishes **Local Coverage Determinations (LCDs)** and **National Coverage Determinations (NCDs)**, which explicitly list ICD-10 codes that support medical necessity for specific CPT procedures. This is the direct, authoritative answer to "does this diagnosis justify this procedure."

- **NCD API:** `https://api.cms.gov/v1/ncds` — JSON API for ~200 national-level coverage determinations.
- **LCD database:** downloadable ZIP from CMS Medicare Coverage Database — ~1,500–2,000 active LCDs, each with a `LCD_ICD10` table mapping `LCD_ID → CPT → ICD10 → COVERAGE_STATUS` (covered / non-covered).
- Total table size: ~50,000–200,000 CPT→ICD10 pairs after parsing.

When a bill has CPT code 82306 (vitamin D test) but only `Z00.00` (routine exam) as ICD-10 — and the LCD for 82306 requires `E55.9` (vitamin D deficiency) or similar — that's a citable, high-confidence finding that names the specific LCD and explains exactly what's wrong.

**Remaining LLM role:** CPT codes with no LCD/NCD coverage (roughly 75% of CPT codes have no published coverage determination). The LLM handles these with explicit `confidence: low` labeling.

**Effort:** 1–2 weeks for the LCD/NCD build script and integration. Highest-effort item but highest credibility gain.

---

### 1.4 Tool Calling Architecture

Rather than a single monolithic prompt, the LLM should call tools that execute deterministic lookups, then explain results.

**Proposed tool definitions:**

```
check_em_level(emCode, icd10Codes)
  → { emLevel, icdMaxLevel, mismatch: bool, medicareRate, rateNextLower }

check_bundling(code, allCodesOnBill, modifiers)
  → { ncciViolation, mueViolation, mueLimit, billedUnits, oppsPackaged }

check_icd10_coverage(cptCode, icd10Codes)
  → { coverageResult: covered|not_covered|no_lcd_available, lcdId, coveredIcds, unmatchedIcds }

lookup_mpfs_rate(cptCode)
  → { rate, description, source }
```

**Flow:**
1. LLM receives bill line items + tool definitions.
2. LLM calls tools per line item (Gemini 2.5 Pro supports function calling).
3. Tools return structured deterministic results.
4. LLM writes plain-English explanations grounded in tool output.

**Key benefit:** When the dispute letter cites "LCD L33614 — covered diagnoses do not include Z00.00," a hospital billing department cannot dismiss it as an AI opinion. The LLM becomes a communicator of facts, not the source of facts.

---

### 1.5 Priority Order

| Item | Effort | Impact |
|---|---|---|
| MUE unit edits (add `build_mue.py`) | 2 days | High — eliminates unit-count unbundling class |
| Hospital Outpatient PTP edits | 1 day | Medium — improves UB-04 bill accuracy |
| ICD-10 → MDM tier table for upcoding | 2–3 days | Medium — catches obvious E&M upcoding |
| Tool calling refactor | 3–4 days | High — structural improvement to reliability |
| LCD/NCD CPT→ICD10 build script | 1–2 weeks | High — transforms ICD-10 mismatch check |
| OPPS Addendum B packaging | 2 days | Medium |

---

## 2. Hospital Name Matching Improvements

### 2.1 Current State and Bugs

**Algorithm:** Exact normalised string match on `{name}|{state}` key. Falls back to heuristic domain guessing (HTTP HEAD to `/cms-hpt.txt`).

**Known bug:** The apostrophe-to-space conversion in `normalize_name()` splits possessives. "Children's Hospital" → `children s hospital` (with a space before `s`) — never matches `childrens hospital` in the index. A one-line fix: replace `'s` with `s` before stripping punctuation.

**Other missed variations:** "St." vs "Saint", "Mt." vs "Mount", "Mem" vs "Memorial", "Med Ctr" vs "Medical Center", "Univ" vs "University".

### 2.2 What the Index Currently Stores

`hospital_index.json` — 5,407 entries. Each entry has:
```
name, city, state, zip, phone, ccn, domain (null), npi (null)
```

**Address field is missing** — the CMS source dataset has it but `build_hospital_index.py` never captures it.

### 2.3 Recommended Improvements (Tiered)

**Tier 1 — Pure code, zero external dependencies, highest ROI:**

1. **Fix the possessive bug:** In `normalize_name()`, replace `'s` with `s` before stripping punctuation. One line change.

2. **Add synonym expansion table:** Before normalisation, apply a small lookup:
   ```python
   SYNONYMS = {
     "st.": "saint", "st ": "saint ",
     "mt.": "mount", "mt ": "mount ",
     "mem ": "memorial ", "med ctr": "medical center",
     "hosp ": "hospital ", "univ ": "university ",
   }
   ```
   Apply to both the query and the index keys at build time.

3. **Capture the `Address` field** from the CMS CSV in `build_hospital_index.py`. Available now, zero cost.

4. **Extend the vision prompt** in `vision-extract.mjs` to extract `hospitalAddress` and `hospitalPhone` (both appear on every bill header). No extra API cost.

5. **`rapidfuzz` fuzzy matching fallback:** When exact match fails, run `rapidfuzz.fuzz.token_set_ratio` against all same-state entries (5,407 ÷ 50 states ≈ 108 entries per state on average). Score ≥ 85 = match. Pure pip install, ~1ms per lookup.

**Tier 2 — Phone-number cross-referencing:**

6. When vision extraction returns `hospitalPhone`, normalize it (strip non-digits, last 10 digits) and look it up directly against the `phone` field in the index. Phone matches bypass all name-matching problems and are nearly unambiguous.

7. **ZIP-code proximity tiebreaker:** When multiple fuzzy candidates remain, prefer the entry whose ZIP matches what was extracted from the bill address.

**Tier 3 — Google Places API (last resort for hard cases):**

8. For bills where Tier 1+2 produce no match ≥ 85 similarity, call Google Places Text Search with `hospitalName + hospitalAddress`. Places returns a canonical name and phone number; cross-reference the phone against the CMS index.
   - Cost: ~$0.017/call (Places Text Search). Cache results by `(normalized_name, state)`.
   - Free alternative: OpenStreetMap/Nominatim is not production-viable without self-hosting (1 req/sec limit).

**Expected match rate improvement:**
- Tier 1 alone closes ~60–70% of mismatches.
- Phone matching (Tier 2) closes another 20–25%.
- Google Places mops up the last edge cases (~5%).

### 2.4 Phone Matching Is the Most Underexploited Opportunity

The CMS index already stores the hospital's registered phone number. Every hospital bill prints the hospital's phone. The vision model already reads the full bill. Adding `hospitalPhone` to the vision extraction prompt costs nothing and enables unambiguous matching.

---

## 3. ASP Data Update (Applied)

**Previous state:** `build_asp.py` pointed at Q3 2025 (July 2025 file) — 3 quarters behind.

**What was discovered:** CMS also changed their filename convention starting Q4 2025. The old pattern (`{month}-{year}-asp-pricing-file.zip`) no longer applies.

**Updated `ASP_URLS` in `scripts/build_asp.py`:**
```python
ASP_URLS = [
    "https://www.cms.gov/files/zip/april-2026-medicare-part-b-payment-limit-files-03-30-2026-final-file.zip",  # Q2 2026
    "https://www.cms.gov/files/zip/january-2026-medicare-part-b-payment-limit-files.zip",                       # Q1 2026
    "https://www.cms.gov/files/zip/october-2025-asp-pricing-final-file.zip",                                    # Q4 2025
    "https://www.cms.gov/files/zip/july-2025-asp-pricing-file.zip",                                             # Q3 2025 (fallback)
]
```

**Format verified:** The Q2 2026 CSV has identical column structure — `HCPCS Code`, `Short Description`, `HCPCS Code Dosage`, `Payment Limit`. No parser changes needed. Script extracts 850 rates from the new file.

**Next step:** Run `python3 scripts/build_asp.py` to regenerate `src/lib/data/asp.json`.

---

## 4. What the Ignored Files in CMS ZIPs Enable

### NCCI Hospital Outpatient PTP Edits

The NCCI ZIP ships three separate PTP edit tables. The project only ingests the **practitioner** table. The **hospital outpatient** table applies to facility (UB-04) claims — different codes and different bundling rules apply in the outpatient facility setting. Adding this would improve audit accuracy for any bill from a hospital outpatient department.

**Source:** Same CMS NCCI page — download the "Hospital Outpatient" column ZIP.
**Format:** Identical tab-delimited `.txt` structure as the practitioner file.

### NCCI DME PTP Edits

PTP edits for Durable Medical Equipment suppliers. Relevant when a bill includes DME charges (HCPCS E-codes). Currently ignored. Lower priority than outpatient PTP for typical hospital bills.

### MUE (Medically Unlikely Edits) — Separate Download

Not in the main NCCI ZIP — separate download from:
https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues

**Three MUE tables:** Practitioner, Outpatient Facility, DME.
**What they contain:** Per-CPT/HCPCS maximum units billable per date of service per beneficiary.
**Two enforcement types:**
- Claim line MUEs: cap units per claim line
- Date of service MUEs: cap total units across all claim lines for that code on that date

**Example:** If CPT 99215 has an MUE of 1 unit and the bill shows 3 units, that's an automatic high-confidence error — no LLM needed.

**Build effort:** 1 day. Script nearly identical to `build_ncci.py`.

### OPPS Addendum B (APC Packaging) — Separate Source

Not in NCCI — from the CMS Hospital Outpatient PPS page.
**What it contains:** Status indicators for every CPT/HCPCS code under OPPS. Status `N` = always packaged (cannot be billed separately on an outpatient facility claim), `Q1`–`Q4` = conditionally packaged.
**Adds:** ~5,000–8,000 packaging rules for outpatient facility claims.

---

## 5. FairMedBill Gap Analysis — Their 10 "Guardians"

FairMedBill explicitly names their system "10 Guardians" in 4 categories:

| # | FairMedBill Check | hospital-bill-checker Status |
|---|---|---|
| 1 | Upcoding | Implemented (AI — see §1.1 for hardening) |
| 2 | Unbundling | Implemented (deterministic NCCI + AI radiology) |
| 3 | Record Match (bill vs. clinical notes) | **Not implemented** — requires clinical documentation upload |
| 4 | Quantity / Units plausibility | **Not implemented** — MUE table would cover this (§4) |
| 5 | Duplicates | Implemented (deterministic) |
| 6 | Math Validator (arithmetic check) | **Not implemented** — see §6.3 |
| 7 | Date Validator (service dates vs. stay) | **Not implemented** — see §6.4 |
| 8 | CMS Benchmark (price vs. federal rates) | Implemented (ASP pharmacy + MPFS benchmark + above-list-price) |
| 9 | No Surprises Act / GFE Threshold ($400+) | **Not implemented** — see §6.5 |
| 10 | Facility Behavior (systemic overcharging patterns) | **Not implemented** — requires multi-bill history |

Additionally, hospital-bill-checker has two checks FairMedBill doesn't list: **ICD-10 mismatch** and **above-hospital-list-price** (from the CMS MRF).

---

## 6. Additional Check Types to Add

### 6.1 Revenue Code vs. CPT Mismatch (UB-04 bills)

When the user submits a UB-04 facility bill, revenue codes identify the hospital department/service category. A CPT code inconsistent with its revenue code is a billing error.

**Examples:**
- CPT 99213 (office visit E&M) billed under revenue code 0450 (Emergency Room) → should be 99281–99285
- Lab CPT (80xxx, 85xxx) billed under revenue code 032x (Radiology) → wrong department
- Major surgical CPT (e.g., 27447 total knee) without revenue code 036x (Operating Room)
- Pharmacy revenue code 063x without a J-code companion → missing drug identification

**Data source:** Revenue codes are NUBC proprietary (AHA subscription), but an informal comprehensive reference exists at https://www.findacode.com/ub04-revenue/. A static lookup table covering the major categories (~50 category ranges) is hand-buildable without the full NUBC manual.

**Implementation:** Add `revenueCode` field to `LineItem` (currently stripped as a 4-digit code). Add a deterministic mismatch check mapping expected revenue code ranges to CPT code ranges.

### 6.2 MUE Units Check

Already covered in §4. The MUE table from CMS is the correct data source. `build_mue.py` would be nearly identical to `build_ncci.py`. This is the **single highest-ROI next build script**.

### 6.3 Math / Arithmetic Validator

Check that line item amounts multiply correctly (e.g., `units × unit_price = billed_amount`) and that the sum of line items equals the bill total.

**Implementation:** Pure deterministic. After vision extraction, compute:
```
for each lineItem: if units * (amount/units) ≠ amount → arithmetic_error
total_from_lines = sum(lineItems.billedAmount)
if abs(total_from_lines - billTotal) > $0.01 → total_mismatch
```

The vision model already extracts `billedAmount` and `units` per line item. Need to also extract `unitPrice` and the bill's stated total.

### 6.4 Date Validator

For inpatient bills, service dates should fall within the admission/discharge window. For outpatient, duplicate dates of service for the same procedure are suspicious.

**Implementation:**
- Extract `admissionDate` and `dischargeDate` from the bill (add to vision prompt).
- Flag any `dateOfService` outside that window.
- For outpatient: flag same CPT code on the same date more than once (this overlaps with the duplicate billing check).

### 6.5 No Surprises Act — Good Faith Estimate Check

The No Surprises Act requires providers to give patients a Good Faith Estimate (GFE) before scheduled care. If the final bill exceeds the GFE by $400 or more, the patient can dispute it through the Independent Dispute Resolution (IDR) process.

**Implementation:**
- Add a `gfeAmount` optional input to the audit request.
- If provided: `if billedTotal > gfeAmount + 400 → no_surprises_violation finding`
- Cite the statutory reference (26 U.S.C. § 9816, 29 U.S.C. § 1185e).
- Pure deterministic once the GFE amount is known.

### 6.6 LCD/NCD Coverage Validation

Already covered in §1.3. This would be a new `errorType: 'not_covered'` finding type with citable CMS policy references.

---

## 7. Prioritised Next Steps

### Immediate (1–2 days each)

1. **Run `build_asp.py`** to regenerate `asp.json` with Q2 2026 data. URLs already updated in this commit.

2. **Add `build_mue.py`** — MUE unit cap table from CMS. Eliminates the units-based unbundling class deterministically. Near-identical to `build_ncci.py`.

3. **Fix possessive bug in `normalize_name()`** — one line change, closes ~15% of hospital name matching failures.

4. **Add synonym expansion to `normalize_name()`** — St./Saint, Mt./Mount, etc. Closes another large chunk of mismatches.

### Short-term (1 week)

5. **Add `hospitalAddress` and `hospitalPhone` to vision extraction prompt** — free improvement to matching quality.

6. **Add `rapidfuzz` fuzzy fallback** in `fetch_hospital_mrf.py` for when exact match fails.

7. **Add phone-number cross-reference** in `lookup_index_entry()`.

8. **Math validator** — pure deterministic, add `unitPrice` and `billTotal` to vision prompt, compute arithmetic check.

9. **Date validator** — add `admissionDate`/`dischargeDate` to vision prompt, flag out-of-window service dates.

### Medium-term (2–4 weeks)

10. **Hospital Outpatient PTP edits** — add to `build_ncci.py` or separate script.

11. **ICD-10 → MDM tier table** for upcoding hardening.

12. **`revenueCode` field in `LineItem`** + revenue code vs. CPT mismatch check.

13. **No Surprises Act / GFE threshold check** — simple once GFE amount is an optional input.

14. **Tool calling refactor** — restructure the audit LLM call to use function calling so each finding is grounded in a specific data lookup.

### Long-term (1–2 months)

15. **LCD/NCD build script and `icd10_coverage.json`** — transforms ICD-10 mismatch from LLM opinion to citable CMS policy.

16. **OPPS Addendum B packaging** (`opps_packaging.json`) — covers outpatient facility bundling.

17. **Google Places API integration** for hard-to-match hospitals (after Tier 1+2 matching improvements deployed).

18. **Facility behavior scoring** — requires storing bill history; longer-term feature.

---

## 8. Summary of All New Data Sources

| Data Source | URL | What It Enables | Effort |
|---|---|---|---|
| MUE Practitioner Table | cms.gov NCCI page | Units/quantity checks (deterministic) | 1 day |
| MUE Outpatient Facility Table | cms.gov NCCI page | Same, for facility claims | 1 day |
| Hospital Outpatient PTP Edits | cms.gov NCCI page | Unbundling for UB-04 claims | 1 day |
| OPPS Addendum B | cms.gov OPPS page | APC packaging/bundling for facility claims | 2 days |
| CMS LCD Database | cms.gov Coverage DB | ICD-10 mismatch (deterministic, citable) | 1–2 weeks |
| CMS NCD API | api.cms.gov/v1/ncds | Same, national-level | 2 days |
| ICD-10-CM XML (FY2026) | cms.gov ICD-10 page | MDM tier mapping for upcoding | 2–3 days |
| Revenue Code Table (NUBC) | findacode.com (informal) | Revenue code vs CPT mismatch on UB-04 | 1–2 days |
| ASP Q2 2026 | cms.gov (already updated) | Current drug pricing | Done |
