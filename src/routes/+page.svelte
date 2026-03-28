<script lang="ts">
  import { onMount } from 'svelte'
  import ResultsSummary from '$lib/components/ResultsSummary.svelte'
  import LineItemCard from '$lib/components/LineItemCard.svelte'
  import DisputeLetter from '$lib/components/DisputeLetter.svelte'
  import ShareButton from '$lib/components/ShareButton.svelte'
  import type { AuditResult } from '$lib/types'

  type Screen = 'upload' | 'processing' | 'results'
  let screen: Screen = $state('upload')

  let file: File | null = $state(null)
  let dragOver = $state(false)
  let fileWarning = $state('')
  let errorMessage = $state('')
  let savingsTotal: number | null = $state(null)
  let auditResult: unknown = $state(null)
  let auditLineItems: any[] = $state([])

  // Processing steps
  const STEPS = [
    'Reading your bill...',
    'Identifying billing codes...',
    'Checking NCCI bundling rules...',
    'Comparing CMS Medicare rates...',
    'Checking pharmacy markup...',
    'Generating dispute letter...',
  ]
  let currentStep = $state(0)
  let stepTimer: ReturnType<typeof setInterval> | null = null

  onMount(async () => {
    try {
      const res = await fetch('/api/savings')
      const data = await res.json()
      if (typeof data.total === 'number') savingsTotal = data.total
    } catch { /* hidden gracefully */ }
  })

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
    // Warn about large PDFs (can't check page count without parsing, so warn on file size proxy)
    if (f.size > 8 * 1024 * 1024) {
      fileWarning = 'Large file detected. Bills over 8 pages may not fully process — try uploading just the itemized charges page.'
    }
  }

  function formatSavings(n: number): string {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
    return `$${n.toLocaleString()}`
  }

  async function startAudit() {
    if (!file) return
    screen = 'processing'
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
        throw new Error('Failed to read your bill. Please try again.')
      }

      const parsed = await parseRes.json()

      if (parsed.parseWarning && parsed.cptCodesFound.length === 0) {
        throw new Error(parsed.parseWarning)
      }

      // Step 2: Audit
      const lineItems = parsed.lineItems?.length
        ? parsed.lineItems.map((li: any) => ({
            cpt: li.code ?? li.cpt,
            description: li.description ?? '',
            units: li.units ?? 1,
            billedAmount: li.amount ?? li.billedAmount ?? 0,
            icd10Codes: li.icd10Codes ?? [],
          }))
        : parsed.cptCodesFound.map((cpt: string) => ({
            cpt,
            description: '',
            units: 1,
            billedAmount: 0,
          }))

      const auditBody = {
        lineItems,
        hospitalName: parsed.extractedMeta?.hospitalName,
        accountNumber: parsed.extractedMeta?.accountNumber,
        dateOfService: parsed.extractedMeta?.dateOfService,
      }

      const auditRes = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(auditBody),
      })

      if (!auditRes.ok) {
        const err = await auditRes.json().catch(() => ({}))
        if (err.error === 'timeout') throw new Error('Audit timed out — please try again. Your file was not saved.')
        if (err.error === 'refusal') throw new Error("Our AI couldn't process this bill — try removing personal information and re-uploading.")
        throw new Error('Audit failed — please try again.')
      }

      auditResult = await auditRes.json()
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
    screen = 'upload'
    file = null
    fileWarning = ''
    errorMessage = ''
    auditResult = null
    auditLineItems = []
    currentStep = 0
    if (stepTimer) clearInterval(stepTimer)
  }
</script>

<svelte:head>
  <title>Hospital Bill Checker — Find billing errors, free</title>
  <meta name="description" content="Upload your hospital bill and find billing errors automatically. Free, no login, zero data retention." />
</svelte:head>

