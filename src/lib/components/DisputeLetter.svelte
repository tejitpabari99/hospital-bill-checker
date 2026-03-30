<script lang="ts">
  import type { DisputeLetter } from '$lib/types'
  import { trackDisputeLetterCopied, trackDisputeLetterDownloaded, trackDisputeLetterEmailed } from '$lib/analytics'

  let { letter }: { letter: DisputeLetter } = $props()

  let copied = $state(false)

  // Parse letter text into segments: plain text or placeholder
  type Segment = { type: 'text'; content: string } | { type: 'placeholder'; content: string }

  function parseSegments(text: string): Segment[] {
    const parts: Segment[] = []
    const regex = /(\[[^\]]+\])/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) parts.push({ type: 'text', content: text.slice(last, match.index) })
      parts.push({ type: 'placeholder', content: match[1] })
      last = match.index + match[0].length
    }
    if (last < text.length) parts.push({ type: 'text', content: text.slice(last) })
    return parts
  }

  type Block =
    | { type: 'text'; content: string }
    | { type: 'table'; headers: string[]; rows: string[][] }

  function parseBlocks(text: string): Block[] {
    const lines = text.split('\n')
    const blocks: Block[] = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]
      // Detect table: line starts and ends with | (after trimming)
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const tableLines: string[] = []
        while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
          tableLines.push(lines[i])
          i++
        }
        // Parse table: first line = headers, second line = separator, rest = rows
        const parseRow = (l: string) => l.trim().slice(1, -1).split('|').map(c => c.trim())
        const headers = parseRow(tableLines[0])
        const dataRows = tableLines.slice(2).map(parseRow) // skip separator line
        blocks.push({ type: 'table', headers, rows: dataRows })
      } else {
        // Accumulate plain text lines
        const textLines: string[] = []
        while (i < lines.length && !(lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|'))) {
          textLines.push(lines[i])
          i++
        }
        blocks.push({ type: 'text', content: textLines.join('\n') })
      }
    }
    return blocks
  }

  const blocks = $derived(parseBlocks(letter.text))

  function toPlainText(raw: string): string {
    const lines = raw.split('\n')
    const out: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()

      // Convert markdown table rows to bullet list items
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        // Skip separator lines (e.g. | --- | --- |)
        if (/^\|[\s|:-]+\|$/.test(trimmed)) continue
        const cells = trimmed.slice(1, -1).split('|').map(c => c.trim()).filter(Boolean)
        if (cells.length === 1) {
          out.push(`• ${cells[0]}`)
        } else if (cells.length >= 2) {
          out.push(`• ${cells[0]}: ${cells.slice(1).join(', ')}`)
        }
        continue
      }

      // Strip heading markers (## Heading → Heading)
      let processed = line.replace(/^#{1,6}\s+/, '')

      // Strip bold (**text**)
      processed = processed.replace(/\*\*(.+?)\*\*/g, '$1')

      // Strip italic (_text_ or *text*)
      processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
      processed = processed.replace(/_(.+?)_/g, '$1')

      out.push(processed)
    }

    // Collapse 3+ consecutive blank lines into 2
    return out.join('\n').replace(/\n{3,}/g, '\n\n')
  }

  function buildMailtoUrl(service: 'default' | 'gmail' | 'outlook' | 'yahoo'): string {
    const subject = encodeURIComponent('Dispute of Hospital Bill Charges')
    const body = encodeURIComponent(toPlainText(letter.text))

    if (service === 'gmail') {
      return `https://mail.google.com/mail/?view=cm&fs=1&su=${subject}&body=${body}`
    }
    if (service === 'outlook') {
      return `https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}&body=${body}`
    }
    if (service === 'yahoo') {
      return `https://compose.mail.yahoo.com/?subject=${subject}&body=${body}`
    }
    // Default: native mailto (opens Apple Mail, Outlook desktop, Thunderbird, etc.)
    return `mailto:?subject=${subject}&body=${body}`
  }

  async function copyLetter() {
    try {
      await navigator.clipboard.writeText(toPlainText(letter.text))
      copied = true
      setTimeout(() => (copied = false), 2000)
      trackDisputeLetterCopied()
    } catch {
      // fallback: silent fail — browser may block clipboard without user gesture
    }
  }

  function downloadLetter() {
    const blob = new Blob([toPlainText(letter.text)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'hospital-bill-dispute-letter.txt'
    a.click()
    URL.revokeObjectURL(url)
    trackDisputeLetterDownloaded()
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
    {#each blocks as block}
      {#if block.type === 'table'}
        <div class="table-wrapper">
          <table class="letter-table">
            <thead>
              <tr>
                {#each block.headers as header}
                  <th>{header}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each block.rows as row}
                <tr>
                  {#each row as cell}
                    <td>{cell}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <pre class="letter-text">{#each parseSegments(block.content) as seg}{#if seg.type === 'placeholder'}<mark class="placeholder">{seg.content}</mark>{:else}{seg.content}{/if}{/each}</pre>
      {/if}
    {/each}
  </div>

  <p class="letter-note">
    Fill in the <mark class="placeholder" style="padding: 0 4px;">highlighted sections</mark> before sending.
  </p>

  <div class="email-section">
    <p class="email-label">Send directly from your email:</p>
    <div class="email-buttons">
      <a class="btn btn-secondary email-btn" href={buildMailtoUrl('default')} target="_blank" rel="noopener noreferrer" onclick={() => trackDisputeLetterEmailed('default')}>
        ✉ Mail app
      </a>
      <a class="btn btn-secondary email-btn" href={buildMailtoUrl('gmail')} target="_blank" rel="noopener noreferrer" onclick={() => trackDisputeLetterEmailed('gmail')}>
        Gmail
      </a>
      <a class="btn btn-secondary email-btn" href={buildMailtoUrl('outlook')} target="_blank" rel="noopener noreferrer" onclick={() => trackDisputeLetterEmailed('outlook')}>
        Outlook
      </a>
      <a class="btn btn-secondary email-btn" href={buildMailtoUrl('yahoo')} target="_blank" rel="noopener noreferrer" onclick={() => trackDisputeLetterEmailed('yahoo')}>
        Yahoo
      </a>
    </div>
    <p class="email-note">Opens your email client with the letter pre-filled. You'll need to add the hospital's billing email address.</p>
  </div>
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

  .table-wrapper {
    overflow-x: auto;
    margin: 8px 0;
  }

  .letter-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
    font-family: var(--font-mono);
  }

  .letter-table th {
    background: #F1F5F9;
    padding: 7px 12px;
    text-align: left;
    font-weight: 600;
    border: 1px solid var(--border);
    white-space: nowrap;
  }

  .letter-table td {
    padding: 6px 12px;
    border: 1px solid var(--border);
    vertical-align: top;
  }

  .letter-table tr:nth-child(even) td {
    background: #FAFAFA;
  }

  .email-section {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  .email-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    margin: 0 0 8px;
  }

  .email-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  .email-btn {
    font-size: 13px;
    padding: 7px 14px;
  }

  .email-note {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0;
  }
</style>
