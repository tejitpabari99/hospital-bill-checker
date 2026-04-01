# Plan Three — Production Hardening Roadmap

*Author: analysis from 2026-04-01 | Target branch: `docs/part-two-explanation` (push all changes here)*

This plan converts the current hybrid LLM+deterministic audit system into a
production-grade, fully deterministic-first tool with LLM used only for
explanation. It also closes every gap identified vs FairMedBill and fixes
hospital matching reliability.

Tasks are ordered by impact-per-effort. Do them in order. Each task is
self-contained; mark it done and push before starting the next.

---

## How to Read This Plan

Each task has:
- **Goal** — what it achieves
- **Files to change** — exact paths
- **Exact steps** — no ambiguity
- **Test** — how to verify it worked
- **Definition of done** — checklist

---

## PHASE 1 — Immediate Wins (1–2 days each)

---

### Task 1 — Regenerate ASP Data (Q2 2026)

**Goal:** Update drug pricing from Q3 2025 (9 months stale) to Q2 2026.
`build_asp.py` URLs were already updated in this branch. Just run the script.

**Steps:**

```bash
cd /root/projects/hospital-bill-checker
python3 scripts/build_asp.py
```

Expected output: `Wrote N rates to src/lib/data/asp.json`

**Verify:**

```bash
# Should show a recent payment limit for a common J-code
python3 -c "import json; d=json.load(open('src/lib/data/asp.json')); print(d.get('J0696'), d.get('J9035'))"
```

**Definition of done:**
- [ ] `src/lib/data/asp.json` regenerated with ≥ 800 entries
- [ ] File timestamp is today
- [ ] Commit: `"regen: update asp.json to Q2 2026"`

---

### Task 2 — Fix Hospital Name Matching: Possessive Bug + Synonym Expansion

**Goal:** Fix a known bug where "Children's Hospital" doesn't match
"Childrens Hospital" (apostrophe becomes a space). Also add synonym
expansion for St./Saint, Mt./Mount, etc.

**File to change:** `scripts/fetch_hospital_mrf.py`

**Current `normalize_name` (line 44–50):**

```python
def normalize_name(name: str) -> str:
    name = name.lower()
    name = unicodedata.normalize("NFKD", name)
    name = name.encode("ascii", "ignore").decode("ascii")
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name
```

**Replace with:**

```python
# Synonyms applied before normalization (both query and index keys use this)
_SYNONYMS = [
    (r"\bst\b\.?\s+", "saint "),      # St. Mary / St Mary → saint mary
    (r"\bmt\b\.?\s+", "mount "),      # Mt. Sinai / Mt Sinai → mount sinai
    (r"\bmem\b\.?\s+", "memorial "),  # Mem Hospital → memorial hospital
    (r"\bmed\s+ctr\b", "medical center"),
    (r"\bhosp\b", "hospital"),
    (r"\buniv\b\.?\s+", "university "),
    (r"\bdr\b\.?\s+", "doctor "),
]

def normalize_name(name: str) -> str:
    name = name.lower()
    # Fix possessives BEFORE stripping punctuation so "children's" → "childrens"
    # (not "children s" which never matches)
    name = re.sub(r"'s\b", "s", name)   # children's → childrens
    name = re.sub(r"'\b", "", name)      # any remaining apostrophe → gone
    # Apply synonyms
    for pattern, replacement in _SYNONYMS:
        name = re.sub(pattern, replacement, name)
    name = unicodedata.normalize("NFKD", name)
    name = name.encode("ascii", "ignore").decode("ascii")
    name = re.sub(r"[^a-z0-9 ]", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name
```

**Also apply the same synonyms in `build_hospital_index.py`** — the index
keys must be built with the same normalization, otherwise the lookup will
never match. Find `normalize_name` in `scripts/build_hospital_index.py` and
apply the identical change.

**Test:**

```python
# Quick sanity check — run in a Python REPL inside the scripts/ dir
from fetch_hospital_mrf import normalize_name
assert normalize_name("Children's Hospital of Philadelphia") == "childrens hospital of philadelphia"
assert normalize_name("St. Mary's Medical Center") == "saint marys medical center"
assert normalize_name("Mt. Sinai Hospital") == "mount sinai hospital"
print("All OK")
```

**After fixing, rebuild the hospital index:**

```bash
python3 scripts/build_hospital_index.py
```

**Definition of done:**
- [ ] Both Python files updated with identical `normalize_name`
- [ ] Hospital index rebuilt
- [ ] Sanity check passes
- [ ] Commit: `"fix: hospital name possessive bug + synonym expansion"`

---

### Task 3 — Add Fuzzy Hospital Matching Fallback

**Goal:** When exact normalised match fails, fall back to fuzzy matching
using `rapidfuzz`. This closes ~60% of hospital name mismatches.

**Install dependency:**

```bash
pip install rapidfuzz
```

Add to whatever `requirements.txt` or similar the project uses (check if
one exists; if not, create `scripts/requirements.txt` with `rapidfuzz>=3.0`).

**File to change:** `scripts/fetch_hospital_mrf.py`

Find the `lookup_index_entry` function. Add a fuzzy fallback after the exact
match block. The function currently returns `None` if no exact match is found.
Change it to:

```python
from rapidfuzz import fuzz, process as fuzz_process

def lookup_index_entry(
    name: str,
    state: str,
    index: dict,
) -> dict | None:
    norm = normalize_name(name)

    # 1. Exact match with state
    if state:
        entry = index.get(f"{norm}|{state.lower()}")
        if entry:
            return entry

    # 2. Exact match any state
    matches = [v for k, v in index.items() if k.startswith(f"{norm}|")]
    if matches:
        return matches[0]

    # 3. Fuzzy match — filter to same state first, fall back to all
    candidates = (
        [(k, v) for k, v in index.items() if k.endswith(f"|{state.lower()}")]
        if state else list(index.items())
    )
    if not candidates:
        return None

    keys = [k for k, _ in candidates]
    # Compare norm against just the name portion of each key (strip "|state")
    key_names = [k.rsplit("|", 1)[0] for k in keys]
    result = fuzz_process.extractOne(
        norm,
        key_names,
        scorer=fuzz.token_set_ratio,
        score_cutoff=85,     # 0–100; 85 = strong match required
    )
    if result:
        matched_name, score, idx = result
        return candidates[idx][1]

    # 4. Fuzzy match nationally if state-scoped failed
    if state and candidates:
        all_candidates = list(index.items())
        all_key_names = [k.rsplit("|", 1)[0] for k, _ in all_candidates]
        result = fuzz_process.extractOne(
            norm,
            all_key_names,
            scorer=fuzz.token_set_ratio,
            score_cutoff=88,  # slightly higher threshold nationally
        )
        if result:
            matched_name, score, idx = result
            return all_candidates[idx][1]

    return None
```

**Test:**

```bash
# Test with a known hospital that uses St. abbreviation
python3 scripts/fetch_hospital_mrf.py "St. Marys Medical Center" WV --dry-run
# Should print the matched index entry, not "not found"
```

(If `--dry-run` flag doesn't exist yet, just check the lookup returns something
by adding a `print(lookup_index_entry(...))` call temporarily.)

**Definition of done:**
- [ ] `rapidfuzz` installed and in requirements
- [ ] `lookup_index_entry` has fuzzy fallback
- [ ] Tested with at least 3 name variations that previously failed
- [ ] Commit: `"feat: fuzzy hospital name matching with rapidfuzz"`

