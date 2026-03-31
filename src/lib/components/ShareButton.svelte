<script lang="ts">
  import { trackShareCopied, trackShareOpened } from '$lib/analytics'

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
  const linkedinUrl = $derived(
    `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(shareText)}`
  )
  const facebookUrl = $derived(
    `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(appUrl)}&quote=${encodeURIComponent(shareText)}`
  )
  const whatsappUrl = $derived(
    `https://wa.me/?text=${encodeURIComponent(shareText)}`
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

        <a class="share-action btn btn-secondary" href={twitterUrl} target="_blank" rel="noopener noreferrer" onclick={() => trackShareOpened('twitter')}>
          <span class="action-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.9 2H22l-6.8 7.8L23.2 22H17l-4.8-6.2L6.8 22H3.7l7.3-8.4L.8 2h6.4l4.4 5.7L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
            </svg>
          </span>
          <span>Post</span>
        </a>

        <a class="share-action btn btn-secondary" href={linkedinUrl} target="_blank" rel="noopener noreferrer" onclick={() => trackShareOpened('linkedin')}>
          <span class="action-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.94 8.5H3.56V20h3.38V8.5Zm.22-3.56A1.95 1.95 0 0 0 5.2 3 1.95 1.95 0 0 0 3.25 4.94c0 1.06.87 1.94 1.95 1.94 1.09 0 1.96-.88 1.96-1.94ZM20.75 13.09c0-3.38-1.8-4.95-4.19-4.95-1.93 0-2.8 1.06-3.28 1.8V8.5H9.91c.04.96 0 11.5 0 11.5h3.37v-6.42c0-.34.02-.68.13-.92.27-.68.88-1.39 1.92-1.39 1.36 0 1.9 1.04 1.9 2.56V20H20.6v-6.91Z" />
            </svg>
          </span>
          <span>LinkedIn</span>
        </a>

        <a class="share-action btn btn-secondary" href={facebookUrl} target="_blank" rel="noopener noreferrer" onclick={() => trackShareOpened('facebook')}>
          <span class="action-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M13.5 21v-7.13h2.4l.36-2.79H13.5V9.3c0-.8.22-1.35 1.37-1.35h1.46V5.45A19.4 19.4 0 0 0 14.2 5.3c-2.12 0-3.58 1.3-3.58 3.67v2.11H8.2v2.79h2.42V21h2.88Z" />
            </svg>
          </span>
          <span>Facebook</span>
        </a>

        <a class="share-action btn btn-secondary" href={whatsappUrl} target="_blank" rel="noopener noreferrer" onclick={() => trackShareOpened('whatsapp')}>
          <span class="action-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.52 3.48A11.86 11.86 0 0 0 12.03 0 11.9 11.9 0 0 0 1.87 17.94L0 24l6.23-1.83A11.9 11.9 0 0 0 12.03 24h.01c6.57 0 11.92-5.35 11.92-11.92 0-3.18-1.24-6.17-3.44-8.6ZM12.04 21.8h-.01a9.72 9.72 0 0 1-4.95-1.35l-.35-.21-3.7 1.09 1.1-3.6-.23-.37a9.71 9.71 0 0 1-1.49-5.18c0-5.37 4.37-9.74 9.74-9.74 2.6 0 5.04 1.01 6.88 2.86a9.67 9.67 0 0 1 2.85 6.88c0 5.37-4.37 9.74-9.74 9.74Zm5.34-7.3c-.29-.15-1.72-.85-1.98-.94-.27-.1-.46-.15-.66.14-.2.3-.76.94-.94 1.13-.17.2-.34.22-.63.08-.29-.15-1.24-.46-2.36-1.46-.88-.79-1.47-1.76-1.64-2.06-.17-.29-.02-.45.13-.6.13-.13.29-.34.43-.51.14-.17.19-.29.29-.49.1-.2.05-.37-.02-.52-.08-.15-.66-1.6-.91-2.2-.24-.57-.48-.49-.66-.5h-.56c-.2 0-.52.08-.79.37-.27.29-1.04 1.01-1.04 2.46s1.06 2.86 1.21 3.06c.15.2 2.09 3.2 5.07 4.48.71.31 1.27.49 1.7.63.71.23 1.35.2 1.86.12.57-.09 1.72-.7 1.97-1.38.24-.68.24-1.26.17-1.38-.07-.12-.27-.2-.56-.34Z" />
            </svg>
          </span>
          <span>WhatsApp</span>
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
