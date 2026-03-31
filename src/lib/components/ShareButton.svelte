<script lang="ts">
  import { trackShareCopied, trackShareTwitter } from '$lib/analytics'

  let { potentialOvercharge }: { potentialOvercharge: number } = $props()

  let copied = $state(false)

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

  async function copyShareText() {
    try {
      await navigator.clipboard.writeText(shareText)
      copied = true
      setTimeout(() => (copied = false), 2000)
      trackShareCopied()
    } catch {
      // silent
    }
  }
</script>

{#if potentialOvercharge > 0}
  <div class="share-section">
    <p class="share-kicker">Share with others</p>
    <div class="share-bubble card">
      <div class="share-quote-mark" aria-hidden="true">“</div>
      <p class="share-text">
        {shareText}
      </p>

      <div class="share-actions">
        <button class="share-action btn btn-secondary" onclick={copyShareText}>
          <span class="action-icon" aria-hidden="true">
            {#if copied}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            {:else}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            {/if}
          </span>
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>

        <a class="share-action btn btn-secondary" href={twitterUrl} target="_blank" rel="noopener noreferrer" onclick={trackShareTwitter}>
          <span class="action-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.9 2H22l-6.8 7.8L23.2 22H17l-4.8-6.2L6.8 22H3.7l7.3-8.4L.8 2h6.4l4.4 5.7L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
            </svg>
          </span>
          <span>Post</span>
        </a>
      </div>
    </div>
  </div>
{/if}

<style>
  .share-section {
    margin-top: 24px;
  }

  .share-kicker {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 12px;
  }

  .share-bubble {
    position: relative;
    padding: 20px 22px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: visible;
  }

  .share-quote-mark {
    font-family: var(--font-display);
    font-size: 56px;
    line-height: 1;
    color: var(--border);
    margin-bottom: -8px;
    user-select: none;
  }

  .share-text {
    margin: 0;
    font-size: 14px;
    line-height: 1.7;
    color: var(--text-secondary);
  }

  .share-actions {
    display: flex;
    gap: 10px;
    margin-top: 18px;
    flex-wrap: wrap;
  }

  .share-action {
    gap: 8px;
    min-width: 116px;
    justify-content: center;
  }

  .action-icon {
    display: inline-flex;
    width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .action-icon svg {
    width: 18px;
    height: 18px;
    display: block;
  }
</style>
