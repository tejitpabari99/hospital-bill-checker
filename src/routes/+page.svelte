<script lang="ts">
  import ResultsSummary from '$lib/components/ResultsSummary.svelte'
  import LineItemCard from '$lib/components/LineItemCard.svelte'
  import DisputeLetter from '$lib/components/DisputeLetter.svelte'
  import ShareButton from '$lib/components/ShareButton.svelte'
  import FeedbackForm from '$lib/components/FeedbackForm.svelte'
  import MissingCodesNote from '$lib/components/MissingCodesNote.svelte'
  import type { AuditResult, LineItem } from '$lib/types'
  import { trackAuditStarted, trackAuditCompleted, trackBillParseError, trackFileSelected, trackFileTooLarge, trackNewBill } from '$lib/analytics'
  import { downloadResultReport } from '$lib/result-report'

  type ExtendedAuditResult = AuditResult & {
    summary: AuditResult['summary'] & {
      aboveHospitalListCount?: number
      aboveHospitalListTotal?: number
      hospitalName?: string
      hospitalMrfUrl?: string
    }
    extractedMeta: AuditResult['extractedMeta'] & {
      hospitalName?: string
    }
  }

  type Screen = 'upload' | 'processing' | 'results'
  let screen: Screen = $state('upload')

  let file: File | null = $state(null)
  let dragOver = $state(false)
  let fileWarning = $state('')
  let errorMessage = $state('')
  let auditResult: unknown = $state(null)
  let auditLineItems: LineItem[] = $state([])

  // Processing steps
  const STEPS = [
    'Reading your bill...',
    'Extracting billing codes...',
    'Checking NCCI bundling rules...',
    'Comparing CMS Medicare rates...',
    'Checking pharmacy markup...',
    'Looking up hospital published prices...',
    'Analyzing findings...',
    'Generating dispute letter...',
  ]
  let currentStep = $state(0)
  let stepTimer: ReturnType<typeof setInterval> | null = null

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    dragOver = false
    const dropped = e.dataTransfer?.files[0]
    if (dropped) selectFile(dropped)
  }

  function handleFileInput(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (f) selectFile(f)
  }

  function selectFile(f: File) {
    file = f
    fileWarning = ''
    errorMessage = ''
    trackFileSelected(f.type, +(f.size / 1024 / 1024).toFixed(2))
    // Warn about large PDFs (can't check page count without parsing, so warn on file size proxy)
    if (f.size > 8 * 1024 * 1024) {
      fileWarning = 'Large file detected. Bills over 8 pages may not fully process — try uploading just the itemized charges page.'
      trackFileTooLarge(+(f.size / 1024 / 1024).toFixed(2))
    }
  }

  async function startAudit() {
    if (!file) return
    screen = 'processing'
    trackAuditStarted()
    currentStep = 0
    errorMessage = ''

    // Animate steps over ~50 seconds total (API is up to 85s but P50 is ~30s)
    stepTimer = setInterval(() => {
      if (currentStep < STEPS.length - 1) currentStep++
    }, 8000)

    try {
      // Step 1: Parse PDF
      const formData = new FormData()
      formData.append('file', file)
      const parseRes = await fetch('/api/parse', { method: 'POST', body: formData })

      if (!parseRes.ok) {
        trackBillParseError('parse_request_failed')
        throw new Error('Failed to read your bill. Please try again.')
      }

      const parsed = await parseRes.json()
      if (parsed.parseWarning && parsed.cptCodesFound.length === 0) {
        trackBillParseError('no_cpt_codes_found')
        throw new Error(parsed.parseWarning)
      }

      // Step 2: Audit
      const lineItems = (parsed.lineItems ?? []).map((li: any) => ({
        cpt: li.code ?? li.cpt,
        description: li.description ?? '',
        units: li.units ?? 1,
        billedAmount: li.amount ?? li.billedAmount ?? 0,
        icd10Codes: li.icd10Codes ?? [],
      }))
      const auditBody = {
        lineItems,
        hospitalName: parsed.extractedMeta?.hospitalName ?? undefined,
        accountNumber: parsed.extractedMeta?.accountNumber ?? undefined,
        dateOfService: parsed.extractedMeta?.dateOfService ?? undefined,
      }

      const auditRes = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(auditBody),
      })

      if (!auditRes.ok) {
        const err = await auditRes.json().catch(() => ({}))
        if (err.error === 'timeout') throw new Error('Audit timed out — please try again. Your file was not saved.')
        if (err.error === 'rate_limited') throw new Error('Too many audit attempts. Please wait a minute and try again.')
        if (err.error === 'parse_error') throw new Error('Our AI returned an unexpected response. Please try again.')
        if (err.error === 'refusal') throw new Error("Our AI couldn't process this bill — try removing personal information and re-uploading.")
        throw new Error('Audit failed — please try again.')
      }

      auditResult = await auditRes.json()
      const _r = auditResult as any
      trackAuditCompleted(_r?.summary?.potentialOvercharge ?? 0, _r?.summary?.errorCount ?? 0)
      auditLineItems = lineItems

      // Finish last step before showing results
      currentStep = STEPS.length - 1
      setTimeout(() => {
        if (stepTimer) clearInterval(stepTimer)
        screen = 'results'
      }, 1500)

    } catch (err: unknown) {
      if (stepTimer) clearInterval(stepTimer)
      errorMessage = err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      screen = 'upload'
    }
  }

  function reset() {
    trackNewBill()
    screen = 'upload'
    file = null
    fileWarning = ''
    errorMessage = ''
    auditResult = null
    auditLineItems = []
    currentStep = 0
    if (stepTimer) clearInterval(stepTimer)
  }

  function downloadAuditReport() {
    if (!auditResult) return
    downloadResultReport({
      result: auditResult as AuditResult,
      lineItems: auditLineItems,
      fileName: 'hospital-bill-audit-report.pdf',
      generatedAt: new Date(),
    })
  }
