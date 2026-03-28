<script lang="ts">
  import type { AuditResult } from '$lib/types'

  let { summary }: { summary: AuditResult['summary'] } = $props()

  function formatDollars(n: number): string {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}K`
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
  }
</script>

<div class="summary-strip">
  <div class="stat error">
    <span class="stat-value">{summary.errorCount}</span>
    <span class="stat-label">Likely {summary.errorCount === 1 ? 'error' : 'errors'}</span>
  </div>
  <div class="stat warning">
    <span class="stat-value">{summary.warningCount}</span>
    <span class="stat-label">Worth reviewing</span>
  </div>
  <div class="stat overcharge">
    <span class="stat-value">{formatDollars(summary.potentialOvercharge)}</span>
    <span class="stat-label">Potential overcharge</span>
  </div>
  <div class="stat clean">
    <span class="stat-value">{summary.cleanCount}</span>
    <span class="stat-label">{summary.cleanCount === 1 ? 'Code looks' : 'Codes look'} fine</span>
  </div>
</div>

<style>
  .summary-strip {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 12px;
    margin-bottom: 24px;
  }
  @media (max-width: 600px) {
    .summary-strip { grid-template-columns: 1fr 1fr; }
  }

  .stat {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 12px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .stat-value {
    font-size: 24px;
    font-weight: 700;
    line-height: 1;
  }
  .stat-label {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.3;
  }

  .stat.error .stat-value { color: var(--error); }
  .stat.warning .stat-value { color: var(--warning); }
  .stat.overcharge .stat-value { color: var(--text-primary); font-size: 22px; }
  .stat.clean .stat-value { color: var(--success); }
</style>