{#if screen === 'upload'}
  <main class="container" style="padding-top: 48px; padding-bottom: 64px;">
    <header style="text-align: center; margin-bottom: 40px;">
      <h1 style="font-size: 28px; font-weight: 700; margin: 0 0 8px;">Hospital Bill Checker</h1>
      <p style="color: var(--text-muted); margin: 0 0 16px; font-size: 16px;">
        Find errors. Dispute overcharges. Free, forever.
      </p>
      <div class="trust-badge">
        No login. No account. Never.
      </div>
    </header>

    {#if savingsTotal !== null && savingsTotal > 0}
      <div class="savings-counter card" style="text-align: center; padding: 12px; margin-bottom: 24px;">
        <span style="color: var(--text-muted); font-size: 14px;">
          Patients have identified <strong style="color: var(--success);">{formatSavings(savingsTotal)}</strong> in potential overcharges
        </span>
      </div>
    {/if}

    {#if errorMessage}
      <div class="error-banner" style="margin-bottom: 16px;">
        {errorMessage}
      </div>
    {/if}

    <div
      class="drop-zone card"
      class:drag-over={dragOver}
      role="button"
      tabindex="0"
      aria-label="Drop zone for bill upload"
      ondragover={(e) => { e.preventDefault(); dragOver = true }}
      ondragleave={() => dragOver = false}
      ondrop={handleDrop}
      onclick={() => document.getElementById('file-input')?.click()}
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
          <span class="file-icon">📄</span>
          <span class="file-name">{file.name}</span>
          <span style="color: var(--text-muted); font-size: 13px;">
            {(file.size / 1024 / 1024).toFixed(1)} MB
          </span>
        </div>
      {:else}
        <div class="drop-prompt">
          <div class="upload-icon">↑</div>
          <p style="margin: 8px 0 4px; font-weight: 500;">Drop your bill here</p>
          <p style="margin: 0; color: var(--text-muted); font-size: 14px;">or click to browse</p>
        </div>
      {/if}
    </div>

    {#if fileWarning}
      <p class="file-warning">{fileWarning}</p>
    {/if}

    <p style="text-align: center; color: var(--text-muted); font-size: 13px; margin: 8px 0 20px;">
      Works with PDF, JPG, PNG · Max 20MB
    </p>

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

    <p class="privacy-note">
      🔒 Your bill is processed and immediately discarded. We store nothing.
      <a href="/privacy" style="color: var(--accent);">Privacy policy</a>
    </p>
  </main>

{:else if screen === 'processing'}
  <main class="container" style="padding-top: 80px; padding-bottom: 64px; text-align: center;">
    <h2 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">Analyzing your bill...</h2>
    <p style="color: var(--text-muted); margin-bottom: 40px; font-size: 15px;">This takes 20–60 seconds. Please don't close this tab.</p>

    <div class="steps-list card" style="max-width: 400px; margin: 0 auto; padding: 24px; text-align: left;">
      {#each STEPS as step, i}
        <div class="step-row" class:active={i === currentStep} class:done={i < currentStep}>
          <span class="step-indicator">
            {#if i < currentStep}✓{:else if i === currentStep}<span class="spinner"></span>{:else}·{/if}
          </span>
          <span class="step-label">{step}</span>
        </div>
      {/each}
    </div>
  </main>

{:else if screen === 'results'}
  {#if auditResult !== null}
    {@const result = auditResult as AuditResult}
    <main class="container" style="padding-top: 48px; padding-bottom: 64px;">

      <!-- Header row -->
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
        <button class="btn btn-secondary" onclick={reset}>← New bill</button>
        <h2 style="margin:0; font-size:22px; font-weight:600;">Audit Results</h2>
      </div>

      <!-- Subtitle: hospital name / date of service -->
      {#if result.extractedMeta?.hospitalName || result.extractedMeta?.dateOfService}
        <p class="results-subtitle">
          {#if result.extractedMeta.hospitalName}{result.extractedMeta.hospitalName}{/if}{#if result.extractedMeta.hospitalName && result.extractedMeta.dateOfService} · {/if}{#if result.extractedMeta.dateOfService}Service date: {result.extractedMeta.dateOfService}{/if}
        </p>
      {/if}

      <!-- Summary strip -->
      <div style="margin-top: 24px; margin-bottom: 32px;">
        <ResultsSummary summary={result.summary} />
      </div>

      <!-- Line items section -->
      <h3 class="section-heading">Billing Line Items</h3>
      <div class="line-items-list">
        {#each auditLineItems as lineItem, i}
          {@const finding = result.findings.find(f => f.lineItemIndex === i) ?? null}
          <LineItemCard item={lineItem} {finding} index={i} />
        {/each}
      </div>

      <!-- Dispute letter -->
      <div style="margin-top: 40px;">
        <DisputeLetter letter={result.disputeLetter} />
      </div>

      <!-- Share button -->
      <div style="margin-top: 24px; display: flex; justify-content: center;">
        <ShareButton potentialOvercharge={result.summary.potentialOvercharge} />
      </div>

      <!-- Disclaimer -->
      <p class="disclaimer">
        This tool flags potential issues for your review. A flagged item does not mean you were
        definitely overcharged — it means you have grounds to ask for an explanation.
        This is not legal or medical advice.
      </p>

    </main>
  {/if}
{/if}

<style>
  .trust-badge {
    display: inline-block;
    background: #F0FDFA;
    color: var(--accent);
    border: 1px solid #99F6E4;
    border-radius: 20px;
    padding: 6px 16px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .drop-zone {
    border: 2px dashed var(--border);
    border-radius: var(--radius);
    padding: 40px 24px;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
    margin-bottom: 8px;
    background: var(--bg-card);
  }
  .drop-zone:hover, .drop-zone.drag-over {
    border-color: var(--accent);
    background: #F0FDFA;
  }
  .drop-zone:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .upload-icon {
    font-size: 32px;
    color: var(--accent);
    margin-bottom: 4px;
  }

  .file-selected {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .file-icon { font-size: 24px; }
  .file-name { font-weight: 500; word-break: break-all; }

  .file-warning {
    color: var(--warning);
    font-size: 13px;
    text-align: center;
    margin: 4px 0 8px;
    background: #FFFBEB;
    border: 1px solid #FEF3C7;
    border-radius: var(--radius);
    padding: 8px 12px;
  }

  .error-banner {
    background: #FEF2F2;
    border: 1px solid #FECACA;
    color: var(--error);
    border-radius: var(--radius);
    padding: 12px 16px;
    font-size: 14px;
  }

  .privacy-note {
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    margin: 0;
  }

  .steps-list { display: flex; flex-direction: column; gap: 16px; }

  .step-row {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-muted);
    font-size: 15px;
    transition: color 0.2s;
  }
  .step-row.done { color: var(--success); }
  .step-row.active { color: var(--text-primary); font-weight: 500; }

  .step-indicator {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
  }

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  button:disabled { opacity: 0.4; cursor: not-allowed; }

  .results-subtitle {
    color: var(--text-muted);
    font-size: 14px;
    margin: 4px 0 0 0;
    padding-left: 2px;
  }

  .section-heading {
    font-size: 17px;
    font-weight: 600;
    margin: 0 0 16px;
    color: var(--text-primary);
  }

  .line-items-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .disclaimer {
    margin-top: 32px;
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    line-height: 1.6;
    max-width: 560px;
    margin-left: auto;
    margin-right: auto;
  }
</style>