---

### Task 4 — Extract Hospital Phone + Address from Vision Prompt

**Goal:** Extract `hospitalPhone` and `hospitalAddress` from the bill in the
vision step. This enables phone-based matching (most reliable) and address-
based disambiguation at zero extra API cost.

**File to change:** `src/lib/server/vision-extract.mjs`

In the `generateContent` call, find the prompt text block (starting with
`"Extract billing information from this hospital bill..."`). Add two fields
to the requested JSON schema:

```javascript
// In the prompt text, change the JSON schema from:
{
  "rawText": "...",
  "cptCodes": [...],
  "hospitalName": "hospital name or null",
  "accountNumber": "...",
  ...
}

// To:
{
  "rawText": "...",
  "cptCodes": [...],
  "hospitalName": "hospital name or null",
  "hospitalAddress": "full address printed on bill header, e.g. '123 Main St, Dallas, TX 75201', or null",
  "hospitalPhone": "hospital phone number as printed, e.g. '(214) 555-1234', or null",
  "accountNumber": "...",
  ...
}
```

Add a note to the prompt:
```
The hospital address and phone number almost always appear in the header/letterhead of the bill. Extract them exactly as printed.
```

**File to change:** `src/routes/api/parse/+server.ts`

Find where the vision extraction result is mapped to `BillInput`. After
extracting `hospitalName`, also pass through `hospitalAddress` and
`hospitalPhone` into the returned object (you may need to add these fields
to `BillInput` in `src/lib/types.ts`).

**File to change:** `src/lib/types.ts`

Add to `BillInput`:
```typescript
export interface BillInput {
  lineItems: LineItem[]
  rawText?: string
  hospitalName?: string
  hospitalAddress?: string   // ADD THIS
  hospitalPhone?: string     // ADD THIS
  hospitalNpi?: string
  accountNumber?: string
  dateOfService?: string
  patientName?: string
}
```

**File to change:** `src/lib/server/claude.ts`

In `auditBill`, the hospital lookup currently extracts state from the hospital
name string using the fragile `extractStateFromHospitalName` regex. Update
it to prefer `input.hospitalAddress` and `input.hospitalPhone`:

```typescript
// Replace the existing state extraction block:
const hospitalName = input.hospitalName ?? call1Result.extractedMeta?.hospitalName ?? ''
const state = extractStateFromHospitalName(hospitalName)

// With:
const hospitalName = input.hospitalName ?? call1Result.extractedMeta?.hospitalName ?? ''
// Prefer state from address if available (more reliable)
const stateFromAddress = input.hospitalAddress
  ? extractStateFromHospitalName(input.hospitalAddress)
  : ''
const state = stateFromAddress || extractStateFromHospitalName(hospitalName)
const hospitalPhone = input.hospitalPhone ?? null
```

Then pass `hospitalPhone` to `lookupHospitalPrices` (see Task 5).

**Definition of done:**
- [ ] Vision prompt extracts `hospitalAddress` and `hospitalPhone`
- [ ] `BillInput` type updated
- [ ] State extracted from address preferentially
- [ ] Commit: `"feat: extract hospital address and phone from vision"`

---

### Task 5 — Phone-Number Hospital Matching

**Goal:** Match hospitals by phone number — the most reliable method, since
every bill prints the hospital phone and the CMS index stores it.

**File to change:** `scripts/fetch_hospital_mrf.py`

Add a phone-based lookup function:

```python
import re

def normalize_phone(phone: str) -> str:
    """Strip all non-digits, return last 10 digits."""
    digits = re.sub(r"\D", "", phone)
    return digits[-10:] if len(digits) >= 10 else digits

def lookup_by_phone(phone: str, index: dict) -> dict | None:
    """Find hospital by phone number. Returns first match or None."""
    if not phone:
        return None
    norm_phone = normalize_phone(phone)
    if len(norm_phone) < 10:
        return None
    for entry in index.values():
        if isinstance(entry, dict):
            idx_phone = normalize_phone(entry.get("phone", "") or "")
            if idx_phone and idx_phone == norm_phone:
                return entry
    return None
```

Update `lookup_index_entry` to try phone lookup first when a phone number
is provided:

```python
def lookup_index_entry(name, state, index, phone=None):
    # 0. Phone lookup (most reliable)
    if phone:
        entry = lookup_by_phone(phone, index)
        if entry:
            return entry
    # ... rest of existing exact + fuzzy logic
```

**File to change:** `src/lib/server/hospital-prices.ts`

Find where the Python script is called (the `spawn` call). Pass the phone
number as an additional argument:

```typescript
// Add hospitalPhone as an optional parameter to lookupHospitalPrices:
export async function lookupHospitalPrices(
  hospitalName: string,
  state: string,
  cptCodes: string[],
  hospitalPhone?: string    // ADD
): Promise<HospitalPriceResult | null>

// Then pass it to the Python subprocess:
const args = [scriptPath, hospitalName, state, '--codes', ...cptCodes]
if (hospitalPhone) args.push('--phone', hospitalPhone)
```

**File to change:** `scripts/fetch_hospital_mrf.py`

Add `--phone` to the argparse definition and use it in the main lookup call.

**Definition of done:**
- [ ] `normalize_phone` and `lookup_by_phone` added to fetch script
- [ ] Phone passed from TS to Python subprocess
- [ ] Phone lookup happens before name fuzzy matching
- [ ] Commit: `"feat: phone-number hospital matching"`

---

## PHASE 2 — New Deterministic Check Data (1 day each)

---

### Task 6 — Add MUE (Medically Unlikely Edits) — Units Check

**Goal:** Deterministically detect when a CPT code is billed for more units
than CMS considers medically plausible. This replaces LLM guessing with a
CMS-published per-code unit cap.

**Background:** MUEs are separate from NCCI PTP edits. They are per-code
maximum unit limits per beneficiary per date of service. For example,
CPT 99215 has an MUE of 1 — billing it 3 times in one day is automatically
flagged.

**Step 1 — Build `mue.json`**

Create `scripts/build_mue.py`. Model it after `build_ncci.py`.

Download URL for Q2 2026 Practitioner MUEs:
```
https://www.cms.gov/files/zip/january-2021-practitioner-mue-table.zip
```
**Important:** CMS MUE URLs change each quarter. Go to:
`https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues`
and find the current "Practitioner Services" download link. Use that URL.

The MUE Excel file has columns:
- `HCPCS/CPT Code` — the code
- `Practitioner Services MUE Values` — the max units
- `Practitioner Services MUE Adjudication Indicator` — `1` = claim line, `3` = date of service

Output format for `src/lib/data/mue.json`:
```json
{
  "99215": { "maxUnits": 1, "adjudicationType": "date_of_service" },
  "36415": { "maxUnits": 3, "adjudicationType": "claim_line" },
  ...
}
```

Only include adjudication type `3` (date of service) entries — those are the
hard caps. Type `1` (claim line) entries can be legitimately split across
lines.

