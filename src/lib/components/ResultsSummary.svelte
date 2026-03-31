<script lang="ts">
  import type { AuditResult } from '$lib/types'

  let { summary }: { summary: AuditResult['summary'] } = $props()

  type ExtendedSummary = AuditResult['summary'] & {
    aboveHospitalListCount?: number
    aboveHospitalListTotal?: number
    hospitalName?: string
    hospitalMrfUrl?: string
  }

  const extendedSummary = $derived(summary as ExtendedSummary)
  const showHospitalStat = $derived((extendedSummary.aboveHospitalListCount ?? 0) > 0)

  function formatDollars(n: number): string {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}K`
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
  }
</script>

<div class="summary-strip" class:five-col={showHospitalStat}>
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
  {#if showHospitalStat}
    <div class="stat hospital-above">
      <span class="stat-value">{extendedSummary.aboveHospitalListCount}</span>
      <span class="stat-label">Above hospital's own price list</span>
    </div>
  {/if}
</div>

{#if extendedSummary.hospitalMrfUrl}
  <p class="mrf-attribution">
    Hospital prices sourced from
    <a href={extendedSummary.hospitalMrfUrl} target="_blank" rel="noopener noreferrer">
      {extendedSummary.hospitalName ?? 'this hospital'}'s required CMS price transparency file ↗
    </a>
  </p>
{/if}

<style>
  .summary-strip {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin-bottom: 28px;
  }

  .summary-strip.five-col {
    grid-template-columns: 1fr 1fr 1fr 1fr 1fr;
  }

  @media (max-width: 600px) {
    .summary-strip,
    .summary-strip.five-col {
      grid-template-columns: 1fr 1fr;
    }
  }

  .stat {
    background: var(--bg-card);
    padding: 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    text-align: left;
  }

  .stat::before {
    content: '';
    display: block;
    height: 3px;
    border-radius: 2px;
    width: 28px;
    margin-bottom: 6px;
    background: var(--border-strong);
  }

  .stat-value {
    font-family: var(--font-mono);
    font-size: 26px;
    font-weight: 600;
    line-height: 1;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }

  .stat-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    line-height: 1.3;
  }

  .stat.error::before { background: var(--error); }
  .stat.warning::before { background: var(--warning); }
  .stat.overcharge::before { background: var(--text-primary); }
  .stat.clean::before { background: var(--success); }

  .stat.error .stat-value { color: var(--error); }
  .stat.warning .stat-value { color: var(--warning); }
  .stat.overcharge .stat-value { font-size: 22px; }
  .stat.clean .stat-value { color: var(--success); }

  .stat.hospital-above {
    border-color: #BFDBFE;
    background: #EFF6FF;
  }

  .stat.hospital-above::before {
    background: #1D4ED8;
  }

  .stat.hospital-above .stat-value {
    color: #1D4ED8;
  }

  .mrf-attribution {
    font-size: 11px;
    color: var(--text-muted);
    margin: 4px 0 20px;
    text-align: right;
  }

  .mrf-attribution a {
    color: var(--accent);
    text-decoration: none;
  }

  .mrf-attribution a:hover {
    text-decoration: underline;
  }
</style>
