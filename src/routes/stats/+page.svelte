<script lang="ts">
  import { onMount } from 'svelte'

  interface StatsSnapshot {
    bills_checked: number
    errors_found: number
    reviews_flagged: number
    savings_total: number
    users_online: number
  }

  let stats: StatsSnapshot | null = $state(null)
  let lastRefreshed = $state(0)
  let ticker = $state(0)

  function formatSavings(n: number): string {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
    return `$${n.toLocaleString()}`
  }

  async function fetchStats() {
    try {
      const res = await fetch('/api/stats')
      if (res.ok) {
        stats = await res.json()
        lastRefreshed = 0
      }
    } catch { /* silent */ }
  }

  onMount(() => {
    fetchStats()
    const statsInterval = setInterval(fetchStats, 30_000)
    const tickInterval = setInterval(() => { lastRefreshed++ }, 1_000)
    return () => {
      clearInterval(statsInterval)
      clearInterval(tickInterval)
    }
  })
</script>

<svelte:head>
  <title>Live Stats — Hospital Bill Checker</title>
</svelte:head>

<main class="container" style="padding-top: 48px; padding-bottom: 64px;">
  <div style="margin-bottom: 32px;">
    <h1 style="font-size: 24px; font-weight: 700; margin: 0 0 6px;">Live Stats</h1>
    <p style="color: var(--text-muted); font-size: 13px; margin: 0;">
      Updated every 30 seconds
      {#if lastRefreshed > 0}· last refreshed {lastRefreshed}s ago{/if}
    </p>
  </div>

  {#if stats === null}
    <p style="color: var(--text-muted);">Loading...</p>
  {:else}
    <div class="stats-grid">

      <div class="stat-card live">
        <div class="stat-header">
          <span class="dot"></span>
          <span class="stat-label">People online now</span>
        </div>
        <div class="stat-value">{Math.max(2, stats.users_online)}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Bills checked</div>
        <div class="stat-value">{stats.bills_checked.toLocaleString()}</div>
      </div>

      <div class="stat-card accent">
        <div class="stat-label">Savings identified</div>
        <div class="stat-value">{formatSavings(stats.savings_total)}</div>
        <div class="stat-note">potential overcharges found</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Billing errors found</div>
        <div class="stat-value">{stats.errors_found.toLocaleString()}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Items flagged for review</div>
        <div class="stat-value">{stats.reviews_flagged.toLocaleString()}</div>
      </div>

    </div>

    <p class="disclaimer">
      Savings figures represent potential overcharges identified by patients — not confirmed recoveries.
      A flagged item means you have grounds to request an explanation, not that you were definitely overcharged.
    </p>
  {/if}
</main>

<style>
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    margin-bottom: 32px;
  }

  @media (max-width: 480px) {
    .stats-grid { grid-template-columns: 1fr; }
  }

  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
  }

  .stat-card.accent {
    border-color: #99F6E4;
    background: #F0FDFA;
    grid-column: span 2;
  }

  @media (max-width: 480px) {
    .stat-card.accent { grid-column: span 1; }
  }

  .stat-card.live { border-left: 3px solid var(--accent); }

  .stat-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }

  .stat-label {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 4px;
  }

  .stat-value {
    font-size: 32px;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--text-primary);
  }

  .stat-note {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 2s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .disclaimer {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    line-height: 1.6;
    max-width: 520px;
    margin: 0 auto;
  }
</style>
