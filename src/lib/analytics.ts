// Client-side analytics helpers — never import from server files

type GTag = (...args: unknown[]) => void

function gtag(...args: unknown[]): void {
  if (typeof window === 'undefined') return
  const g = (window as any).gtag
  if (typeof g !== 'function') return
  g(...args)
}

export function trackAuditStarted(): void {
  gtag('event', 'audit_started')
}

export function trackAuditCompleted(potentialOvercharge: number, errorCount: number): void {
  gtag('event', 'audit_completed', {
    potential_overcharge: Math.round(potentialOvercharge),
    error_count: errorCount,
    value: Math.round(potentialOvercharge),
    currency: 'USD',
  })
}

export function trackBillParseError(reason: string): void {
  gtag('event', 'bill_parse_error', { error_reason: reason })
}

export function trackFileSelected(fileType: string, fileSizeMb: number): void {
  gtag('event', 'file_selected', { file_type: fileType, file_size_mb: fileSizeMb })
}

export function trackFileTooLarge(fileSizeMb: number): void {
  gtag('event', 'file_too_large', { file_size_mb: fileSizeMb })
}

export function trackNewBill(): void {
  gtag('event', 'new_bill_started')
}

export function trackLineItemExpanded(cptCode: string): void {
  gtag('event', 'line_item_expanded', { cpt_code: cptCode })
}

export function trackCptCodeLookup(cptCode: string): void {
  gtag('event', 'cpt_code_lookup', { cpt_code: cptCode })
}

export function trackDisputeLetterCopied(): void {
  gtag('event', 'dispute_letter_copied')
}

export function trackDisputeLetterDownloaded(): void {
  gtag('event', 'dispute_letter_downloaded')
}

export function trackDisputeLetterEmailed(service: string): void {
  gtag('event', 'dispute_letter_emailed', { service })
}

export function trackShareCopied(): void {
  gtag('event', 'share_copied')
}

export function trackShareOpened(platform: string): void {
  gtag('event', 'share_opened', { platform })
}

export function trackShareTwitter(): void {
  trackShareOpened('twitter')
}

export function trackShareLinkedIn(): void {
  trackShareOpened('linkedin')
}

export function trackShareFacebook(): void {
  trackShareOpened('facebook')
}

export function trackShareWhatsApp(): void {
  trackShareOpened('whatsapp')
}