```python
#!/usr/bin/env python3
"""Build CMS MUE (Medically Unlikely Edits) lookup JSON."""
import json, zipfile, io, urllib.request, sys
from pathlib import Path
import openpyxl  # pip install openpyxl

OUTPUT_PATH = Path(__file__).parent.parent / "src" / "lib" / "data" / "mue.json"

MUE_URL = "https://www.cms.gov/files/zip/PASTE_CURRENT_QUARTER_URL_HERE.zip"

def build_mue(zip_bytes: bytes) -> dict:
    mue = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        xlsx_name = next(n for n in zf.namelist() if n.endswith('.xlsx'))
        wb = openpyxl.load_workbook(io.BytesIO(zf.read(xlsx_name)), read_only=True, data_only=True)
        ws = wb.active
        headers = None
        for row in ws.iter_rows(values_only=True):
            if headers is None:
                headers = [str(c or '').strip().lower() for c in row]
                continue
            if not row or not row[0]:
                continue
            code = str(row[0]).strip().upper()
            max_units = row[1]
            adj_type = str(row[2] or '').strip() if len(row) > 2 else ''
            if not code or not max_units:
                continue
            try:
                max_units = int(max_units)
            except (ValueError, TypeError):
                continue
            mue[code] = {
                "maxUnits": max_units,
                "adjudicationType": "date_of_service" if adj_type == '3' else "claim_line"
            }
    return mue

if __name__ == '__main__':
    url = sys.argv[1] if len(sys.argv) > 1 else MUE_URL
    print(f"Downloading MUE from {url}...")
    data = urllib.request.urlopen(url).read()
    mue = build_mue(data)
    OUTPUT_PATH.write_text(json.dumps(mue, separators=(',', ':')))
    print(f"Wrote {len(mue)} entries to {OUTPUT_PATH}")
```

**Step 2 — Add MUE types to TypeScript**

In `src/lib/server/audit-rules.ts`, add:

```typescript
export type MueEntry = { maxUnits: number; adjudicationType: 'date_of_service' | 'claim_line' }
export type MueData = Record<string, MueEntry>
```

**Step 3 — Add MUE check to `buildDeterministicFindings`**

In `src/lib/server/audit-rules.ts`, add a new parameter `mue: MueData = {}`
to `buildDeterministicFindings`. Add a new check block after the existing
duplicate billing check:

```typescript
// 4. MUE units check — deterministic
// Group units billed per code on this bill (date of service = all items here)
const codeTotalUnits = new Map<string, number>()
for (let i = 0; i < lineItems.length; i++) {
  const code = codes[i]
  codeTotalUnits.set(code, (codeTotalUnits.get(code) ?? 0) + (lineItems[i].units || 1))
}
for (const [code, totalUnits] of codeTotalUnits) {
  const mueEntry = mue[code]
  if (!mueEntry) continue
  if (mueEntry.adjudicationType !== 'date_of_service') continue
  if (totalUnits <= mueEntry.maxUnits) continue
  // Flag all line items for this code
  const indexes = (codeIndexes.get(code) ?? [])
  for (const idx of indexes) {
    findings.push({
      lineItemIndex: idx,
      cptCode: code,
      severity: 'error',
      errorType: 'unbundling',
      confidence: 'high' as ConfidenceLevel,
      description: `CPT ${code} billed ${totalUnits} unit(s), but CMS Medically Unlikely Edits cap this at ${mueEntry.maxUnits} unit(s) per day. Billing ${totalUnits} units on a single date of service is not medically plausible.`,
      standardDescription: CPT_DESCRIPTIONS[code],
      recommendation: `Request itemized documentation justifying ${totalUnits} units. CMS MUE limit is ${mueEntry.maxUnits} unit(s) per date of service.`,
      medicareRate: getEffectiveRate(code),
      markupRatio: undefined,
      ncciBundledWith: undefined,
    })
  }
}
```

**Step 4 — Load MUE data in `claude.ts`**

Add alongside the other static imports:
```typescript
let mue: MueData = {}
try { mue = (await import('$lib/data/mue.json', { assert: { type: 'json' } })).default } catch {}
```

Pass `mue` through `buildDeterministicFindings`.

**Definition of done:**
- [ ] `scripts/build_mue.py` created and runs successfully
- [ ] `src/lib/data/mue.json` generated with ≥ 5,000 entries
- [ ] `MueData` type added to `audit-rules.ts`
- [ ] MUE check added to `buildDeterministicFindings`
- [ ] `mue.json` loaded in `claude.ts`
- [ ] Existing tests pass
- [ ] Commit: `"feat: MUE units check — deterministic CMS unit cap enforcement"`

---

### Task 7 — Add Math / Arithmetic Validator

**Goal:** Detect arithmetic errors on the bill — a FairMedBill "Guardian" we
are missing. Pure deterministic logic, no data download needed.

**File to change:** `src/lib/server/vision-extract.mjs`

Add `billTotal` to the extracted JSON schema:

```javascript
"billTotal": 1234.56,  // total amount due as printed on the bill, or null
```

**File to change:** `src/lib/types.ts`

Add to `BillInput`:
```typescript
billTotal?: number   // extracted total from bill
```

Add new error type to `AuditFinding.errorType`:
```typescript
errorType: 'upcoding' | 'unbundling' | 'pharmacy_markup' | 'icd10_mismatch'
         | 'duplicate' | 'above_hospital_list_price' | 'arithmetic_error' | 'other'
```

**File to change:** `src/lib/server/audit-rules.ts`

Add a new exported function (call it from `claude.ts` after other deterministic
checks):

```typescript
export function buildArithmeticFindings(
  lineItems: LineItem[],
  billTotal?: number
): AuditFinding[] {
  const findings: AuditFinding[] = []
  const lineSum = lineItems.reduce((s, li) => s + (li.billedAmount || 0), 0)

  // Check bill total vs sum of line items
  if (billTotal != null && billTotal > 0) {
    const diff = Math.abs(lineSum - billTotal)
    if (diff > 0.50) {  // allow 50 cent rounding tolerance
      findings.push({
        lineItemIndex: -1,  // bill-level finding, not tied to a specific line
        cptCode: 'TOTAL',
        severity: 'error',
        errorType: 'arithmetic_error',
        confidence: 'high',
        description: `The sum of all line items ($${lineSum.toFixed(2)}) does not match the bill total ($${billTotal.toFixed(2)}). The difference is $${diff.toFixed(2)}.`,
        standardDescription: 'Bill arithmetic error',
        recommendation: 'Request a corrected itemized statement explaining the discrepancy between individual charges and the stated total.',
        medicareRate: undefined,
        markupRatio: undefined,
        ncciBundledWith: undefined,
      })
    }
  }

  return findings
}
```

Note: `lineItemIndex: -1` is a new convention for bill-level findings. Update
the frontend `LineItemCard.svelte` to handle `lineItemIndex === -1` gracefully
(show it as a summary-level finding, not linked to a specific line).

**Definition of done:**
- [ ] Vision prompt extracts `billTotal`
- [ ] `arithmetic_error` error type added
- [ ] `buildArithmeticFindings` added and called in `claude.ts`
- [ ] Frontend handles `lineItemIndex: -1`
- [ ] Commit: `"feat: arithmetic error check — bill total vs line item sum"`

---

### Task 8 — Add Date Validator

**Goal:** Flag service dates outside the patient's stay window, and same-
service-same-date duplicates missed by the existing duplicate check
(which only deduplicates by code, not code+date).

**File to change:** `src/lib/server/vision-extract.mjs`

Add to extracted schema:
```javascript
"admissionDate": "2024-01-14 or null",   // inpatient only
"dischargeDate": "2024-01-16 or null",   // inpatient only
```

Add to prompt: `"admissionDate and dischargeDate are only relevant for inpatient hospital bills. For outpatient bills, set both to null."`

**File to change:** `src/lib/types.ts`

