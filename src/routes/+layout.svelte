<script lang="ts">
  import '../app.css'
  import { onMount } from 'svelte'
  import LiveBanner from '$lib/components/LiveBanner.svelte'
  import { page } from '$app/stores'

  let { children, data } = $props()

  let stats = $state<{ bills_checked: number; savings_total: number; users_online: number } | null>(null)

  $effect(() => {
    stats = data.initialStats ?? null
  })

  $effect(() => {
    const url = $page.url
    if (typeof window !== 'undefined' && (window as any).gtag) {
      ;(window as any).gtag('event', 'page_view', {
        page_location: url.href,
        page_path: url.pathname,
      })
    }
  })

  onMount(() => {
    let sid = sessionStorage.getItem('hbc_sid') ?? ''
    if (!sid) {
      sid = crypto.randomUUID()
      sessionStorage.setItem('hbc_sid', sid)
    }

    async function fetchStats() {
      try {
        await fetch('/api/stats/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        })
        const [statsRes, liveRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/live-users'),
        ])
        if (statsRes.ok) {
          const statsData = await statsRes.json()
          let usersOnline = statsData.users_online
          if (liveRes.ok) {
            const liveData = await liveRes.json()
            usersOnline = liveData.active_users
          }
          stats = {
            bills_checked: statsData.bills_checked,
            savings_total: statsData.savings_total,
            users_online: usersOnline,
          }
        }
      } catch { /* silent */ }
    }

    fetchStats()
    const interval = setInterval(fetchStats, 15_000)
    return () => clearInterval(interval)
  })
</script>

{#if stats !== null}
  <LiveBanner
    billsChecked={stats.bills_checked}
    savingsTotal={stats.savings_total}
    usersOnline={stats.users_online}
  />
{/if}

<nav class="site-nav" aria-label="Main navigation">
  <a href="/">Home</a>
  <a href="/how-it-works">How it works</a>
  <a href="/learn">Learn</a>
  <a href="/data">Data</a>
</nav>

{@render children()}

<style>
  .site-nav {
    display: flex;
    justify-content: center;
    gap: 18px;
    padding: 14px 16px;
    border-bottom: 1px solid #e2e8f0;
    background: #ffffff;
  }

  .site-nav a {
    color: #475569;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
  }

  .site-nav a:hover {
    color: #0f172a;
    text-decoration: underline;
  }

  @media (max-width: 480px) {
    .site-nav {
      gap: 12px;
      overflow-x: auto;
      justify-content: flex-start;
    }

    .site-nav a {
      flex: 0 0 auto;
    }
  }
</style>
