<svelte:head>
  <title>How It Works — Hospital Bill Checker</title>
  <meta name="description" content="Full transparency on how Hospital Bill Checker analyzes your bill — data sources, AI methodology, and limitations." />
</svelte:head>

<main class="container" style="padding-top: 48px; padding-bottom: 80px;">
  <div class="back-link-wrap"><a href="/">← Back</a></div>

  <h1 style="margin:0 0 8px;">How It Works</h1>
  <p class="page-subtitle">
    Full transparency on every step — from upload to dispute letter.
  </p>

  <div class="badge-legend">
    <p><strong>Key:</strong></p>
    <span class="badge badge-deterministic">Deterministic</span>
    <span style="margin: 0 8px;">= Rule-based lookup from CMS data tables — same result every time, no AI guesswork.</span>
    <br style="margin-bottom: 8px;">
    <span class="badge badge-ai">AI</span>
    <span style="margin: 0 8px;">= Uses Gemini to read or interpret content where structured data alone is insufficient.</span>
  </div>

  <section class="section" id="price-transparency">
    <div class="step-header">
      <span class="step-num">1</span>
      <h2>You upload your bill</h2>
    </div>
    <p>You upload a PDF, JPG, PNG, or WebP of your itemized hospital bill. The file never leaves your browser until you click Analyze — and even then, it is sent directly to our server over HTTPS, processed immediately, and never written to disk.</p>
    <p>We validate the file type using magic bytes (not just the filename), and reject files over 20MB.</p>
    <p class="reference-row">
      More on secure health information handling:
      <a href="https://www.hhs.gov/hipaa/for-professionals/privacy/index.html" target="_blank" rel="noopener noreferrer">HHS HIPAA Privacy Rule</a>
    </p>
  </section>

  <section class="section">
    <div class="step-header">
      <span class="step-num">2</span>
      <h2>Gemini Vision reads the bill <span class="badge badge-ai">AI</span></h2>
    </div>
    <p>Your bill is sent to <strong>Google Gemini Vision</strong> with <code>temperature: 0</code> for consistent extraction, which reads the PDF or image and extracts:</p>
    <ul>
      <li>All CPT and HCPCS billing codes</li>
      <li>Line-item descriptions, units, and dollar amounts</li>
      <li>Hospital name, account number, and date of service</li>
    </ul>
    <p>For UB-04 facility bills, we post-process the codes to strip Revenue Codes (4-digit codes starting with 0) that Gemini sometimes reads as CPT codes. Only standard 5-digit CPT codes and HCPCS Level II codes (J/G/A/B/C + 4 digits) are kept.</p>
    <div class="callout">
      <strong>Privacy:</strong> We do not send patient name, date of birth, or medical record number to the API. Those fields are only used to pre-fill the dispute letter in your browser.
    </div>
    <p class="reference-row">
      Read more:
      <a href="https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system" target="_blank" rel="noopener noreferrer">CMS HCPCS</a>
      ·
      <a href="https://www.ama-assn.org/practice-management/cpt/cpt-code-set-basics-and-resources" target="_blank" rel="noopener noreferrer">AMA CPT basics</a>
    </p>
  </section>

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

  <section class="section">
    <div class="step-header">
      <span class="step-num">4</span>
      <h2>We check against CMS datasets <span class="badge badge-deterministic">Deterministic</span></h2>
    </div>
    <p>Once the bill type is known, we look up each code in public datasets published by the Centers for Medicare &amp; Medicaid Services (CMS). These lookups are fully deterministic — they are rule table checks, not AI guesses:</p>

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

    <div class="callout" style="margin-top: 16px;">
      <strong>Data freshness:</strong> CMS data is updated quarterly (NCCI, MUE, ASP, CLFS, OPPS) or annually (MPFS, IPPS, DMEPOS, Ambulance). Data may be up to 30 days stale relative to the CMS publication date. Hospital MRF data is cached locally for up to 7 days.
      See the <a href="/data">data sources page</a> for full refresh schedules.
    </div>

    <p style="margin-top:16px;">These datasets are free, public, and updated regularly. You can download them yourself at <a href="https://www.cms.gov" target="_blank" rel="noopener noreferrer">cms.gov</a>. We rebuild our lookup files from these sources using open-source Python scripts included in the repository. NCCI bundling violations, MUE unit violations, duplicate billing, pharmacy markup overcharges, facility-rate checks, DME rate checks, and lab-rate lookups are all detected by these lookup tables — Gemini is not involved in those checks.</p>
    <p>All billing error findings are deterministic — AI is not involved in any audit decision. Unbundling is detected by CMS NCCI lookup, drug overcharges use the CMS ASP dataset, and unit limits use CMS MUE edits. We use the Medicare NCCI PTP file and fall back to the Medicaid Practitioner Services edition for bill types not covered by Medicare NCCI. AI is used only for three mechanical tasks: reading bill images (Vision Extraction), classifying bill type, and formatting the dispute letter.</p>
    <p class="reference-row">
      Direct sources:
      <a href="https://www.cms.gov/medicare/payment/fee-schedules/physician" target="_blank" rel="noopener noreferrer">Physician Fee Schedule</a>
      ·
      <a href="https://www.cms.gov/Medicare/Medicare-Fee-for-Service-Payment/ClinicalLabFeeSched/index.html" target="_blank" rel="noopener noreferrer">Clinical Laboratory Fee Schedule</a>
      ·
      <a href="https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits" target="_blank" rel="noopener noreferrer">NCCI edits</a>
      ·
      <a href="https://www.cms.gov/medicare/payment/fee-for-service-providers/part-b-drugs/average-drug-sales-price" target="_blank" rel="noopener noreferrer">Average Sales Price</a>
      ·
      <a href="https://www.cms.gov/medicare/payment/prospective-payment-systems/hospital-outpatient" target="_blank" rel="noopener noreferrer">OPPS</a>
      ·
      <a href="https://www.cms.gov/medicare/payment/prospective-payment-systems/acute-inpatient-pps" target="_blank" rel="noopener noreferrer">IPPS</a>
    </p>
  </section>

  <section class="section">
    <div class="step-header">
      <span class="step-num">5</span>
      <h2>We generate a dispute letter <span class="badge badge-ai">AI</span></h2>
    </div>
    <p>Once all deterministic checks are complete, the findings are passed to the AI to draft a formal dispute letter. The AI does not invent findings — it only formats the deterministic results into professional language, citing CMS policy references.</p>
    <p>The letter:</p>
    <ul>
      <li>Cites your right to dispute under 42 CFR 405.374</li>
      <li>Includes an itemized table of flagged codes with Medicare benchmarks</li>
      <li>Requests a corrected bill or written justification</li>
      <li>Uses <span style="background:var(--placeholder); border:1px solid var(--placeholder-border); padding:1px 4px; border-radius:3px; font-size:13px;">[amber placeholders]</span> for personal details you fill in</li>
    </ul>
    <p>The letter is editable in your browser before you copy or download it. Nothing is sent anywhere.</p>
    <p class="reference-row">
      Billing rights context:
      <a href="https://www.ecfr.gov/current/title-42/chapter-IV/subchapter-B/part-405/subpart-C/section-405.374" target="_blank" rel="noopener noreferrer">42 CFR 405.374</a>
      ·
      <a href="https://www.cms.gov/nosurprises" target="_blank" rel="noopener noreferrer">CMS No Surprises Act</a>
    </p>
  </section>

  <section class="section">
    <div class="step-header">
      <span class="step-num">!</span>
      <h2>Limitations to understand</h2>
    </div>
    <div class="callout callout-warning">
      <ul style="margin:0; padding-left:20px; line-height:1.8;">
        <li><strong>This is not a guarantee.</strong> A flagged item means you have grounds to ask for an explanation — not that you were definitely overcharged.</li>
        <li><strong>We use Medicare rates as benchmarks.</strong> Hospitals often charge more than Medicare rates. A charge above Medicare isn't automatically wrong — it's a starting point for a conversation.</li>
        <li><strong>Lab codes are checked against CLFS when available.</strong> Common lab tests billed under HCPCS codes like 85025 (CBC) or 80053 (metabolic panel) are benchmarked against the Clinical Laboratory Fee Schedule (CLFS) instead of MPFS when that table applies.</li>
        <li><strong>AI can make mistakes.</strong> Gemini may misread scanned bills, misclassify a bill type, or format dispute language incorrectly. Always review findings yourself.</li>
        <li><strong>This is not legal or medical advice.</strong> For complex disputes, consult a qualified medical billing advocate.</li>
      </ul>
    </div>
  </section>

  <section class="section">
    <div class="step-header">
      <span class="step-num">✓</span>
      <h2>Open source &amp; auditable</h2>
    </div>
    <p>Every line of code is public. You can verify exactly what we do with your data. The CMS data build scripts, audit prompts, and extraction logic are all in the repository.</p>
    <div class="reference-links">
      <a href="https://www.cms.gov" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="display:inline-flex; margin-top:8px;">Browse CMS references ↗</a>
      <a href="https://github.com" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="display:inline-flex; margin-top:8px;">View source on GitHub ↗</a>
    </div>
  </section>

</main>

<style>
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
    margin: 0 0 24px;
    line-height: 1.6;
  }

  .badge-legend {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 32px;
    font-size: 14px;
    line-height: 2;
  }

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
  .reference-row {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 14px;
  }

  .reference-links {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

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
  }
</style>
