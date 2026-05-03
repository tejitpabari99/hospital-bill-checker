<script lang="ts">
  type CheckTag = 'Deterministic' | 'AI'

  let mode = $state<'simple' | 'detailed'>('simple')

  const checks: Array<{
    id: string
    num: string
    title: string
    tag: CheckTag
    simple: string
    detailed: string
  }> = [
    {
      id: 'ncci',
      num: '01',
      title: 'NCCI Unbundling Check',
      tag: 'Deterministic',
      simple: `Some procedures are intentionally "bundled" by Medicare — they should never be billed separately because payment for one already includes the other. For example, a surgeon cannot bill separately for closing the incision they just made as part of a larger surgery. Our app checks every pair of procedure codes on your bill against the official CMS list of prohibited pairings (called NCCI PTP edits). If two codes appear together that shouldn't, we flag it.`,
      detailed: `<p><strong>Data source:</strong> CMS NCCI Procedure-to-Procedure (PTP) edits — three files covering Medicare Part B (practitioner), Hospital Outpatient, and DME bill types. Downloaded from <a href="https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-policy-manual" target="_blank" rel="noopener noreferrer">CMS NCCI page</a>.</p>
<p><strong>What we check:</strong> For every ordered pair (col1_code, col2_code) in your bill, we query <code>data/ncci.sqlite</code> → table <code>ncci_ptp</code> filtered by bill_type and effective date range. If a pair exists with <code>modifier_indicator = 0</code>, it is an absolute edit (no modifier overrides it). If <code>modifier_indicator = 1</code>, the edit can be bypassed if a valid modifier (e.g., 59, XE, XS, XP, XU) is present on col2.</p>
<p><strong>Code:</strong> <code>src/lib/server/audit-rules.ts</code> → <code>checkNcciBundling()</code>. DB loader: <code>src/lib/server/data-loader.ts</code> → <code>loadNcciPairs()</code>.</p>
<p><strong>Limitation:</strong> We check Medicare NCCI. Private payer NCCI adoptions vary. If your bill is from a private payer, they may follow CMS rules or have their own edits.</p>`,
    },
    {
      id: 'mue',
      num: '02',
      title: 'MUE — Max Units Per Service',
      tag: 'Deterministic',
      simple: `Every CPT/HCPCS procedure code has a maximum number of times it can reasonably be billed per patient per day. These limits are set by CMS based on medical necessity — for example, a patient can only have one appendix removed, so that code can only appear once. If your bill shows more units than the Medicare cap, we flag it. This catches billing errors or deliberate upcoding.`,
      detailed: `<p><strong>Data source:</strong> CMS Medically Unlikely Edits (MUE) — separate tables for practitioner, outpatient, and DME. Only edits with MAI (Medically Unlikely Edit Adjudication Indicator) = 3 are claim-line denials (hard stops). MAI = 1 and 2 are date-of-service edits.</p>
<p><strong>What we check:</strong> For each line item, query <code>data/mue.sqlite</code> → table <code>mue_edits</code> by (hcpcs_code, bill_type). If <code>line_item.units > mue_edit.mue_value</code>, we flag the line item with the allowed maximum and the billed amount.</p>
<p><strong>Code:</strong> <code>src/lib/server/audit-rules.ts</code> → <code>checkMueExceeded()</code>. DB loader: <code>loadMueEdit()</code>.</p>
<p><strong>Note:</strong> MUE values are published without the actual numeric limits in public files for some codes (marked "N/A"). Those codes are not checked.</p>`,
    },
    {
      id: 'mpfs',
      num: '03',
      title: 'MPFS — Physician Fee Benchmark',
      tag: 'Deterministic',
      simple: `CMS publishes what Medicare would pay a doctor for every procedure code. This is called the Medicare Physician Fee Schedule (MPFS). If a doctor bills more than twice the Medicare rate, we flag it. The Medicare rate isn't the final payment — hospitals and insurers negotiate — but it's the standard benchmark used across the industry to assess whether a charge is reasonable.`,
      detailed: `<p><strong>Data source:</strong> Medicare Physician Fee Schedule (MPFS) — <code>PPRRVU26.xlsx</code> from <a href="https://www.cms.gov/medicare/physician-fee-schedule/search/overview" target="_blank" rel="noopener noreferrer">CMS MPFS downloads</a>. Non-facility rate calculated as <code>NONFAC_TOTAL × 33.29</code> (2026 conversion factor).</p>
<p><strong>What we check:</strong> For each line item on a practitioner bill, query <code>data/mpfs.sqlite</code> → table <code>mpfs_rates</code>. If <code>billedAmount > nonfac_rate × 2.0</code>, we report the overcharge ratio and flag the finding.</p>
<p><strong>Code:</strong> <code>src/lib/server/audit-rules.ts</code> → <code>checkMpfsBenchmark()</code>. DB loader: <code>loadMpfsRate()</code>.</p>
<p><strong>Stage 2 (future):</strong> Location-adjusted rates using GPCI (Geographic Practice Cost Indices) from <code>rvu26b.zip</code> — files <code>GPCI2026.xlsx</code> and <code>26LOCCO.xlsx</code>. Not yet implemented.</p>`,
    },
    {
      id: 'clfs',
      num: '04',
      title: 'CLFS — Lab Test Benchmark',
      tag: 'Deterministic',
      simple: `CMS also publishes maximum payment amounts for lab tests — blood panels, urine tests, genetic tests, and more. This is called the Clinical Laboratory Fee Schedule (CLFS). If a lab charges more than twice what Medicare allows for a test, we flag it. Lab billing errors are extremely common, and this check catches outright overcharges.`,
      detailed: `<p><strong>Data source:</strong> CMS Clinical Laboratory Fee Schedule (CLFS) — annual CSV/TXT from <a href="https://www.cms.gov/medicare/payment/fee-schedules/clinical-laboratory" target="_blank" rel="noopener noreferrer">CMS CLFS page</a>. Delimited file with varying format; column detection is adaptive (scans first 5 rows for header containing "HCPCS").</p>
<p><strong>What we check:</strong> For each line item, query <code>data/clfs.sqlite</code> → view <code>clfs_current</code> (latest rate per code via ROW_NUMBER window function). If <code>billedAmount > payment_limit × 2.0</code>, flag as overcharge.</p>
<p><strong>Code:</strong> <code>src/lib/server/audit-rules.ts</code> → <code>checkClfsBenchmark()</code>. DB loader: <code>loadClfsRate()</code>.</p>`,
    },
    {
      id: 'asp',
      num: '05',
      title: 'ASP — Drug Pricing Check',
      tag: 'Deterministic',
      simple: `Medicare publishes the Average Sales Price (ASP) for drugs administered in a doctor's office or hospital — things like chemotherapy, IV medications, and injections. If a hospital bills more than twice the ASP limit, we flag it. Drug billing is a major source of overcharges, especially for cancer drugs.`,
      detailed: `<p><strong>Data source:</strong> CMS Average Sales Price (ASP) — quarterly Excel files from <a href="https://www.cms.gov/medicare/payment/part-b-drugs/average-sales-price" target="_blank" rel="noopener noreferrer">CMS ASP page</a>. Accepts J-codes, Q-codes, C-codes, A-codes, and B-codes. Header row detection scans first 15 rows for "HCPCS CODE".</p>
<p><strong>What we check:</strong> For each line item matching ASP HCPCS prefixes, query <code>data/asp.sqlite</code> → table <code>asp_payment_limits</code>. If <code>billedAmount > asp_limit × 2.0</code>, flag as drug overcharge. The limit column stores the CMS payment limit (ASP + 6% markup already included).</p>
<p><strong>Code:</strong> <code>src/lib/server/audit-rules.ts</code> → <code>checkAspDrugOvercharge()</code>. DB loader: <code>loadAspLimit()</code>.</p>
<p><strong>Future:</strong> NDC-to-HCPCS crosswalk (<code>asp_ndc_hcpcs_crosswalk</code> table is already created, schema only) to match drug bills that use NDC codes instead of HCPCS.</p>`,
    },
    {
      id: 'opps',
      num: '06',
      title: 'OPPS — Hospital Outpatient Benchmark',
      tag: 'Deterministic',
      simple: `For hospital outpatient services (emergency room visits, outpatient surgery, imaging), Medicare uses a separate payment system called OPPS (Outpatient Prospective Payment System). Every procedure is grouped into an Ambulatory Payment Classification (APC) with a set Medicare payment amount. If a hospital bills more than 2.5 times the Medicare OPPS rate, we flag it.`,
      detailed: `<p><strong>Data source:</strong> CMS OPPS Addendum B (HCPCS → APC → payment rate) and Addendum A (APC reference data). Downloaded from <a href="https://www.cms.gov/medicare/payment/prospective-payment-systems/hospital-outpatient" target="_blank" rel="noopener noreferrer">CMS OPPS page</a>. Column detection is flexible (column index discovery per file).</p>
<p><strong>What we check:</strong> For each line item on an outpatient hospital bill, query <code>data/opps.sqlite</code> → <code>opps_addendum_b LEFT JOIN opps_addendum_a</code>. If <code>billedAmount > payment_rate × 2.5</code>, flag with APC group name and Medicare benchmark.</p>
<p><strong>Code:</strong> <code>src/lib/server/audit-rules.ts</code> → <code>checkOppsBenchmark()</code>. DB loader: <code>loadOppsRate()</code>.</p>
<p><strong>Only applies to:</strong> Bills classified as <code>outpatient</code> by the document classifier (step 12).</p>`,
    },
    {
      id: 'ipps',
      num: '07',
      title: 'IPPS/DRG — Inpatient Admission Reference',
      tag: 'Deterministic',
      simple: `For hospital stays (inpatient admissions), Medicare pays hospitals a fixed amount based on the patient's diagnosis — this is called a DRG (Diagnosis Related Group). If your inpatient bill includes a DRG code, we look it up and show you the Medicare reference weight for that diagnosis. This helps you understand if the billing pattern matches the severity of care documented.`,
      detailed: `<p><strong>Data source:</strong> CMS IPPS DRG weights table — Excel file from <a href="https://www.cms.gov/medicare/payment/prospective-payment-systems/acute-inpatient-pps" target="_blank" rel="noopener noreferrer">CMS IPPS page</a>. Sheet detection is adaptive (scans all sheets for "DRG" in header row). DRG codes are zero-padded to 3 digits.</p>
<p><strong>What we check:</strong> If the bill has a DRG code (extracted by vision) and is classified as <code>inpatient</code>, query <code>data/ipps.sqlite</code> → table <code>ipps_drg_rates</code>. Return the DRG description and relative weight as an informational finding (not necessarily an overcharge, since inpatient pricing is complex).</p>
<p><strong>Code:</strong> <code>src/lib/server/audit-rules.ts</code> → <code>checkIppsDrg()</code>. DB loader: <code>loadDrgRate()</code>.</p>`,
    },
    {
      id: 'dmepos',
      num: '08',
      title: 'DMEPOS — Equipment Pricing Check',
      tag: 'Deterministic',
      simple: `CMS publishes fee schedules for durable medical equipment — wheelchairs, CPAP machines, oxygen equipment, and more. If a supplier charges more than twice the Medicare fee schedule amount for equipment, we flag it. Equipment billing is a historically high-fraud area in Medicare.`,
      detailed: `<p><strong>Data source:</strong> CMS DMEPOS fee schedule — <code>DMEPOS_APR.xlsx</code> from <code>dme26-b.zip</code> at <a href="https://www.cms.gov/medicare/payment/fee-schedules/durable-medical-equipment" target="_blank" rel="noopener noreferrer">CMS DMEPOS page</a>. State-specific rates extracted by regex on column headers matching <code>^([A-Z]{2})\\s*\\(NR\\)</code>. Two tables: <code>dmepos_base</code> (code metadata) and <code>dmepos_state_rates</code> (per-state rental rates).</p>
<p><strong>What we check:</strong> For each line item on a DME bill, query by HCPCS code and patient state. Prefer rows with blank modifier (non-specific). If <code>billedAmount > state_rate × 2.0</code>, flag as equipment overcharge.</p>
<p><strong>Code:</strong> <code>src/lib/server/audit-rules.ts</code> → <code>checkDmeposBenchmark()</code>. DB loader: <code>loadDmeposRate()</code>.</p>
<p><strong>Only applies to:</strong> Bills classified as <code>dme</code>. Falls back to a national average rate if state is unknown.</p>`,
    },
    {
      id: 'ambulance',
      num: '09',
      title: 'Ambulance Fee Schedule',
      tag: 'Deterministic',
      simple: `Medicare has set rates for ambulance transport based on the type of service (Basic Life Support, Advanced Life Support) and the distance traveled. If an ambulance company bills more than twice the Medicare rate for your area, we flag it. Ambulance billing is one of the fastest-growing sources of surprise medical bills.`,
      detailed: `<p><strong>Data source:</strong> CMS Ambulance Fee Schedule — two ZIP files: base rates (<code>cy-2026-file.zip</code>) and ZIP-to-locality mapping. Downloaded from <a href="https://www.cms.gov/medicare/payment/fee-schedules/ambulance" target="_blank" rel="noopener noreferrer">CMS Ambulance page</a>. Column detection is flexible (header scanning).</p>
<p><strong>What we check:</strong> For each line item with a BLS/ALS HCPCS code (A0428, A0427, A0433, etc.), look up the patient's ZIP code in <code>data/ambulance.sqlite</code> → <code>ambulance_geography</code> to find carrier/locality, then join to <code>ambulance_rates</code>. If <code>billedAmount > base_rate × 2.0</code>, flag.</p>
<p><strong>Code:</strong> <code>src/lib/server/audit-rules.ts</code> → <code>checkAmbulanceBenchmark()</code>. DB loader: <code>loadAmbulanceRate()</code>.</p>
<p><strong>Skipped if:</strong> No service ZIP code extracted from the bill.</p>`,
    },
    {
      id: 'hospital-mrf',
      num: '10',
      title: 'Hospital Own Price Check',
      tag: 'Deterministic',
      simple: `Hospitals are required by federal law to publish their own prices online (called a Machine-Readable File, or MRF). We look up the hospital's own published prices for the procedures on your bill. If a hospital charges you more than they've publicly listed — or more than their negotiated rate with your insurer — that's a finding worth disputing.`,
      detailed: `<p><strong>Data source:</strong> Hospital Machine-Readable Files (MRF) — sourced via <a href="https://oria-data.trillianthealth.com/hospitals" target="_blank" rel="noopener noreferrer">Trilliant Health / Oria</a>. Per-hospital DuckDB files are downloaded on demand, converted to SQLite, and cached in <code>data/hospital_cache/</code> for 7 days. Hospital directory sourced from CMS Hospital General Information file.</p>
<p><strong>What we check:</strong> Match the hospital name and state from the bill against <code>data/hospital_directory.sqlite</code>. If found, look up each CPT code in the hospital's cached pricing file. Flag if billed amount exceeds gross charge or negotiated rate by more than 20%.</p>
<p><strong>Code:</strong> <code>src/lib/server/hospital-prices-v2.ts</code> → <code>lookupHospitalPricesV2()</code>. Fetch script: <code>scripts/fetch_hospital_trilliant.py</code>.</p>
<p><strong>Data freshness:</strong> Hospital MRF data is cached for up to 7 days. Hospital directory is rebuilt from CMS on demand.</p>`,
    },
    {
      id: 'classification',
      num: '11',
      title: 'Bill Type Classification',
      tag: 'AI',
      simple: `Before we run any of the checks above, we determine what kind of bill you uploaded. Is it from a doctor's office? A hospital? A medical equipment supplier? Different rules apply to different bill types — a doctor's bill uses different rate schedules than a hospital outpatient bill. We use AI to read the bill and classify it, because the same procedure code can appear on multiple bill types.`,
      detailed: `<p><strong>Model:</strong> Gemini 2.5 Flash (temperature 0, no randomness). Run as a child process (<code>src/lib/server/classify-bill.mjs</code>) after vision extraction completes.</p>
<p><strong>Inputs:</strong> Raw bill text (first 400 chars), CPT/HCPCS codes list, DRG presence, admission/discharge dates, hospital name.</p>
<p><strong>Output:</strong> One of: <code>practitioner</code>, <code>outpatient</code>, <code>dme</code>, <code>inpatient</code>, <code>unknown</code>.</p>
<p><strong>Why AI, not deterministic?</strong> The same CPT code (e.g., 99285) can appear on both practitioner bills and hospital outpatient bills. Form type (UB-04 vs CMS-1500) is not reliably extractable from vision alone. Revenue codes and contextual signals require language understanding. This is one of three approved AI uses in the system.</p>`,
    },
    {
      id: 'vision',
      num: '12',
      title: 'Vision Extraction',
      tag: 'AI',
      simple: `We use Google's Gemini AI to read your bill image or PDF and extract all the important details — procedure codes, charges, hospital name, dates of service, and more. This is a purely mechanical transcription step. The AI is not making any medical or financial judgments here; it's just reading the document and pulling out structured data.`,
      detailed: `<p><strong>Model:</strong> Gemini 2.5 Flash (vision-capable). Run as a child process (<code>src/lib/server/vision-extract.mjs</code>).</p>
<p><strong>Extracts:</strong> <code>lineItems[]</code> (code, description, units, quantity, amount, modifiers, serviceDate, icd10Codes), <code>hospitalName</code>, <code>hospitalAddress</code>, <code>hospitalPhone</code>, <code>patientName</code>, <code>patientState</code>, <code>serviceZip</code>, <code>dateOfService</code>, <code>billTotal</code>, <code>admissionDate</code>, <code>dischargeDate</code>, <code>drgCode</code>, <code>accountNumber</code>, <code>goodFaithEstimate</code>.</p>
<p><strong>Why AI?</strong> Bill formats vary enormously across thousands of hospitals, billing services, and software systems. A deterministic parser would require custom templates for each. Vision models generalize across formats. This is one of three approved AI uses.</p>`,
    },
    {
      id: 'letter',
      num: '13',
      title: 'Dispute Letter Generation',
      tag: 'AI',
      simple: `Once all the checks are complete, we generate a professional dispute letter you can send to the hospital or insurer. The letter cites the specific CMS rules that were violated and asks for corrections. The AI writes the letter — but it can only reference findings that were discovered by the deterministic checks. It cannot invent overcharges or make claims that weren't already found.`,
      detailed: `<p><strong>Model:</strong> Claude (claude-worker.mjs child process). Receives a structured list of all deterministic findings and formats them into a formal dispute letter.</p>
<p><strong>Constraint:</strong> The AI receives findings already identified — it does not perform additional analysis. It only converts structured data (code, billed amount, benchmark amount, rule name) into professional letter language with CMS citation references.</p>
<p><strong>Why AI?</strong> Natural language generation of formal letters requires contextual reasoning across multiple findings, citation of regulation text, and appropriate professional tone. Templating alone produces poor results for this use case. This is one of three approved AI uses.</p>`,
    },
  ]
