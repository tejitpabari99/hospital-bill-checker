<script lang="ts">
  import type { LineItem, AuditFinding } from '$lib/types'

  let { item, finding, index }: { item: LineItem, finding: AuditFinding | null, index: number } = $props()

  let expanded = $state(false)

  function formatDollars(n: number) {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const severityLabel = $derived(
    finding?.severity === 'error' ? 'ERROR' :
    finding?.severity === 'warning' ? 'REVIEW' : '✓'
  )
  const severityClass = $derived(
    finding?.severity === 'error' ? 'badge-error' :
    finding?.severity === 'warning' ? 'badge-warning' : 'badge-clean'
  )
</script>

<div class="line-item" class:has-finding={!!finding} onclick={() => expanded = !expanded} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && (expanded = !expanded)} aria-expanded={expanded}>
  <div class="item-main">
    <div class="item-left">
      <span class="badge {severityClass}">{severityLabel}</span>
      <div class="item-info">
        <span class="item-code">{item.cpt}</span>
        {#if item.description}
          <span class="item-desc">{item.description}</span>
        {/if}
        {#if finding}
          <span class="item-error-type">{finding.errorType.replace(/_/g, ' ')}</span>
        {/if}
      </div>
    </div>
    <div class="item-right">
      <span class="item-amount">{formatDollars(item.billedAmount)}</span>
      <span class="expand-toggle">{expanded ? '▲' : '▼'}</span>
    </div>
  </div>

  {#if expanded}
    <div class="item-detail">
      {#if finding}
        <p class="detail-description">{finding.description}</p>
        <div class="detail-grid">
          {#if finding.medicareRate}
            <span class="detail-label">Medicare rate</span>
            <span class="detail-value">{formatDollars(finding.medicareRate)}</span>
          {/if}
          {#if finding.markupRatio}
            <span class="detail-label">Markup ratio</span>
            <span class="detail-value {finding.markupRatio > 4.5 ? 'text-error' : 'text-warning'}">{finding.markupRatio.toFixed(1)}×</span>
          {/if}
          {#if finding.ncciBundledWith}
            <span class="detail-label">Bundled into</span>
            <span class="detail-value">{finding.ncciBundledWith}</span>
          {/if}
          {#if item.icd10Codes?.length}
            <span class="detail-label">Diagnosis codes</span>
            <span class="detail-value">{item.icd10Codes.join(', ')}</span>
          {/if}
        </div>
        <div class="detail-recommendation">
          <strong>What to do:</strong> {finding.recommendation}
        </div>
      {:else}
        <p class="detail-clean">This charge looks consistent with standard billing practices.</p>
        {#if item.icd10Codes?.length}
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
    transition: border-color 0.15s;
    user-select: none;
  }
  .line-item:hover { border-color: #D1D5DB; }
  .line-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .line-item.has-finding { border-left-width: 3px; }
  .line-item.has-finding:has(.badge-error) { border-left-color: var(--error); }
  .line-item.has-finding:has(.badge-warning) { border-left-color: var(--warning); }

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
    font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
    padding: 2px 6px; border-radius: 4px; white-space: nowrap; flex-shrink: 0;
  }
  .badge-error { background: #FEF2F2; color: var(--error); }
  .badge-warning { background: #FFFBEB; color: var(--warning); }
  .badge-clean { background: #F0FDF4; color: var(--success); }

  .item-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .item-code { font-family: var(--font-mono); font-size: 13px; font-weight: 600; }
  .item-desc { font-size: 13px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item-error-type { font-size: 11px; color: var(--warning); text-transform: uppercase; letter-spacing: 0.04em; }

  .item-amount { font-weight: 600; font-size: 15px; font-family: var(--font-mono); }
  .expand-toggle { font-size: 10px; color: var(--text-muted); }

  .item-detail {
    padding: 12px 16px 16px;
    border-top: 1px solid var(--border);
    background: #FAFAFA;
    animation: expand 0.15s ease-out;
  }
  @keyframes expand { from { opacity: 0; } to { opacity: 1; } }

  .detail-description { margin: 0 0 12px; font-size: 14px; line-height: 1.5; }
  .detail-clean { margin: 0; font-size: 14px; color: var(--success); }
  .detail-meta { margin: 8px 0 0; font-size: 13px; color: var(--text-muted); }

  .detail-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  .detail-label { color: var(--text-muted); }
  .detail-value { font-weight: 500; font-family: var(--font-mono); }
  .text-error { color: var(--error); }
  .text-warning { color: var(--warning); }

  .detail-recommendation {
    font-size: 13px;
    background: #F0FDFA;
    border: 1px solid #99F6E4;
    border-radius: 6px;
    padding: 8px 12px;
    line-height: 1.4;
  }
</style>
