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
      <h2>Gemini Vision reads the bill</h2>
    </div>
    <p>Your bill is sent to <strong>Google Gemini Vision</strong> (<code>gemini-2.5-flash</code>), which reads the PDF or image and extracts:</p>
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
      <h2>We check against three CMS datasets</h2>
    </div>
    <p>Before running the AI audit, we look up each code in three public datasets published by the Centers for Medicare &amp; Medicaid Services (CMS):</p>

    <div class="data-table">
      <div class="data-row header-row">
        <span>Dataset</span><span>What it is</span><span>How we use it</span>
      </div>
      <div class="data-row">
        <span><strong>MPFS</strong><br/><small>Medicare Physician Fee Schedule</small></span>
        <span>The official Medicare payment rate for every CPT code. Published annually.</span>
        <span>Benchmark for upcoding — if a hospital charges 3× the Medicare rate, that's flagged.</span>
      </div>
      <div class="data-row">
        <span><strong>NCCI</strong><br/><small>National Correct Coding Initiative</small></span>
        <span>CMS rules on which CPT codes must be billed together (bundled) and cannot be billed separately. Updated quarterly.</span>
        <span>Unbundling detection — if code A is billed separately but NCCI says it must be included in code B, that's an error.</span>
      </div>
      <div class="data-row">
        <span><strong>ASP</strong><br/><small>Average Sales Price — Drug Pricing</small></span>
        <span>CMS quarterly drug pricing for injectable drugs billed under HCPCS J-codes. Represents the average manufacturer selling price plus a 6% allowed markup.</span>
        <span>Pharmacy markup detection — if a J-code drug is billed far above the CMS ASP limit, the excess is flagged.</span>
      </div>
    </div>

    <p style="margin-top:16px;">These datasets are free, public, and updated regularly. You can download them yourself at <a href="https://www.cms.gov" target="_blank" rel="noopener noreferrer">cms.gov</a>. We rebuild our lookup files from these sources quarterly using open-source Python scripts included in the repository.</p>
    <p class="reference-row">
      Direct sources:
      <a href="https://www.cms.gov/medicare/payment/fee-schedules/physician" target="_blank" rel="noopener noreferrer">Physician Fee Schedule</a>
      ·
      <a href="https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits" target="_blank" rel="noopener noreferrer">NCCI edits</a>
      ·
      <a href="https://www.cms.gov/medicare/payment/fee-for-service-providers/part-b-drugs/average-drug-sales-price" target="_blank" rel="noopener noreferrer">Average Sales Price</a>
    </p>
  </section>

  <section class="section">
    <div class="step-header">
      <span class="step-num">4</span>
      <h2>Gemini audits for five error types</h2>
    </div>
    <p>We send the extracted line items, CMS benchmark data, and a structured audit prompt to <strong>Google Gemini</strong> (<code>gemini-2.5-pro</code>). The model checks for:</p>

    <div class="error-types">
      <div class="error-type">
        <span class="error-tag tag-error">UPCODING</span>
        <div>
          <strong>Billing for a more complex service than provided.</strong>
          <p>E&amp;M visit codes (99201–99285) are graded by complexity. If the diagnosis codes present don't justify a high-complexity code, that's upcoding. We compare against the Medicare rate for a lower code and flag the difference.</p>
        </div>
      </div>
      <div class="error-type">
        <span class="error-tag tag-error">UNBUNDLING</span>
        <div>
          <strong>Billing separately for services that must be combined.</strong>
          <p>NCCI rules define which procedures are "component" codes that must be included in a "comprehensive" code. Billing both separately is a billing error — you should only pay for the comprehensive code.</p>
        </div>
      </div>
      <div class="error-type">
        <span class="error-tag tag-warning">PHARMACY MARKUP</span>
        <div>
          <strong>Drug billed far above the CMS price limit.</strong>
          <p>Medicare allows hospitals to charge the ASP plus 6%. We calculate the ratio of the billed amount to the CMS limit. Ratios above 4.5× are flagged as errors; lower ratios are flagged for review.</p>
        </div>
      </div>
      <div class="error-type">
        <span class="error-tag tag-warning">ICD-10 MISMATCH</span>
        <div>
          <strong>Diagnosis codes that don't justify the procedure.</strong>
          <p>Every procedure should be clinically linked to a diagnosis. If the ICD-10 codes on the bill don't justify the procedure billed, that's a potential mismatch worth questioning.</p>
        </div>
      </div>
      <div class="error-type">
        <span class="error-tag tag-error">DUPLICATE</span>
        <div>
          <strong>The same code billed more than once.</strong>
          <p>Exact duplicate CPT codes on the same bill — same code, same service — are flagged. One occurrence should be $0.</p>
        </div>
      </div>
    </div>
    <p class="reference-row">
      Related reading:
      <a href="https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits" target="_blank" rel="noopener noreferrer">CMS NCCI overview</a>
      ·
      <a href="https://www.cms.gov/medicare/coding-billing/icd-10" target="_blank" rel="noopener noreferrer">CMS ICD-10 information</a>
    </p>
  </section>

  <section class="section">
    <div class="step-header">
      <span class="step-num">5</span>
      <h2>A dispute letter is generated</h2>
    </div>
    <p>For every flagged item, Gemini generates a complete dispute letter using the findings as evidence. The letter:</p>
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
        <li><strong>AI can make mistakes.</strong> Gemini may misread scanned bills, misidentify codes, or flag something incorrectly. Always review findings yourself.</li>
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
    margin: 0 0 48px;
    line-height: 1.6;
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
  small { font-size: 12px; color: var(--text-muted); }

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
  .tag-error {
    background: var(--error-bg);
    color: var(--error);
    border: 1px solid var(--error-border);
  }
  .tag-warning {
    background: var(--warning-bg);
    color: var(--warning);
    border: 1px solid var(--warning-border);
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

    .error-type { flex-direction: column; gap: 8px; }
  }
</style>