Add to `BillInput`:
```typescript
admissionDate?: string
dischargeDate?: string
```

Add `'date_error'` to `AuditFinding.errorType`.

**File to change:** `src/lib/server/audit-rules.ts`

Add new exported function:

```typescript
export function buildDateFindings(
  lineItems: LineItem[],
  admissionDate?: string,
  dischargeDate?: string
): AuditFinding[] {
  const findings: AuditFinding[] = []

  // Only check dates if we have a stay window
  if (admissionDate && dischargeDate) {
    const admit = new Date(admissionDate)
    const discharge = new Date(dischargeDate)
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i]
      if (!li.serviceDate) continue
      const svcDate = new Date(li.serviceDate)
      if (svcDate < admit || svcDate > discharge) {
        findings.push({
          lineItemIndex: i,
          cptCode: li.cpt,
          severity: 'warning',
          errorType: 'date_error' as AuditFinding['errorType'],
          confidence: 'high',
          description: `CPT ${li.cpt} has a service date of ${li.serviceDate}, which is outside your admission window (${admissionDate} – ${dischargeDate}).`,
          standardDescription: CPT_DESCRIPTIONS[li.cpt],
          recommendation: 'Request an explanation for why this service was billed outside your stay dates. This may be a data entry error.',
          medicareRate: undefined,
          markupRatio: undefined,
          ncciBundledWith: undefined,
        })
      }
    }
  }

  return findings
}
```

**Definition of done:**
- [ ] Vision prompt extracts `admissionDate` and `dischargeDate`
- [ ] `date_error` type added
- [ ] `buildDateFindings` added and called in `claude.ts`
- [ ] Commit: `"feat: date validator — flag charges outside stay window"`

---

### Task 9 — No Surprises Act / GFE Check

**Goal:** If the user had a Good Faith Estimate (GFE) and the final bill
exceeds it by $400+, flag it. This is a FairMedBill "Guardian" we are
missing. Pure deterministic logic.

**File to change:** `src/lib/types.ts`

Add to `BillInput`:
```typescript
goodFaithEstimate?: number   // GFE total, if the user has it
```

Add `'no_surprises_act'` to `AuditFinding.errorType`.

**File to change:** `src/routes/+page.svelte` (the upload form)

Add an optional input field: "Did you receive a Good Faith Estimate? Enter
the total amount (optional)." Map it to `goodFaithEstimate` in the request
body.

**File to change:** `src/lib/server/audit-rules.ts`

Add:

```typescript
export function buildGfeFindings(
  lineItems: LineItem[],
  gfe?: number
): AuditFinding[] {
  if (!gfe || gfe <= 0) return []
  const totalBilled = lineItems.reduce((s, li) => s + li.billedAmount, 0)
  const excess = totalBilled - gfe
  if (excess < 400) return []

  return [{
    lineItemIndex: -1,
    cptCode: 'GFE',
    severity: 'error',
    errorType: 'no_surprises_act' as AuditFinding['errorType'],
    confidence: 'high',
    description: `Your total bill ($${totalBilled.toFixed(2)}) exceeds your Good Faith Estimate ($${gfe.toFixed(2)}) by $${excess.toFixed(2)}, which is above the $400 threshold under the No Surprises Act.`,
    standardDescription: 'No Surprises Act — Good Faith Estimate violation',
    recommendation: 'You have the right to dispute this through CMS Patient-Provider Dispute Resolution. Submit a dispute at cms.gov/medical-bill-rights within 120 days of receiving the bill. Cite 26 U.S.C. § 9816 and 29 U.S.C. § 1185e.',
    medicareRate: undefined,
    markupRatio: undefined,
    ncciBundledWith: undefined,
  }]
}
```

**Definition of done:**
- [ ] `goodFaithEstimate` field in `BillInput`
- [ ] Optional GFE input on upload page
- [ ] `buildGfeFindings` added and called in `claude.ts`
- [ ] Commit: `"feat: No Surprises Act GFE threshold check"`

---

## PHASE 3 — Deterministic LLM Check Hardening (2–4 days)

---

### Task 10 — Upcoding: E&M Level Deterministic Pre-Filter

**Goal:** Convert upcoding detection from pure LLM to a deterministic check
that maps ICD-10 diagnoses to maximum plausible E&M complexity levels.

**Step 1 — Create `src/lib/data/em_mdm_tiers.json`**

This is a hand-authored file. Create it with the following structure:

```json
{
  "_comment": "ICD-10 three-digit category prefix → maximum plausible MDM tier for E&M coding",
  "_tiers": { "S": "straightforward", "L": "low", "M": "moderate", "H": "high" },

  "Z00": "S", "Z02": "S", "Z23": "S",
  "J00": "S", "J06": "S", "J20": "S", "J30": "S",
  "K59": "S", "L01": "S", "L02": "S",
  "S00": "L", "S10": "L", "S20": "L", "S30": "L",
  "J18": "M", "J15": "M",
  "E11": "M", "E10": "M", "E13": "M",
  "I10": "M", "I25": "M", "I48": "M",
  "M17": "M", "M16": "M", "M54": "L",
  "I21": "H", "I22": "H", "I60": "H", "I61": "H", "I63": "H",
  "C34": "H", "C50": "H", "C18": "H",
  "J96": "H", "N17": "H", "A41": "H",
  "R09": "H", "R55": "L", "R07": "M"
}
```

This file only needs ~200 high-frequency ICD-10 prefixes. The check has a
built-in fallback — if the ICD-10 prefix isn't in the table, the check is
skipped (no false positive).

**Step 2 — Create E&M level map from MPFS descriptions**

In `src/lib/server/audit-rules.ts`, add a constant mapping each E&M code to
its MDM tier (derived from MPFS description abbreviations):

```typescript
// E&M codes and their required MDM tier per 2021 AMA guidelines
// sf=straightforward, low=low, mod=moderate, hi=high
export const EM_MDM_LEVELS: Record<string, 'S' | 'L' | 'M' | 'H'> = {
  // New patient office visits
  '99202': 'S', '99203': 'L', '99204': 'M', '99205': 'H',
  // Established patient office visits
  '99211': 'S', '99212': 'S', '99213': 'L', '99214': 'M', '99215': 'H',
  // Emergency department
  '99281': 'S', '99282': 'S', '99283': 'L', '99284': 'M', '99285': 'H',
  // Hospital observation/inpatient
  '99221': 'L', '99222': 'M', '99223': 'H',
  '99231': 'L', '99232': 'M', '99233': 'H',
  // Nursing facility
  '99304': 'L', '99305': 'M', '99306': 'H',
}
```

**Step 3 — Add upcoding pre-check to `buildDeterministicFindings`**

