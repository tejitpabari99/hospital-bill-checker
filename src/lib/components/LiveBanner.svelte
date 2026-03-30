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
    background: #065F46;
    color: #D1FAE5;
    font-size: 14px;
    height: 40px;
    display: flex;
    align-items: center;
  }

  .notif-inner {
    width: 100%;
    max-width: 960px;
    margin: 0 auto;
    padding: 0 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    position: relative;
  }

  .notif-content {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .notif-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .notif-item strong {
    color: #ECFDF5;
    font-weight: 600;
  }

  .sep {
    color: #34D399;
    opacity: 0.4;
  }

  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #34D399;
    animation: blink 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.15; }
  }

  .stats-link {
    color: #6EE7B7;
    font-size: 13px;
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    flex-shrink: 0;
    transition: color 0.15s;
    position: absolute;
    right: 20px;
  }

  .stats-link:hover {
    color: #ECFDF5;
  }
</style>
