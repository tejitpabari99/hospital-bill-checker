<script lang="ts">
  import type { DisputeLetter } from '$lib/types'

  let { letter }: { letter: DisputeLetter } = $props()

  let copied = $state(false)

  // Parse letter text into segments: plain text or placeholder
  type Segment = { type: 'text'; content: string } | { type: 'placeholder'; content: string }

  const segments = $derived.by<Segment[]>(() => {
    const parts: Segment[] = []
    const regex = /(\[[^\]]+\])/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(letter.text)) !== null) {
      if (match.index > last) parts.push({ type: 'text', content: letter.text.slice(last, match.index) })
      parts.push({ type: 'placeholder', content: match[1] })
      last = match.index + match[0].length
    }
    if (last < letter.text.length) parts.push({ type: 'text', content: letter.text.slice(last) })
    return parts
  })

  async function copyLetter() {
    try {
      await navigator.clipboard.writeText(letter.text)
      copied = true
      setTimeout(() => (copied = false), 2000)
    } catch {
      // fallback: silent fail — browser may block clipboard without user gesture
    }
  }

  function downloadLetter() {
    const blob = new Blob([letter.text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'dispute-letter.txt'
    a.click()
    URL.revokeObjectURL(url)
  }
</script>

<div class="letter-section">
  <div class="letter-header">
    <h3 style="margin: 0; font-size: 16px; font-weight: 600;">Dispute Letter</h3>
    <div class="letter-actions">
      <button class="btn btn-secondary" onclick={copyLetter}>
        {copied ? '✓ Copied!' : 'Copy letter'}
      </button>
      <button class="btn btn-secondary" onclick={downloadLetter}>Download .txt</button>
    </div>
  </div>

  <div class="letter-body card">
    <pre class="letter-text">{#each segments as seg}{#if seg.type === 'placeholder'}<mark class="placeholder">{seg.content}</mark>{:else}{seg.content}{/if}{/each}</pre>
  </div>

  <p class="letter-note">
    Fill in the <mark class="placeholder" style="padding: 0 4px;">highlighted sections</mark> before sending.
  </p>
</div>

<style>
  .letter-section {
    margin-top: 32px;
  }

  .letter-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    flex-wrap: wrap;
    gap: 8px;
  }

  .letter-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .letter-body {
    max-height: 480px;
    overflow-y: auto;
    padding: 24px;
    border-radius: var(--radius);
  }

  .letter-text {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
  }

  mark.placeholder {
    background: var(--placeholder);
    color: #92400E;
    border-radius: 3px;
    padding: 1px 3px;
    font-weight: 500;
    text-decoration: none;
  }

  .letter-note {
    font-size: 13px;
    color: var(--text-muted);
    margin: 8px 0 0;
    text-align: center;
  }
</style>