```typescript
// 5. E&M upcoding — deterministic pre-filter
for (let i = 0; i < lineItems.length; i++) {
  const code = codes[i]
  const emTier = EM_MDM_LEVELS[code]
  if (!emTier) continue  // not an E&M code

  const icd10s = lineItems[i].icd10Codes ?? []
  if (icd10s.length === 0) continue  // no diagnoses — can't determine

  // Find the max plausible MDM tier supported by any ICD-10 on this line item
  const TIER_RANK = { S: 0, L: 1, M: 2, H: 3 }
  let maxIcdTier: 'S' | 'L' | 'M' | 'H' = 'S'
  for (const icd of icd10s) {
    const prefix = icd.substring(0, 3)  // first 3 chars = category
    const icdTier = (emMdmTiers[prefix] ?? null) as 'S'|'L'|'M'|'H'|null
    if (icdTier && TIER_RANK[icdTier] > TIER_RANK[maxIcdTier]) {
      maxIcdTier = icdTier
    }
  }

  // Only flag if billed tier is 2+ levels above max supported ICD-10 tier
  // (1 level gap is too common — clinical context we can't see could justify it)
  if (TIER_RANK[emTier] - TIER_RANK[maxIcdTier] < 2) continue

  const TIER_NAMES = { S: 'straightforward', L: 'low complexity', M: 'moderate complexity', H: 'high complexity' }
  findings.push({
    lineItemIndex: i,
    cptCode: code,
    severity: 'warning',
    errorType: 'upcoding',
    confidence: 'medium' as ConfidenceLevel,
    description: `CPT ${code} requires ${TIER_NAMES[emTier]} medical decision-making, but the diagnosis codes on this bill (${icd10s.join(', ')}) suggest at most ${TIER_NAMES[maxIcdTier]} MDM. This may be worth questioning.`,
    standardDescription: CPT_DESCRIPTIONS[code],
    recommendation: 'Request the clinical notes supporting this E&M level. Ask billing to explain why the documentation justifies this complexity tier per AMA 2021 E&M guidelines.',
    medicareRate: getEffectiveRate(code),
    markupRatio: undefined,
    ncciBundledWith: undefined,
  })
}
```

**Note:** Pass `emMdmTiers` as a parameter to `buildDeterministicFindings`
alongside the other data parameters. Load it in `claude.ts` from
`$lib/data/em_mdm_tiers.json`.

**Definition of done:**
- [ ] `src/lib/data/em_mdm_tiers.json` created with ≥ 50 ICD-10 prefixes
- [ ] `EM_MDM_LEVELS` constant added to `audit-rules.ts`
- [ ] Upcoding pre-check added to `buildDeterministicFindings`
- [ ] `em_mdm_tiers.json` loaded in `claude.ts`
- [ ] Commit: `"feat: deterministic E&M upcoding pre-filter via ICD-10 MDM tiers"`

---

### Task 11 — Add Hospital Outpatient PTP Edits

**Goal:** The current NCCI PTP table only covers professional (physician)
claims. Hospital facility (UB-04) claims use a separate outpatient PTP
table. Add it as a second lookup.

**Step 1 — Update `build_ncci.py`**

Add a new source group for hospital outpatient PTP edits. Find the
`SOURCE_GROUPS` list and add:

```python
{
    "name": "CMS Medicare NCCI PTP 2026 Q2 Hospital Outpatient",
    "urls": [
        # Go to: https://www.cms.gov/medicare/coding-billing/ncci-edits/medicare-ncci-procedure-procedure-ptp-edits
        # Find "Hospital Outpatient Services" section, copy Q2 2026 zip URLs
        # Pattern: medicare-ncci-2026q2-hospital-outpatient-ptp-edits-ccihcfa-v321r0-f1.zip
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-outpatient-ptp-edits-ccihcfa-v321r0-f1.zip",
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-outpatient-ptp-edits-ccihcfa-v321r0-f2.zip",
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-outpatient-ptp-edits-ccihcfa-v321r0-f3.zip",
        "https://www.cms.gov/files/zip/medicare-ncci-2026q2-hospital-outpatient-ptp-edits-ccihcfa-v321r0-f4.zip",
    ],
    "output_suffix": "_outpatient",  # merge into main ncci.json but track source
},
```

**Important:** Verify the exact URLs by visiting the CMS NCCI page. The
hospital outpatient filenames use `ccihcfa` in the name instead of `ccipra`.

**Step 2 — Merge outpatient edits into `ncci.json`**

The existing merge logic in `build_ncci.py` already handles multiple source
groups. The outpatient edits will be merged into the same `ncci.json` output,
which means the same deterministic check in `audit-rules.ts` will automatically
cover both professional and outpatient claims.

**Definition of done:**
- [ ] Hospital outpatient PTP URLs verified and added to `build_ncci.py`
- [ ] `python3 scripts/build_ncci.py` runs successfully (use cached zip to avoid download)
- [ ] `ncci.json` has a materially higher entry count than before
- [ ] Commit: `"feat: add hospital outpatient PTP edits to NCCI data"`

---

## PHASE 4 — ICD-10 Coverage Validation (1–2 weeks)

This is the most valuable long-term change. It converts the ICD-10 mismatch
check from a low-confidence LLM guess into a citable CMS policy reference.

---

### Task 12 — Build LCD/NCD Coverage Table

**Goal:** Parse CMS Local Coverage Determinations to build a
`CPT → covered ICD-10 set` lookup. When a bill's ICD-10 codes don't appear
in the covered set for that CPT, flag it with the LCD number.

**Step 1 — Download LCD database**

CMS provides a downloadable ZIP at:
`https://www.cms.gov/medicare-coverage-database/downloads/downloadable-databases.aspx`

The "LCD/NCD Downloadable Database" contains Microsoft Access MDB files. To
parse MDB without Microsoft Access, use `mdbtools` (Linux) or convert to CSV.

**Alternative — Use the CMS MCD API (recommended, simpler):**

```
GET https://www.cms.gov/medicare-coverage-database/api/articles?lcd=true&page=1&pageSize=100
```

For each LCD, fetch its detail including the ICD-10 code list:
```
GET https://www.cms.gov/medicare-coverage-database/api/articles/{lcd_id}
```

The response includes `"icdCodes"` arrays with coverage status.

Create `scripts/build_lcd.py`:

```python
#!/usr/bin/env python3
"""
Build CMS LCD coverage table: CPT → { covered: [ICD10...], notCovered: [ICD10...], lcdId, lcdTitle }

Uses CMS Medicare Coverage Database API.
Output: src/lib/data/lcd_coverage.json
"""
import json, time, urllib.request
from pathlib import Path
from collections import defaultdict

OUTPUT_PATH = Path(__file__).parent.parent / "src" / "lib" / "data" / "lcd_coverage.json"
BASE_URL = "https://www.cms.gov/medicare-coverage-database/api"

def fetch_json(url):
    time.sleep(0.5)  # be polite to CMS API
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read())

def build_lcd_coverage():
    coverage = defaultdict(lambda: {
        "covered": set(), "notCovered": set(), "lcdIds": []
    })

    page = 1
    while True:
        data = fetch_json(f"{BASE_URL}/articles?lcd=true&page={page}&pageSize=50")
        articles = data.get("results", [])
        if not articles:
            break

        for article in articles:
            lcd_id = article.get("id")
            if not lcd_id:
                continue
            detail = fetch_json(f"{BASE_URL}/articles/{lcd_id}")

            # Extract CPT codes this LCD covers
            cpt_codes = [
                c["code"] for c in detail.get("billingCodes", [])
                if c.get("codeType") in ("CPT", "HCPCS")
            ]
            # Extract covered ICD-10 codes
            covered_icds = [
                c["code"] for c in detail.get("icdCodes", [])
                if c.get("covered") is True
            ]
            not_covered_icds = [
                c["code"] for c in detail.get("icdCodes", [])
                if c.get("covered") is False
            ]

            for cpt in cpt_codes:
                coverage[cpt]["covered"].update(covered_icds)
                coverage[cpt]["notCovered"].update(not_covered_icds)
                if lcd_id not in coverage[cpt]["lcdIds"]:
                    coverage[cpt]["lcdIds"].append(lcd_id)

        print(f"  Page {page}: {len(articles)} LCDs processed")
        page += 1

    # Convert sets to sorted lists for JSON serialization
    return {
        cpt: {
            "covered": sorted(v["covered"]),
            "notCovered": sorted(v["notCovered"]),
            "lcdIds": v["lcdIds"]
        }
        for cpt, v in coverage.items()
    }

if __name__ == '__main__':
    print("Building LCD coverage table...")
    data = build_lcd_coverage()
    OUTPUT_PATH.write_text(json.dumps(data, separators=(',', ':')))
    print(f"Wrote coverage for {len(data)} CPT codes to {OUTPUT_PATH}")
```

