<script lang="ts">
  let { billsChecked, savingsTotal, usersOnline }: {
    billsChecked: number
    savingsTotal: number
    usersOnline: number
  } = $props()

  const displayUsers = $derived(Math.max(2, usersOnline))

  function formatSavings(n: number): string {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
    return `$${n.toLocaleString()}`
  }
</script>

<div class="notif-bar">
  <div class="notif-inner">
    <div class="notif-content">
      <span class="dot"></span>
      <span class="notif-item"><strong>{displayUsers}</strong> checking bills now</span>
      <span class="sep">·</span>
      <span class="notif-item"><strong>{formatSavings(savingsTotal)}</strong> saved</span>
      <span class="sep">·</span>
      <span class="notif-item"><strong>{billsChecked.toLocaleString()}</strong> bills checked</span>
    </div>
    <a href="/stats" class="stats-link" target="_blank" rel="noopener noreferrer">Stats →</a>
  </div>
</div>

<style>
  .notif-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    background: var(--bg-ink);
    color: var(--text-on-dark);
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.02em;
    height: 40px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .notif-inner {
    width: 100%;
    max-width: var(--container-wide, 900px);
    margin: 0 auto;
    padding: 0 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    position: relative;
  }

  .notif-content {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .notif-item {
    display: flex;
    align-items: center;
    gap: 5px;
    color: rgba(245, 244, 240, 0.65);
  }

  .notif-item strong {
    color: #F5F4F0;
    font-weight: 600;
  }

  .sep {
    color: rgba(245, 244, 240, 0.2);
    font-size: 10px;
  }

  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-mid, #4A9970);
    animation: blink 2s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.2; }
  }

  .stats-link {
    color: rgba(245, 244, 240, 0.45);
    font-size: 11px;
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    flex-shrink: 0;
    transition: color 0.15s;
    position: absolute;
    right: 24px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .stats-link:hover {
    color: #F5F4F0;
  }
</style>