</script>

<svelte:head>
  <title>Hospital Bill Checker — Find billing errors, free</title>
  <meta name="description" content="Upload your hospital bill and find billing errors automatically. Free, no login, zero data retention." />
</svelte:head>

{#if screen === 'upload'}
  <main class="container upload-screen">
    <header class="upload-header">
      <h1 class="upload-title">Hospital Bill Checker</h1>
      <p class="upload-subtitle">Upload your itemized bill. We audit every charge against CMS data and write your dispute letter.</p>
    </header>

    {#if errorMessage}
      <div class="error-banner">{errorMessage}</div>
    {/if}

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <label
      class="drop-zone"
      class:drag-over={dragOver}
      for="file-input"
      ondragover={(e) => { e.preventDefault(); dragOver = true }}
      ondragleave={() => dragOver = false}
      ondrop={handleDrop}
    >
      <input
        id="file-input"
        class="file-input"
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        onchange={handleFileInput}
        capture="environment"
        aria-label="Upload bill file"
      />

      {#if file}
        <div class="file-selected">
          <span class="file-icon-wrap" aria-hidden="true">
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
          <p class="drop-secondary">or click to browse - PDF, JPG, PNG up to 20 MB</p>
        </div>
      {/if}
    </label>

    {#if fileWarning}
      <p class="file-warning">{fileWarning}</p>
    {/if}

    <button
      class="btn btn-primary upload-cta"
      disabled={!file}
      onclick={startAudit}
    >
      Analyze Bill
    </button>

    <div class="trust-row">
      <span class="trust-item">No login</span>
      <span class="trust-sep" aria-hidden="true">·</span>
      <span class="trust-item">No data stored</span>
      <span class="trust-sep" aria-hidden="true">·</span>
      <a href="/privacy" class="trust-link">Privacy policy</a>
      <span class="trust-sep" aria-hidden="true">·</span>
      <a href="/how-it-works" class="trust-link">How it works</a>
    </div>

    <div class="feedback-section">
      <FeedbackForm />
    </div>
  </main>

{:else if screen === 'processing'}
  <main class="container processing-screen">
    <div class="processing-inner">
      <p class="processing-label eyebrow">Analyzing</p>
      <h2 class="processing-title">Reviewing your bill</h2>
      <p class="processing-sub">Cross-checking each code against CMS data. This takes 20–60 seconds - do not close this tab.</p>

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

{:else if screen === 'results'}
  {#if auditResult !== null}
    {@const result = auditResult as ExtendedAuditResult}
    <main class="container results-screen">
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

      {#if result.extractedMeta?.hospitalName || result.extractedMeta?.dateOfService}
        <p class="results-subtitle">
          {#if result.extractedMeta.hospitalName}{result.extractedMeta.hospitalName}{/if}{#if result.extractedMeta.hospitalName && result.extractedMeta.dateOfService} · {/if}{#if result.extractedMeta.dateOfService}Service date: {result.extractedMeta.dateOfService}{/if}
        </p>
      {/if}

      <div class="summary-section">
        <ResultsSummary summary={result.summary} />
      </div>

      {#if !result.summary.hospitalMrfUrl && result.extractedMeta?.hospitalName}
        <p class="hospital-data-note">
          Hospital price comparison not available for {result.extractedMeta.hospitalName} — we couldn't locate their required CMS price transparency file.
          <a href="/how-it-works#price-transparency" target="_blank" rel="noopener noreferrer">Learn more ↗</a>
        </p>
      {/if}

      <div class="section-heading-row">
        <h3 class="section-heading">Billing Line Items</h3>
        <a class="section-link" href="#missing-codes">Missing codes</a>
      </div>

      <div class="line-items-list">
        {#each auditLineItems as lineItem, i}
          {@const finding = result.findings.find(f => f.lineItemIndex === i) ?? null}
          <LineItemCard item={lineItem} {finding} index={i} />
        {/each}
      </div>

      <div style="margin-top: 18px;">
        <MissingCodesNote />
      </div>

      <div style="margin-top: 40px;">
        <DisputeLetter letter={result.disputeLetter} />
      </div>

      <ShareButton potentialOvercharge={result.summary.potentialOvercharge} />

      <div class="transparency-link-wrap">
        <a href="/how-it-works" target="_blank" rel="noopener noreferrer">
          How we check your bill - full transparency ↗
        </a>
      </div>

      <p class="disclaimer">
        This tool flags potential issues for your review. A flagged item does not mean you were definitely overcharged - it means you have grounds to ask for an explanation.
        This is not legal or medical advice.
      </p>

      <div class="feedback-section">
        <FeedbackForm />
      </div>
    </main>
  {/if}
{/if}

<style>
  .upload-screen {
    padding-top: 48px;
    padding-bottom: 64px;
  }

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

  .drop-zone:focus-within {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  .file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

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

  .upload-cta {
    width: 100%;
    padding: 14px 24px;
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 14px;
    letter-spacing: 0.01em;
  }

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

  .feedback-section {
    margin-top: 40px;
    padding-top: 40px;
    border-top: 1px solid var(--border);
  }

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

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .results-screen {
    padding-top: 48px;
    padding-bottom: 64px;
  }

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

  .summary-section {
    margin: 24px 0 8px;
  }

  .hospital-data-note {
    font-size: 12px;
    color: var(--text-muted);
    margin: -16px 0 20px;
    padding: 8px 12px;
    background: #FAFAFA;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .hospital-data-note a {
    color: var(--accent);
    text-decoration: none;
  }

  .hospital-data-note a:hover {
    text-decoration: underline;
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

  .transparency-link-wrap {
    text-align: center;
    margin-top: 18px;
  }

  .transparency-link-wrap a {
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .transparency-link-wrap a:hover {
    color: var(--text-primary);
  }

  .disclaimer {
    margin-top: 32px;
    font-size: 12px;
    color: var(--text-muted);
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

  @media (max-width: 480px) {
    .upload-title {
      font-size: 28px;
    }

    .drop-zone {
      padding: 28px 20px;
    }

    .upload-subtitle {
      font-size: 15px;
    }

    .results-title {
      font-size: 20px;
    }

    .step-row {
      gap: 12px;
    }
  }
</style>
