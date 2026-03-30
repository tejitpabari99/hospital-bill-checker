import { jsPDF } from 'jspdf'
import type { AuditFinding, AuditResult, LineItem } from '$lib/types'

export interface ResultReportInput {
  result: AuditResult
  lineItems: LineItem[]
  generatedAt?: Date
  fileName?: string
}

export interface PriceComparison {
  expected: number
  zeroLabel: string | null
  savings: number
}

function formatDollars(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDateTime(date: Date): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function confidenceLabel(confidence: AuditFinding['confidence'] | undefined): string {
  return confidence ? confidence.toUpperCase() : 'N/A'
}

function textOrDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

export function getPriceComparison(item: LineItem, finding: AuditFinding | null): PriceComparison | null {
  if (!finding || item.billedAmount <= 0) return null

  if (finding.errorType === 'upcoding') {
    if (finding.medicareRate == null) return null
    return { expected: finding.medicareRate, zeroLabel: null, savings: Math.max(0, item.billedAmount - finding.medicareRate) }
  }

  if (finding.errorType === 'unbundling') {
    return { expected: 0, zeroLabel: 'should not be billed separately', savings: item.billedAmount }
  }

  if (finding.errorType === 'duplicate') {
    return { expected: 0, zeroLabel: 'duplicate charge should be $0', savings: item.billedAmount }
  }

  if (finding.errorType === 'pharmacy_markup') {
    if (finding.medicareRate != null) {
      return { expected: finding.medicareRate, zeroLabel: null, savings: Math.max(0, item.billedAmount - finding.medicareRate) }
    }
    if (finding.markupRatio != null && finding.markupRatio > 0) {
      const expected = item.billedAmount / finding.markupRatio
      return { expected, zeroLabel: null, savings: Math.max(0, item.billedAmount - expected) }
    }
    return null
  }

  if (finding.errorType === 'icd10_mismatch') {
    return { expected: 0, zeroLabel: 'charge not justified by diagnosis', savings: item.billedAmount }
  }

  return null
}

function safeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function addWrappedText(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  width: number,
  options?: { fontSize?: number; color?: string | number[]; lineHeight?: number; bold?: boolean }
): number {
  if (options?.fontSize) doc.setFontSize(options.fontSize)
  if (options?.color) doc.setTextColor(options.color as any)
  if (options?.bold) doc.setFont('helvetica', 'bold')
  else doc.setFont('helvetica', 'normal')

  const lines = doc.splitTextToSize(text, width) as string[]
  const lineHeight = options?.lineHeight ?? 5
  doc.text(lines, x, y)
  return y + lines.length * lineHeight
}

function ensureSpace(doc: jsPDF, y: number, needed: number, margin: number): number {
  if (y + needed <= doc.internal.pageSize.getHeight() - margin) return y
  doc.addPage()
  return margin
}

function drawSectionTitle(doc: jsPDF, title: string, y: number, margin: number): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(16, 33, 58)
  doc.text(title, margin, y)
  return y + 6
}

function drawKeyValue(doc: jsPDF, label: string, value: string, x: number, y: number, width: number): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(95, 107, 122)
  doc.text(label, x, y)

  doc.setFont('helvetica', 'normal')
  doc.setTextColor(16, 33, 58)
  const lines = doc.splitTextToSize(value, width) as string[]
  doc.text(lines, x, y + 4)
  return y + 4 + lines.length * 4.5
}

function drawSummaryCard(doc: jsPDF, result: AuditResult, x: number, y: number, w: number, h: number): void {
  doc.setFillColor(248, 250, 252)
  doc.setDrawColor(221, 227, 238)
  doc.roundedRect(x, y, w, h, 3, 3, 'FD')

  const col = w / 4
  const items = [
    ['Likely errors', String(result.summary.errorCount)],
    ['Worth reviewing', String(result.summary.warningCount)],
    ['Potential overcharge', formatDollars(result.summary.potentialOvercharge)],
    ['Clean codes', String(result.summary.cleanCount)],
  ]

  items.forEach(([label, value], i) => {
    const cx = x + i * col + 4
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(15)
    doc.setTextColor(16, 33, 58)
    doc.text(String(value), cx, y + 12)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(95, 107, 122)
    doc.text(String(label), cx, y + 18)
  })
}