**Note:** This script hits the CMS API repeatedly. Run it once, cache the
output. Re-run quarterly or when LCDs are updated.

**Step 2 — Add LCD check to `buildDeterministicFindings`**

```typescript
export type LcdCoverageEntry = {
  covered: string[]
  notCovered: string[]
  lcdIds: string[]
}
export type LcdCoverageData = Record<string, LcdCoverageEntry>
```

Add to the deterministic findings function:

```typescript
// 6. LCD/NCD coverage check
for (let i = 0; i < lineItems.length; i++) {
  const code = codes[i]
  const lcdEntry = lcdCoverage[code]
  if (!lcdEntry || lcdEntry.covered.length === 0) continue  // no LCD for this code

  const icd10s = lineItems[i].icd10Codes ?? []
  if (icd10s.length === 0) continue  // can't check without diagnoses

  // Check if any billed ICD-10 is in the covered list
  const hasCoveredDx = icd10s.some(icd =>
    lcdEntry.covered.some(covered => icd.startsWith(covered))  // prefix match
  )
  // Check if any billed ICD-10 is explicitly not covered
  const hasExcludedDx = icd10s.some(icd =>
    lcdEntry.notCovered.some(excluded => icd.startsWith(excluded))
  )

  if (hasCoveredDx) continue  // covered diagnosis present — no finding

  const lcdRef = lcdEntry.lcdIds.slice(0, 2).join(', ')
  findings.push({
    lineItemIndex: i,
    cptCode: code,
    severity: hasExcludedDx ? 'error' : 'warning',
    errorType: 'icd10_mismatch',
    confidence: hasExcludedDx ? 'high' : 'medium' as ConfidenceLevel,
    description: `CPT ${code} may not be covered for the diagnosis codes on this bill (${icd10s.join(', ')}). Per CMS LCD ${lcdRef}, this procedure requires specific qualifying diagnoses that are not present on the bill.`,
    standardDescription: CPT_DESCRIPTIONS[code],
    recommendation: `Request documentation showing medical necessity for CPT ${code}. The CMS LCD (${lcdRef}) specifies which diagnoses qualify this procedure for coverage. If your diagnosis is not listed, ask billing to explain or correct the diagnosis codes.`,
    medicareRate: getEffectiveRate(code),
    markupRatio: undefined,
    ncciBundledWith: undefined,
  })
}
```

**Step 3 — Load in `claude.ts`**

```typescript
let lcdCoverage: LcdCoverageData = {}
try { lcdCoverage = (await import('$lib/data/lcd_coverage.json', { assert: { type: 'json' } })).default } catch {}
```

**Definition of done:**
- [ ] `scripts/build_lcd.py` created and runs without error
- [ ] `src/lib/data/lcd_coverage.json` generated with ≥ 500 CPT code entries
- [ ] `LcdCoverageData` type added
- [ ] LCD check added to deterministic findings (after MUE check)
- [ ] `lcd_coverage.json` loaded in `claude.ts`
- [ ] Commit: `"feat: CMS LCD/NCD ICD-10 coverage check — deterministic icd10_mismatch"`

---

## PHASE 5 — Tool Calling Refactor (3–4 days)

---

### Task 13 — Refactor LLM to Use Tool Calling

**Goal:** Change the audit LLM call from a monolithic prompt to a function-
calling model where the LLM calls structured tools to perform lookups and
then explains the results. This ensures every finding is grounded in a data
source, not LLM memory.

**Background:** Gemini 2.5 Pro supports function calling. The current
`claude-worker.mjs` sends a prompt and gets text back. We need to change it
to support multi-turn tool-call conversations.

**Step 1 — Define tools in a shared file**

Create `src/lib/server/audit-tools.mjs`:

```javascript
/**
 * Gemini function declarations for the tool-calling audit flow.
 * These mirror the deterministic functions in audit-rules.ts.
 */
export const AUDIT_TOOL_DECLARATIONS = [
  {
    name: "lookup_mpfs_rate",
    description: "Look up the Medicare Physician Fee Schedule rate for a CPT or HCPCS code.",
    parameters: {
      type: "OBJECT",
      properties: {
        cptCode: { type: "STRING", description: "CPT or HCPCS code" }
      },
      required: ["cptCode"]
    }
  },
  {
    name: "check_ncci_bundling",
    description: "Check if a CPT code is bundled into another code per CMS NCCI PTP edits.",
    parameters: {
      type: "OBJECT",
      properties: {
        cptCode: { type: "STRING", description: "The code to check" },
        allCodesOnBill: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "All CPT/HCPCS codes present on the bill"
        },
        modifiers: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "Modifiers on this line item (e.g. ['-59', 'XE'])"
        }
      },
      required: ["cptCode", "allCodesOnBill"]
    }
  },
  {
    name: "check_mue_units",
    description: "Check if units billed for a CPT code exceed the CMS Medically Unlikely Edit limit.",
    parameters: {
      type: "OBJECT",
      properties: {
        cptCode: { type: "STRING" },
        unitsBilled: { type: "NUMBER", description: "Total units billed for this code on this date" }
      },
      required: ["cptCode", "unitsBilled"]
    }
  },
  {
    name: "check_lcd_coverage",
    description: "Check if the diagnosis codes (ICD-10) on a line item support coverage for this procedure per CMS Local Coverage Determination.",
    parameters: {
      type: "OBJECT",
      properties: {
        cptCode: { type: "STRING" },
        icd10Codes: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "ICD-10 diagnosis codes present on this bill"
        }
      },
      required: ["cptCode", "icd10Codes"]
    }
  }
]
```

**Step 2 — Create a tool execution handler**

In `claude.ts` (or a new `audit-tool-executor.ts`), create a function that
executes a tool call given the function name and args, using the already-
loaded static data:

