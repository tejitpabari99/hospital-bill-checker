<script lang="ts">
  import type { LineItem, AuditFinding } from '$lib/types'
  import { trackLineItemExpanded, trackCptCodeLookup } from '$lib/analytics'
  import { getDisplayDescription } from '$lib/results'

  let { item, finding, index }: { item?: LineItem, finding: AuditFinding | null, index: number } = $props()

  let expanded = $state(false)

  type ExtendedFinding = AuditFinding & {
    hospitalGrossCharge?: number
    hospitalCashPrice?: number
    hospitalPriceSource?: string
  }

  function formatDollars(n: number) {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const extendedFinding = $derived(finding as ExtendedFinding | null)
  const isSummaryFinding = $derived(finding?.lineItemIndex === -1 || !item)
  const codeForDisplay = $derived(finding?.cptCode ?? item?.cpt ?? 'SUMMARY')
  const summaryLabel = $derived(
    isSummaryFinding ? 'BILL LEVEL' : (
      finding?.severity === 'error' ? 'ERROR' :
      finding?.severity === 'warning' ? 'REVIEW' : '✓'
    )
  )

  const severityClass = $derived(
    finding?.severity === 'error' ? 'badge-error' :
    finding?.severity === 'warning' ? 'badge-warning' : 'badge-clean'
  )
  const displayDescription = $derived(
    isSummaryFinding
      ? finding?.standardDescription?.trim() || finding?.description?.trim() || 'Bill-level finding'
      : getDisplayDescription(item as LineItem, finding)
  )

  function aapcUrl(code: string) {
    return `https://www.aapc.com/codes/cpt-codes/${code}`
  }

  // Returns { expected: number | null, zeroLabel: string | null } for the price comparison row.
  // expected === null means skip the row entirely.
  // zeroLabel is set when expected is $0 to explain why.
  const priceComparison = $derived((() => {
    if (!finding || !item || item.billedAmount <= 0 || isSummaryFinding) return null
    const t = finding.errorType
    if (t === 'upcoding') {
      if (finding.medicareRate == null) return null
      return { expected: finding.medicareRate, zeroLabel: null }
    }
    if (t === 'unbundling') {
      return { expected: 0, zeroLabel: 'should not be billed separately' }
    }
    if (t === 'duplicate') {
      return { expected: 0, zeroLabel: 'duplicate charge should be $0' }
    }
    if (t === 'pharmacy_markup') {
      if (finding.medicareRate != null) {
        return { expected: finding.medicareRate, zeroLabel: null }
      }
      // Derive expected from markup ratio: expected = billed / ratio
      if (finding.markupRatio != null && finding.markupRatio > 0) {
        return { expected: item.billedAmount / finding.markupRatio, zeroLabel: null }
      }
      return null
    }
    if (t === 'icd10_mismatch') {
      return { expected: 0, zeroLabel: 'charge not justified by diagnosis' }
    }
    return null
  })())

  const hospitalPriceComparison = $derived((() => {
    const f = extendedFinding
    if (!f || !item || item.billedAmount <= 0 || isSummaryFinding) return null
    const hospitalPrice = f.hospitalGrossCharge ?? f.hospitalCashPrice ?? null
    if (hospitalPrice == null) return null
    return {
      price: hospitalPrice,
      label: f.hospitalGrossCharge != null ? 'Hospital gross charge' : 'Hospital cash price',
      source: f.hospitalPriceSource ?? null,
      overcharge: item.billedAmount > hospitalPrice ? item.billedAmount - hospitalPrice : null,
    }
  })())
</script>

<div
  class="line-item"
  class:has-finding={!!finding}
  class:summary-level={isSummaryFinding}
  onclick={() => {
    if (isSummaryFinding) {
      expanded = !expanded
      return
    }
    if (!expanded && item) trackLineItemExpanded(item.cpt)
    expanded = !expanded
  }}
  role="button"
  tabindex="0"
  onkeydown={(e) => e.key === 'Enter' && (expanded = !expanded)}
  aria-expanded={expanded}
>
  <div class="item-main">
    <div class="item-left">
      <span class="badge {isSummaryFinding ? 'badge-summary' : severityClass}">{summaryLabel}</span>
      <div class="item-info">
        <span class="item-code">
          {codeForDisplay}
          {#if item && !isSummaryFinding}
            <a
              class="aapc-link"
              href={aapcUrl(item.cpt)}
              target="_blank"
              rel="noopener noreferrer"
              onclick={(e) => { e.stopPropagation(); trackCptCodeLookup(item.cpt) }}
            >Look up code ↗</a>
          {/if}
        </span>
        {#if displayDescription}
          <span class="item-desc">{displayDescription}</span>
        {/if}
        {#if finding}
          <span class="item-error-type">{finding.errorType.replace(/_/g, ' ')}</span>
        {/if}
      </div>
    </div>
    <div class="item-right">
      {#if item && !isSummaryFinding}
        <span class="item-amount">{formatDollars(item.billedAmount)}</span>
      {:else}
        <span class="item-amount item-amount-summary">Bill-level</span>
      {/if}
      <span class="expand-toggle">{expanded ? '▲' : '▼'}</span>
    </div>
  </div>

  {#if expanded}
    <div class="item-detail">
      {#if finding}
        <p class="detail-description">{finding.description}</p>
        {#if priceComparison && item}
          <div class="price-comparison">
            <span class="pc-billed">Billed: <span class="pc-mono">{formatDollars(item.billedAmount)}</span></span>
            <span class="pc-arrow">→</span>
            <span class="pc-expected">Medicare expected: <span class="pc-mono">{formatDollars(priceComparison.expected)}</span></span>
            {#if priceComparison.zeroLabel}
              <span class="pc-save pc-zero">({priceComparison.zeroLabel})</span>
            {:else}
              <span class="pc-save">(save ~<span class="pc-mono">{formatDollars(item.billedAmount - priceComparison.expected)}</span>)</span>
            {/if}
          </div>
        {/if}
        {#if hospitalPriceComparison && item}
          <div class="price-comparison hospital-price">
            <span class="pc-billed">Billed: <span class="pc-mono">{formatDollars(item.billedAmount)}</span></span>
            <span class="pc-arrow">→</span>
            <span class="pc-expected">
              {hospitalPriceComparison.label}: <span class="pc-mono">{formatDollars(hospitalPriceComparison.price)}</span>
            </span>
            {#if hospitalPriceComparison.overcharge != null}
              <span class="pc-save pc-hospital-flag">
                ({formatDollars(hospitalPriceComparison.overcharge)} above hospital's own price list)
              </span>
            {:else}
              <span class="pc-save pc-zero">(within hospital's published price)</span>
            {/if}
          </div>
          {#if hospitalPriceComparison.source}
            <p class="hospital-mrf-source">
              Source: hospital's required CMS price transparency file
              <a
                href={hospitalPriceComparison.source}
                target="_blank"
                rel="noopener noreferrer"
                onclick={(e) => e.stopPropagation()}
              >View file ↗</a>
            </p>
          {/if}
        {/if}
        <div class="detail-grid">
          {#if finding.medicareRate}
            <span class="detail-label">Medicare rate</span>
            <span class="detail-value">{formatDollars(finding.medicareRate)}</span>
          {/if}
          {#if extendedFinding?.hospitalGrossCharge != null}
            <span class="detail-label">Hospital gross charge</span>
            <span class="detail-value">{formatDollars(extendedFinding.hospitalGrossCharge)}</span>
          {/if}
          {#if extendedFinding?.hospitalCashPrice != null}
            <span class="detail-label">Hospital cash price</span>
            <span class="detail-value">{formatDollars(extendedFinding.hospitalCashPrice)}</span>
          {/if}
          {#if finding.markupRatio}
            <span class="detail-label">Markup ratio</span>
            <span class="detail-value {finding.markupRatio > 4.5 ? 'text-error' : 'text-warning'}">
              {finding.markupRatio.toFixed(1)}× above CMS limit
            </span>
          {/if}
          {#if finding.ncciBundledWith}
            <span class="detail-label">Bundled into</span>
            <span class="detail-value">
              <a
                class="code-link"
                href={aapcUrl(finding.ncciBundledWith)}
                target="_blank"
                rel="noopener noreferrer"
                onclick={(e) => e.stopPropagation()}
              >{finding.ncciBundledWith} ↗</a>
            </span>
          {/if}
          {#if item?.icd10Codes?.length}
            <span class="detail-label">Diagnosis codes</span>
            <span class="detail-value">{item.icd10Codes.join(', ')}</span>
          {/if}
        </div>
        <div class="detail-recommendation">
          <strong>What to do:</strong> {finding.recommendation}
        </div>
      {:else}
        <p class="detail-clean">This charge looks consistent with standard billing practices.</p>
        {#if item?.icd10Codes?.length}
          <p class="detail-meta">Diagnosis codes: {item.icd10Codes.join(', ')}</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
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
  .line-item:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
  .line-item.has-finding { border-left-width: 3px; }
  .line-item.has-finding:has(.badge-error) { border-left-color: var(--error); }
  .line-item.has-finding:has(.badge-warning) { border-left-color: var(--warning); }
  .line-item.summary-level {
    border-style: dashed;
    background: linear-gradient(180deg, var(--bg-card) 0%, rgba(250, 250, 250, 0.85) 100%);
  }

  .item-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    gap: 12px;
  }

  .item-left { display: flex; align-items: flex-start; gap: 10px; flex: 1; min-width: 0; }
  .item-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

  .badge {
    display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--font-mono);
    font-size: 9px; font-weight: 600; letter-spacing: 0.08em;
    padding: 3px 6px; border-radius: 3px; white-space: nowrap; flex-shrink: 0;
  }
  .badge-error { background: var(--error-bg); color: var(--error); border: 1px solid var(--error-border); }
  .badge-warning { background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning-border); }
  .badge-clean { background: var(--success-bg); color: var(--success); border: 1px solid var(--success-border); }
  .badge-summary { background: #EEF2FF; color: #4338CA; border: 1px solid #C7D2FE; }

  .item-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .item-code { font-family: var(--font-mono); font-size: 13px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; letter-spacing: 0.02em; }
  .aapc-link {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 400;
    color: var(--text-ghost);
    text-decoration: none;
    letter-spacing: 0;
  }
  .aapc-link:hover { color: var(--accent); text-decoration: underline; }
  .item-desc { font-size: 13px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-sans); }
  .item-error-type { font-size: 10px; font-weight: 700; color: var(--warning); text-transform: uppercase; letter-spacing: 0.07em; font-family: var(--font-mono); }

  .item-amount { font-weight: 600; font-size: 14px; font-family: var(--font-mono); color: var(--text-primary); letter-spacing: 0.01em; }
  .item-amount-summary { font-family: var(--font-sans); font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.07em; }
  .expand-toggle { font-size: 10px; color: var(--text-ghost); }
  .line-item:hover .expand-toggle { color: var(--text-muted); }

  .item-detail {
    padding: 14px 16px 16px;
    border-top: 1px solid var(--border);
    background: var(--bg-subtle);
    animation: expand 0.15s ease-out;
  }
  @keyframes expand {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .detail-description { margin: 0 0 14px; font-size: 14px; line-height: 1.6; color: var(--text-secondary); }
  .detail-clean { margin: 0; font-size: 14px; color: var(--success); font-weight: 500; }
  .detail-meta { margin: 8px 0 0; font-size: 13px; font-family: var(--font-mono); color: var(--text-muted); }

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
  .price-comparison.hospital-price {
    background: #EFF6FF;
    border-color: #BFDBFE;
  }
  .pc-mono { font-family: var(--font-mono); }
  .pc-arrow { color: var(--border-strong); }
  .pc-billed { color: var(--text-muted); }
  .pc-expected { font-weight: 600; color: var(--text-primary); }
  .pc-save { color: var(--success); font-size: 12px; }
  .pc-zero { color: var(--text-muted); font-style: italic; font-family: var(--font-sans); }
  .pc-hospital-flag { color: #1D4ED8; font-size: 12px; font-weight: 600; }

  .hospital-mrf-source {
    font-size: 11px;
    color: var(--text-muted);
    margin: 4px 0 10px;
    padding: 0;
  }
  .hospital-mrf-source a {
    color: var(--accent);
    text-decoration: none;
  }
  .hospital-mrf-source a:hover {
    text-decoration: underline;
  }

  .code-link {
    font-family: var(--font-mono);
    font-weight: 500;
    color: inherit;
    text-decoration: none;
  }
  .code-link:hover { text-decoration: underline; }

  .detail-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 20px;
    font-size: 13px;
    margin-bottom: 14px;
  }
  .detail-label { color: var(--text-muted); font-size: 12px; }
  .detail-value { font-weight: 500; font-family: var(--font-mono); color: var(--text-primary); }
  .text-error { color: var(--error); }
  .text-warning { color: var(--warning); }

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

  @media (max-width: 480px) {
    .item-desc {
      display: none;
    }

    .item-amount {
      font-size: 13px;
    }
  }
</style>