function drawFindings(doc: jsPDF, result: AuditResult, lineItems: LineItem[], x: number, y: number, width: number, margin: number): number {
  if (result.findings.length === 0) {
    return addWrappedText(doc, 'No billing issues were flagged in this audit.', x, y, width, { fontSize: 10 })
  }

  let cursor = y
  const maxFindings = Math.min(result.findings.length, 5)
  for (let i = 0; i < maxFindings; i++) {
    const finding = result.findings[i]
    const item = lineItems[finding.lineItemIndex]
    const comparison = item ? getPriceComparison(item, finding) : null
    const blockHeight = comparison ? 34 : 28
    cursor = ensureSpace(doc, cursor, blockHeight, margin)

    doc.setFillColor(250, 251, 253)
    doc.setDrawColor(221, 227, 238)
    doc.roundedRect(x, cursor, width, blockHeight, 2, 2, 'FD')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(16, 33, 58)
    doc.text(`${finding.cptCode} - ${finding.errorType.replace(/_/g, ' ')}`, x + 4, cursor + 6)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(95, 107, 122)
    const meta = [
      finding.severity.toUpperCase(),
      confidenceLabel(finding.confidence),
      item ? formatDollars(item.billedAmount) : '-',
    ].filter(Boolean).join(' | ')
    doc.text(meta, x + 4, cursor + 11)

    doc.setTextColor(16, 33, 58)
    const desc = doc.splitTextToSize(safeText(finding.description), width - 8) as string[]
    doc.text(desc, x + 4, cursor + 16)

    if (comparison) {
      doc.setFontSize(8)
      doc.setTextColor(87, 150, 90)
      doc.text(`Expected ${formatDollars(comparison.expected)}  Save ~${formatDollars(comparison.savings)}`, x + 4, cursor + blockHeight - 4)
    }

    cursor += blockHeight + 4
  }

  if (result.findings.length > maxFindings) {
    cursor = addWrappedText(
      doc,
      `Showing ${maxFindings} of ${result.findings.length} findings to keep the report concise.`,
      x,
      cursor + 2,
      width,
      { fontSize: 9, color: [95, 107, 122] }
    )
  }
  return cursor
}

function drawDisputeLetter(doc: jsPDF, letterText: string, x: number, y: number, width: number, margin: number): number {
  let cursor = y
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(16, 33, 58)
  const paragraphs = letterText.split('\n').map((line) => line.trimEnd())

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      cursor += 3
      continue
    }
    const lines = doc.splitTextToSize(paragraph, width) as string[]
    cursor = ensureSpace(doc, cursor, lines.length * 4.5 + 2, margin)
    doc.text(lines, x, cursor)
    cursor += lines.length * 4.5 + 2
  }

  return cursor
}

export function downloadResultReport(input: ResultReportInput): void {
  const result = input.result
  const lineItems = input.lineItems
  const generatedAt = input.generatedAt ?? new Date()
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const margin = 40
  const pageWidth = doc.internal.pageSize.getWidth()
  const contentWidth = pageWidth - margin * 2
  const title = result.extractedMeta?.hospitalName
    ? `${result.extractedMeta.hospitalName} Audit Report`
    : 'Hospital Bill Audit Report'

  doc.setTextColor(16, 33, 58)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.text(title, margin, 44)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(95, 107, 122)
  doc.text('Concise audit summary for patient review and dispute follow-up.', margin, 58)

  let y = 76
  y = drawKeyValue(doc, 'Hospital', textOrDash(result.extractedMeta?.hospitalName), margin, y, contentWidth / 2 - 12)
  y = drawKeyValue(doc, 'Account', textOrDash(result.extractedMeta?.accountNumber), margin, y + 2, contentWidth / 2 - 12)

  let yRight = 76
  yRight = drawKeyValue(doc, 'Service date', textOrDash(result.extractedMeta?.dateOfService), margin + contentWidth / 2 + 12, yRight, contentWidth / 2 - 12)
  yRight = drawKeyValue(doc, 'Generated', formatDateTime(generatedAt), margin + contentWidth / 2 + 12, yRight + 2, contentWidth / 2 - 12)

  y = Math.max(y, yRight) + 10
  drawSummaryCard(doc, result, margin, y, contentWidth, 34)
  y += 48

  y = drawSectionTitle(doc, 'Key Findings', y, margin)
  y = drawFindings(doc, result, lineItems, margin, y, contentWidth, margin)
  y += 8

  y = ensureSpace(doc, y, 18, margin)
  y = drawSectionTitle(doc, 'Dispute Letter', y, margin)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  y = drawDisputeLetter(doc, result.disputeLetter.text, margin, y, contentWidth, margin)

  const blob = doc.output('blob')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = input.fileName ?? 'hospital-bill-audit-report.pdf'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