```typescript
export function executeTool(
  name: string,
  args: Record<string, unknown>,
  data: { mpfs: MpfsData; ncci: NcciData; mue: MueData; lcdCoverage: LcdCoverageData; asp: AspData; clfs: ClfsData }
): unknown {
  switch (name) {
    case 'lookup_mpfs_rate': {
      const code = String(args.cptCode)
      const rate = getMpfsRate(data.mpfs[code]) ?? data.clfs[code]?.rate ?? null
      return { code, rate, source: rate != null ? (data.mpfs[code] ? 'mpfs' : 'clfs') : 'not_found' }
    }
    case 'check_ncci_bundling': {
      const code = String(args.cptCode)
      const allCodes = new Set((args.allCodesOnBill as string[]).map(c => c.toUpperCase()))
      const entry = getNcciEntry(code, data.ncci)
      if (!entry) return { ncciViolation: false }
      const bundledWith = entry.bundledInto.filter(c => allCodes.has(c))
      const modifiers = (args.modifiers as string[]) ?? []
      const hasModifier59 = modifiers.some(m => ['59', '-59', 'XE', 'XP', 'XS', 'XU'].includes(m.trim()))
      return {
        ncciViolation: bundledWith.length > 0,
        bundledWith,
        modifierCanOverride: entry.modifierCanOverride,
        hasModifier59
      }
    }
    case 'check_mue_units': {
      const code = String(args.cptCode)
      const units = Number(args.unitsBilled)
      const mueEntry = data.mue[code]
      if (!mueEntry) return { mueViolation: false, maxUnits: null }
      return { mueViolation: units > mueEntry.maxUnits, maxUnits: mueEntry.maxUnits, unitsBilled: units }
    }
    case 'check_lcd_coverage': {
      const code = String(args.cptCode)
      const icd10s = (args.icd10Codes as string[]) ?? []
      const entry = data.lcdCoverage[code]
      if (!entry || entry.covered.length === 0) return { coverageResult: 'no_lcd_available' }
      const covered = icd10s.some(icd => entry.covered.some(c => icd.startsWith(c)))
      const excluded = icd10s.some(icd => entry.notCovered.some(c => icd.startsWith(c)))
      return {
        coverageResult: covered ? 'covered' : (excluded ? 'not_covered_explicitly' : 'not_covered'),
        lcdIds: entry.lcdIds,
        coveredIcds: entry.covered,
        submittedIcds: icd10s
      }
    }
    default:
      return { error: `Unknown tool: ${name}` }
  }
}
```

**Step 3 — Update `claude-worker.mjs` for tool calling**

Replace the current single-shot `model.generateContent(prompt)` with a
multi-turn chat that handles `functionCall` responses:

```javascript
import { GoogleGenerativeAI, FunctionCallingMode } from '@google/generative-ai'

// In the main handler, parse { prompt, tools } from stdin instead of just { prompt }
const { prompt, tools } = JSON.parse(inputData.trim())

const model = genAI.getGenerativeModel({
  model: modelName,
  generationConfig: { temperature: 0 },
  tools: tools ? [{ functionDeclarations: tools }] : undefined,
  toolConfig: tools ? { functionCallingConfig: { mode: FunctionCallingMode.AUTO } } : undefined,
})

const chat = model.startChat()
let response = await chat.sendMessage(prompt)

// Handle tool call turns (max 10 iterations to prevent infinite loops)
for (let turn = 0; turn < 10; turn++) {
  const candidate = response.response.candidates?.[0]
  const parts = candidate?.content?.parts ?? []
  const functionCalls = parts.filter(p => p.functionCall)

  if (functionCalls.length === 0) break  // no more tool calls — final text response

  // Execute all tool calls and send results back
  const toolResults = functionCalls.map(part => ({
    functionResponse: {
      name: part.functionCall.name,
      response: { result: JSON.stringify(part.functionCall) }  // placeholder
      // In actual integration: call executeTool() here via IPC or pass pre-computed results
    }
  }))

  response = await chat.sendMessage(toolResults)
}

const text = response.response.text()
```

**Important note:** Because `claude-worker.mjs` is a separate subprocess,
tool execution (which needs access to the JSON data files) must happen either:
- **Option A (simpler):** Pre-compute all tool results in `claude.ts` before
  spawning the worker, pass them as a lookup table in the prompt. Worker
  calls tools → host sends back pre-computed results.
- **Option B (cleaner):** Keep tool execution in `claude.ts`. Change the
  worker communication protocol to support a request-response loop where the
  worker asks for tool results and `claude.ts` responds.

**Recommendation: Start with Option A.** Inject pre-computed tool results for
all codes on the bill into the prompt as a "lookup context" block. This avoids
IPC complexity while still achieving the structured grounding benefit. The
LLM uses the pre-computed table rather than its training memory. Option B can
be a follow-up.

**Definition of done (Option A):**
- [ ] `AUDIT_TOOL_DECLARATIONS` defined
- [ ] Pre-computed lookup context for each line item built in `claude.ts`
  and injected into the prompt with clear labeling per code
- [ ] Prompt instructs LLM to use only the injected context, not training
  memory, for factual claims
- [ ] Commit: `"refactor: ground audit LLM with pre-computed tool context"`

---

## PHASE 6 — Revenue Code Support (2 days)

---

### Task 14 — Add Revenue Code Extraction and Mismatch Check

**Goal:** Extract 4-digit UB-04 revenue codes from facility bills (currently
stripped) and detect mismatches between the service category and the CPT code.

**Step 1 — Update `vision-extract.mjs` to extract revenue codes**

Add to the JSON schema:
```javascript
"lineItems": [
  { "code": "99285", "description": "...", "units": 1, "amount": 800.00, "revenueCode": "0450" }
]
```

Add to the prompt instruction: "For UB-04 facility bills, also extract the
4-digit Revenue Code for each line item from the Revenue Code column (FL 42).
Revenue codes look like 0450, 0300, 0636 etc. Set to null for CMS-1500
professional claims."

**Step 2 — Add `revenueCode` to `LineItem` type**

```typescript
export interface LineItem {
  cpt: string
  description: string
  units: number
  billedAmount: number
  serviceDate?: string
  modifiers?: string[]
  icd10Codes?: string[]
  revenueCode?: string    // ADD — 4-digit UB-04 revenue code
}
```

**Step 3 — Create `src/lib/data/revenue_code_rules.json`**

A static hand-authored file (no CMS download needed). Captures known
mismatches between revenue code categories and CPT ranges:

```json
{
  "_comment": "revenue code prefix (first 3 digits) → allowed CPT ranges and mismatch description",
  "045": {
    "label": "Emergency Room",
    "allowedCptRanges": [["99281", "99285"]],
    "notAllowedRanges": [["99202", "99215"]],
    "mismatchNote": "Emergency room revenue code (045x) should use ED E&M codes 99281–99285, not office visit codes 99202–99215."
  },
  "036": {
    "label": "Operating Room",
    "allowedCptRanges": [["10000", "69999"]],
    "notAllowedRanges": [["99202", "99285"]],
    "mismatchNote": "Operating room revenue code (036x) should not be billed with E&M office visit codes."
  },
  "030": {
    "label": "Laboratory",
    "allowedCptRanges": [["80000", "89999"]],
    "notAllowedRanges": [["70000", "79999"]],
    "mismatchNote": "Lab revenue code (030x) should not be billed with radiology CPT codes."
  },
  "032": {
    "label": "Radiology — Diagnostic",
    "allowedCptRanges": [["70000", "79999"]],
    "notAllowedRanges": [["80000", "89999"]],
    "mismatchNote": "Radiology revenue code (032x) should not be billed with lab CPT codes."
  },
  "063": {
    "label": "Pharmacy",
    "requiredCptPattern": "^[JQ][0-9]{4}$",
    "mismatchNote": "Pharmacy revenue code (063x) requires a drug HCPCS J-code or Q-code, not a procedure CPT."
  }
}
```

**Step 4 — Add revenue code check to `buildDeterministicFindings`**

