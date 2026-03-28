<script lang="ts">
  let { potentialOvercharge }: { potentialOvercharge: number } = $props()

  let shared = $state(false)
  let copied = $state(false)
  let sharing = $state(false)

  const appUrl = 'https://hospital-bill-checker.vercel.app'

  function formatDollars(n: number): string {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
    return `$${Math.round(n).toLocaleString()}`
  }

  const shareText = $derived(
    `I found ${formatDollars(potentialOvercharge)} in potential billing errors using Hospital Bill Checker — free, open source, no login. Check your bill: ${appUrl}`
  )

  const twitterUrl = $derived(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`
  )

  async function handleShare() {
    if (sharing) return
    sharing = true
    try {
      await fetch('/api/savings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Math.round(potentialOvercharge) }),
      })
    } catch {
      // silent — counter is best-effort
    }
    sharing = false
    shared = true
  }

  async function copyShareText() {
    try {
      await navigator.clipboard.writeText(shareText)
      copied = true
      setTimeout(() => (copied = false), 2000)
    } catch {
      // silent
    }
  }
</script>

{#if potentialOvercharge > 0}
  <div class="share-section">
    {#if !shared}
      <div class="share-prompt card" style="padding: 20px; text-align: center;">
        <p style="margin: 0 0 12px; font-size: 15px;">
          Found <strong style="color: var(--accent);">{formatDollars(potentialOvercharge)}</strong> in potential overcharges?
        </p>
        <button class="btn btn-primary" onclick={handleShare} disabled={sharing}>
          {sharing ? 'Sharing...' : 'Share your savings'}
        </button>
        <p style="margin: 8px 0 0; font-size: 12px; color: var(--text-muted);">
          Adds to our public counter anonymously — helps others know this tool works.
        </p>
      </div>
    {:else}
      <div class="share-expanded card" style="padding: 20px;">
        <p style="margin: 0 0 12px; font-size: 14px; font-weight: 500; text-align: center;">
          Share with others:
        </p>
        <div class="share-text-box">
          <p style="margin: 0; font-size: 13px; color: var(--text-muted); line-height: 1.5;">
            {shareText}
          </p>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; justify-content: center;">
          <button class="btn btn-secondary" onclick={copyShareText}>
            {copied ? '✓ Copied!' : 'Copy text'}
          </button>
          <a class="btn btn-secondary" href={twitterUrl} target="_blank" rel="noopener noreferrer">
            Post on X
          </a>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .share-section {
    margin-top: 24px;
  }

  .share-text-box {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
  }
</style>