</script>

<svelte:head>
  <title>Learn — Hospital Bill Checker</title>
  <meta name="description" content="Understand how hospital bills are checked and what each rule means for your medical bill." />
</svelte:head>

<div class="page">
  <div class="page-header">
    <div class="header-text">
      <h1>How We Check Your Bill</h1>
      <p class="subtitle">Every rule we apply, in plain English — or technical detail if you prefer.</p>
    </div>
    <div class="mode-toggle">
      <button
        class:active={mode === 'simple'}
        onclick={() => mode = 'simple'}
      >Simple</button>
      <button
        class:active={mode === 'detailed'}
        onclick={() => mode = 'detailed'}
      >Detailed</button>
    </div>
  </div>

  <!-- DIAGRAM: Process overview -->
  <section class="diagram-section">
    <h2>The Full Process</h2>
    <div class="diagram-placeholder">
      <p>[Diagram: End-to-end process — Upload → Extract → Classify → CMS Checks → Letter]</p>
      <p class="diagram-note">Diagram will be inserted here (see learning-plan-1.md)</p>
    </div>
  </section>

  <!-- DIAGRAM: Medicare rate system -->
  <section class="diagram-section">
    <h2>How Medicare Rates Are Built</h2>
    <div class="diagram-placeholder">
      <p>[Diagram: CMS rate components — RVU × CF, APC weights, DRG weights, fee schedule hierarchy]</p>
      <p class="diagram-note">Diagram will be inserted here (see learning-plan-1.md)</p>
    </div>
  </section>

  <!-- CHECKS -->
  {#each checks as check}
    <section class="check-section" id={check.id}>
      <div class="check-header">
        <span class="check-num">{check.num}</span>
        <div>
          <h2>{check.title}</h2>
          <span class="check-tag {check.tag === 'Deterministic' ? 'tag-det' : 'tag-ai'}">{check.tag}</span>
        </div>
      </div>

      <div class="check-body">
        {#if mode === 'simple'}
          <p>{check.simple}</p>
        {:else}
          {@html check.detailed}
        {/if}
      </div>
    </section>
  {/each}
</div>

<style>
  .page {
    max-width: 800px;
    margin: 0 auto;
    padding: 32px 24px 64px;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 40px;
    flex-wrap: wrap;
  }

  .header-text h1 {
    font-size: 2rem;
    font-weight: 700;
    margin: 0 0 8px;
  }

  .subtitle {
    color: #64748b;
    margin: 0;
    font-size: 1rem;
  }

  .mode-toggle {
    display: flex;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .mode-toggle button {
    background: white;
    border: none;
    padding: 8px 16px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    color: #64748b;
    transition: background 0.15s, color 0.15s;
  }

  .mode-toggle button.active {
    background: #1e293b;
    color: white;
  }

  .mode-toggle button:first-child {
    border-right: 1px solid #e2e8f0;
  }

  .diagram-section {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 32px;
  }

  .diagram-section h2 {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0 0 16px;
  }

  .diagram-placeholder {
    background: #f1f5f9;
    border: 2px dashed #cbd5e1;
    border-radius: 8px;
    padding: 32px;
    text-align: center;
    color: #64748b;
    font-size: 14px;
  }

  .diagram-placeholder p {
    margin: 0 0 8px;
  }

  .diagram-placeholder p:last-child {
    margin: 0;
    font-size: 12px;
    color: #94a3b8;
  }

  .check-section {
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 20px;
  }

  .check-header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 16px;
  }

  .check-num {
    font-size: 11px;
    font-weight: 700;
    color: #94a3b8;
    background: #f1f5f9;
    padding: 4px 8px;
    border-radius: 4px;
    flex-shrink: 0;
    margin-top: 2px;
    letter-spacing: 0.05em;
  }

  .check-header h2 {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 0 0 6px;
  }

  .check-tag {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 9999px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .tag-det {
    background: #d1fae5;
    color: #065f46;
    border: 1px solid #6ee7b7;
  }

  .tag-ai {
    background: #ede9fe;
    color: #4c1d95;
    border: 1px solid #c4b5fd;
  }

  .check-body {
    color: #374151;
    font-size: 15px;
    line-height: 1.7;
  }

  .check-body p {
    margin: 0 0 12px;
  }

  .check-body p:last-child {
    margin-bottom: 0;
  }

  .check-body :global(a) {
    color: #2563eb;
    text-decoration: underline;
  }

  .check-body :global(code) {
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 13px;
    color: #1e293b;
  }

  @media (max-width: 480px) {
    .page {
      padding: 20px 16px 48px;
    }

    .page-header {
      flex-direction: column;
      gap: 12px;
    }

    .header-text h1 {
      font-size: 1.5rem;
    }

    .check-section {
      padding: 16px;
    }

    .check-header {
      gap: 12px;
    }

    .diagram-placeholder {
      padding: 20px 16px;
    }
  }
</style>