```typescript
// 7. Revenue code vs CPT mismatch
for (let i = 0; i < lineItems.length; i++) {
  const li = lineItems[i]
  if (!li.revenueCode) continue
  const code = codes[i]
  const prefix = li.revenueCode.substring(0, 3)
  const rule = revCodeRules[prefix]
  if (!rule) continue

  let mismatch = false
  // Check if CPT is in a "not allowed" range for this revenue code
  if (rule.notAllowedRanges) {
    mismatch = rule.notAllowedRanges.some(([lo, hi]) => code >= lo && code <= hi)
  }
  if (rule.requiredCptPattern) {
    mismatch = !new RegExp(rule.requiredCptPattern).test(code)
  }
  if (!mismatch) continue

  findings.push({
    lineItemIndex: i,
    cptCode: code,
    severity: 'warning',
    errorType: 'other' as AuditFinding['errorType'],  // or add 'revenue_mismatch' type
    confidence: 'high' as ConfidenceLevel,
    description: `CPT ${code} is billed under revenue code ${li.revenueCode} (${rule.label}), but ${rule.mismatchNote}`,
    standardDescription: CPT_DESCRIPTIONS[code],
    recommendation: 'Ask billing to verify the correct service category and revenue code for this charge.',
    medicareRate: getEffectiveRate(code),
    markupRatio: undefined,
    ncciBundledWith: undefined,
  })
}
```

**Definition of done:**
- [ ] Vision prompt extracts `revenueCode` per line item
- [ ] `LineItem.revenueCode` field added
- [ ] `revenue_code_rules.json` created
- [ ] Revenue code mismatch check added to deterministic findings
- [ ] Commit: `"feat: revenue code vs CPT mismatch check for UB-04 bills"`

---

## PHASE 7 — Production Readiness

---

### Task 15 — Update CLAUDE.md / DATA.md and Test Coverage

**Goal:** Ensure `DATA.md` reflects all new data files, and all new
deterministic checks have at least one test.

**`DATA.md` additions:**

Add rows for:
- `mue.json` — MUE Practitioner table, quarterly, CMS NCCI page
- `em_mdm_tiers.json` — hand-authored, review annually when AMA updates E&M guidelines
- `lcd_coverage.json` — CMS LCD database, re-run `build_lcd.py` quarterly

**Test files to create/update:**

For each new function in `audit-rules.ts`, add tests in
`src/lib/server/audit-rules.test.ts` (create this file if it doesn't exist):

```typescript
import { describe, it, expect } from 'vitest'
import { buildDeterministicFindings, buildArithmeticFindings, buildDateFindings, buildGfeFindings } from './audit-rules'

describe('MUE units check', () => {
  it('flags units over MUE limit', () => {
    const findings = buildDeterministicFindings(
      [{ cpt: '99215', description: 'Office visit', units: 3, billedAmount: 600 }],
      {}, {}, {}, {},
      { '99215': { maxUnits: 1, adjudicationType: 'date_of_service' } }
    )
    expect(findings.findings.some(f => f.errorType === 'unbundling')).toBe(true)
  })
})

describe('arithmetic check', () => {
  it('flags when line sum differs from bill total', () => {
    const items = [
      { cpt: '99213', description: '', units: 1, billedAmount: 100 },
      { cpt: '85025', description: '', units: 1, billedAmount: 50 },
    ]
    const findings = buildArithmeticFindings(items, 200) // 200 ≠ 150
    expect(findings).toHaveLength(1)
    expect(findings[0].errorType).toBe('arithmetic_error')
  })

  it('passes when sum matches total within tolerance', () => {
    const items = [{ cpt: '99213', description: '', units: 1, billedAmount: 100 }]
    expect(buildArithmeticFindings(items, 100.20)).toHaveLength(0)
  })
})

describe('GFE check', () => {
  it('flags when bill exceeds GFE by $400+', () => {
    const items = [{ cpt: '99285', description: '', units: 1, billedAmount: 2000 }]
    const findings = buildGfeFindings(items, 1000)
    expect(findings).toHaveLength(1)
    expect(findings[0].errorType).toBe('no_surprises_act')
  })

  it('does not flag when excess is under $400', () => {
    const items = [{ cpt: '99285', description: '', units: 1, billedAmount: 1300 }]
    expect(buildGfeFindings(items, 1000)).toHaveLength(0)
  })
})
```

**Run all tests:**

```bash
npm run test
```

All tests must pass before the final push.

**Definition of done:**
- [ ] `DATA.md` updated with new files
- [ ] `audit-rules.test.ts` created with tests for all new functions
- [ ] All existing tests pass
- [ ] `npm run test` exits 0
- [ ] Commit: `"test: coverage for MUE, arithmetic, GFE, date checks"`

---

### Task 16 — Final Integration Smoke Test

Before pushing, run a manual end-to-end test using one of the existing
sample bills.

```bash
# Start dev server
npm run dev &

# In another terminal, submit a sample bill via curl
curl -X POST http://localhost:5173/api/parse \
  -F "file=@examples/test-images/er-visit-with-cpt.pdf" \
  | python3 -m json.tool | head -100

# Then submit the returned lineItems to audit endpoint
# Verify findings include at least one deterministic finding (unbundling or duplicate)
```

Also test via the browser UI with `examples/test-images/Sample-Itemized-Billing-Statement-HCA-Hospital.pdf`.

**Definition of done:**
- [ ] Parse endpoint returns structured `lineItems`
- [ ] Audit endpoint returns findings with at least one `confidence: high` finding
- [ ] No 500 errors
- [ ] Dispute letter is generated
- [ ] Final commit: `"chore: smoke test verified — production hardening complete"`

---

## Summary: Task Order and Estimated Effort

| # | Task | Phase | Est. Days | Impact |
|---|---|---|---|---|
| 1 | Regen ASP Q2 2026 | 1 | 0.1 | Data freshness |
| 2 | Hospital matching: possessive + synonyms | 1 | 0.5 | +~30% hospital match rate |
| 3 | Hospital matching: rapidfuzz fuzzy fallback | 1 | 0.5 | +~40% match rate |
| 4 | Vision: extract hospital address + phone | 1 | 0.5 | Enables phone matching |
| 5 | Hospital matching: phone-number lookup | 1 | 0.5 | +~20% match rate |
| 6 | MUE units check | 2 | 1 | Eliminates LLM unit guessing |
| 7 | Math / arithmetic validator | 2 | 0.5 | New FairMedBill parity check |
| 8 | Date validator | 2 | 0.5 | New FairMedBill parity check |
| 9 | No Surprises Act / GFE | 2 | 0.5 | New legal compliance check |
| 10 | E&M upcoding pre-filter | 3 | 1.5 | Deterministic upcoding |
| 11 | Hospital Outpatient PTP | 3 | 1 | Better UB-04 unbundling |
| 12 | LCD/NCD ICD-10 coverage | 4 | 3–5 | Highest credibility gain |
| 13 | Tool calling refactor | 5 | 3 | Structural LLM grounding |
| 14 | Revenue code mismatch | 6 | 1 | New UB-04 check type |
| 15 | Tests + DATA.md | 7 | 1 | Production readiness |
| 16 | Smoke test | 7 | 0.5 | Deployment confidence |

**Total: ~16–20 days for a solo junior dev**

---

## Branch and Commit Instructions

All changes go to branch `docs/part-two-explanation`.

```bash
# Start each task on this branch
git checkout docs/part-two-explanation

# After each task: commit with descriptive message, push
git add <specific files only>
git commit -m "<type>: <description>"
git push origin docs/part-two-explanation
```

Never commit `node_modules/`, `build/`, `.svelte-kit/`, `tmp/`, or `data/mrf_cache/`.

When all tasks are done and smoke test passes, open a PR against `main`.
