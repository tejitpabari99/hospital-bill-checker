<svelte:head>
  <title>How It Works — Hospital Bill Checker</title>
  <meta name="description" content="Full transparency on how Hospital Bill Checker analyzes your bill — data sources, AI methodology, and limitations." />
</svelte:head>

<main class="container" style="padding-top: 48px; padding-bottom: 80px;">

  <a href="/" style="display:inline-block; font-size:14px; color:var(--text-muted); text-decoration:none; margin-bottom:32px;">← Back</a>

  <h1 style="font-size:26px; font-weight:700; margin:0 0 8px;">How It Works</h1>
  <p style="color:var(--text-muted); font-size:14px; margin:0 0 40px;">
    Full transparency on every step — from upload to dispute letter.
  </p>

  <!-- Step 1 -->
  <section class="section">
    <div class="step-header">
      <span class="step-num">1</span>
      <h2>You upload your bill</h2>
    </div>
    <p>You upload a PDF, JPG, PNG, or WebP of your itemized hospital bill. The file never leaves your browser until you click Analyze — and even then, it is sent directly to our server over HTTPS, processed immediately, and never written to disk.</p>
    <p>We validate the file type using magic bytes (not just the filename), and reject files over 20MB.</p>
  </section>

  <!-- Step 2 -->
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
  </section>

  <!-- Step 3 -->
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
  </section>

  <!-- Step 4 -->
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
  </section>

  <!-- Step 5 -->
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
  </section>

  <!-- Limitations -->
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

  <!-- Open source -->
  <section class="section">
    <div class="step-header">
      <span class="step-num">✓</span>
      <h2>Open source &amp; auditable</h2>
    </div>
    <p>Every line of code is public. You can verify exactly what we do with your data. The CMS data build scripts, audit prompts, and extraction logic are all in the repository.</p>
    <a href="https://github.com" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="display:inline-flex; margin-top:8px;">View source on GitHub ↗</a>
  </section>

</main>

<style>
  .section {
    margin-bottom: 40px;
    padding-bottom: 40px;
    border-bottom: 1px solid var(--border);
  }
  .section:last-child {
    border-bottom: none;
  }

  .step-header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 14px;
  }

  .step-num {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--accent);
    color: white;
    font-size: 14px;
    font-weight: 700;
    flex-shrink: 0;
  }

  h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
  }

  p { font-size: 15px; line-height: 1.7; color: var(--text-primary); margin: 0 0 12px; }
  ul { font-size: 15px; line-height: 1.8; color: var(--text-primary); margin: 0 0 12px; padding-left: 20px; }
  li { margin-bottom: 4px; }
  code { font-family: var(--font-mono); font-size: 13px; background: #F1F5F9; padding: 1px 5px; border-radius: 4px; }
  a { color: var(--accent); }

  .callout {
    background: #F0FDFA;
    border: 1px solid #99F6E4;
    border-radius: var(--radius);
    padding: 12px 16px;
    font-size: 14px;
    line-height: 1.6;
    margin-top: 12px;
  }

  .callout-warning {
    background: #FFFBEB;
    border-color: #FEF3C7;
  }

  .data-table {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    font-size: 14px;
  }

  .data-row {
    display: grid;
    grid-template-columns: 1fr 2fr 2fr;
    gap: 0;
    border-bottom: 1px solid var(--border);
  }
  .data-row:last-child { border-bottom: none; }
  .data-row > span {
    padding: 12px 14px;
    border-right: 1px solid var(--border);
    line-height: 1.5;
  }
  .data-row > span:last-child { border-right: none; }
  .header-row { background: #F8FAFC; font-weight: 600; font-size: 13px; color: var(--text-muted); }
  small { font-size: 12px; color: var(--text-muted); }

  .error-types { display: flex; flex-direction: column; gap: 16px; }
  .error-type {
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .error-type p { margin: 4px 0 0; font-size: 14px; color: var(--text-muted); }

  .error-tag {
    display: inline-flex;
    align-items: center;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 3px 8px;
    border-radius: 4px;
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .tag-error { background: #FEF2F2; color: var(--error); }
  .tag-warning { background: #FFFBEB; color: var(--warning); }
</style>
