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

type PdfFactory = {
  new (options: { unit: string; format: string }): jsPDF
  (options: { unit: string; format: string }): jsPDF
}

interface FindingGroup {
  key: AuditFinding['errorType']
  title: string
  tint: [number, number, number]
}

interface GroupedFinding {
  finding: AuditFinding
  item: LineItem | undefined
}

const FINDING_GROUPS: FindingGroup[] = [
  { key: 'unbundling', title: 'Unbundling Issues', tint: [243, 227, 227] },
  { key: 'duplicate', title: 'Duplicate Charges', tint: [255, 239, 213] },
  { key: 'pharmacy_markup', title: 'Pharmacy Markup', tint: [255, 244, 214] },
  { key: 'upcoding', title: 'Upcoding Flags', tint: [255, 243, 199] },
  { key: 'icd10_mismatch', title: 'Diagnosis Mismatches', tint: [229, 239, 255] },
  { key: 'above_hospital_list_price', title: 'Above Hospital List Price', tint: [235, 244, 239] },
]

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

function textOrDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

export function getPriceComparison(item: LineItem, finding: AuditFinding | null): PriceComparison | null {
  if (!finding || item.billedAmount <= 0) return null

  if (finding.errorType === 'upcoding') {
    if (finding.medicareRate == null) return null
    return {
      expected: finding.medicareRate,
      zeroLabel: null,
      savings: Math.max(0, item.billedAmount - finding.medicareRate),
    }
  }

  if (finding.errorType === 'unbundling') {
    return { expected: 0, zeroLabel: 'should not be billed separately', savings: item.billedAmount }
  }

  if (finding.errorType === 'duplicate') {
    return { expected: 0, zeroLabel: 'duplicate charge should be $0', savings: item.billedAmount }
  }

  if (finding.errorType === 'pharmacy_markup') {
    if (finding.medicareRate != null) {
      return {
        expected: finding.medicareRate,
        zeroLabel: null,
        savings: Math.max(0, item.billedAmount - finding.medicareRate),
      }
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

  if (finding.errorType === 'above_hospital_list_price' && finding.hospitalGrossCharge != null) {
    return {
      expected: finding.hospitalGrossCharge,
      zeroLabel: null,
      savings: Math.max(0, item.billedAmount - finding.hospitalGrossCharge),
    }
  }

  return null
}

function safeText(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function ensureSpace(doc: jsPDF, y: number, needed: number, margin: number): number {
  if (y + needed <= doc.internal.pageSize.getHeight() - margin) return y
  doc.addPage()
  return margin
}

function drawWrappedText(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  width: number,
  options?: { fontSize?: number; bold?: boolean; color?: [number, number, number] }
): number {
  doc.setFont('helvetica', options?.bold ? 'bold' : 'normal')
  doc.setFontSize(options?.fontSize ?? 10)
  doc.setTextColor(...(options?.color ?? [16, 33, 58]))
  const lines = doc.splitTextToSize(text, width) as string[]
  doc.text(lines, x, y)
  return y + lines.length * ((options?.fontSize ?? 10) + 1)
}

function drawLabelValue(
  doc: jsPDF,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number
): number {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(97, 109, 126)
  doc.text(label.toUpperCase(), x, y)

  return drawWrappedText(doc, value, x, y + 12, width, { fontSize: 10 })
}

function drawSummaryStrip(doc: jsPDF, result: AuditResult, x: number, y: number, width: number): number {
  const items = [
    ['Potential overcharge', formatDollars(result.summary.potentialOvercharge)],
    ['Likely errors', String(result.summary.errorCount)],
    ['Warnings', String(result.summary.warningCount)],
    ['Clean lines', String(result.summary.cleanCount)],
  ]

  const cardWidth = (width - 18) / items.length
  items.forEach(([label, value], index) => {
    const cardX = x + index * (cardWidth + 6)
    doc.setFillColor(248, 250, 252)
    doc.setDrawColor(223, 228, 235)
    doc.roundedRect(cardX, y, cardWidth, 48, 8, 8, 'FD')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(14)
    doc.setTextColor(16, 33, 58)
    doc.text(String(value), cardX + 10, y + 20)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(97, 109, 126)
    doc.text(String(label), cardX + 10, y + 34)
  })

  return y + 64
}

function groupFindings(findings: AuditFinding[], lineItems: LineItem[]): Array<{ group: FindingGroup; entries: GroupedFinding[] }> {
  return FINDING_GROUPS
    .map((group) => ({
      group,
      entries: findings
        .filter((finding) => finding.errorType === group.key)
        .sort((left, right) => {
          const related = (left.ncciBundledWith ?? '').localeCompare(right.ncciBundledWith ?? '')
          if (related !== 0) return related
          return left.cptCode.localeCompare(right.cptCode) || left.lineItemIndex - right.lineItemIndex
        })
        .map((finding) => ({ finding, item: lineItems[finding.lineItemIndex] })),
    }))
    .filter((entry) => entry.entries.length > 0)
}

function drawGroupHeader(doc: jsPDF, title: string, tint: [number, number, number], x: number, y: number, width: number): number {
  doc.setFillColor(...tint)
  doc.roundedRect(x, y, width, 26, 6, 6, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(16, 33, 58)
  doc.text(title, x + 10, y + 17)
  return y + 38
}

function drawFindingCard(doc: jsPDF, entry: GroupedFinding, x: number, y: number, width: number): number {
  const { finding, item } = entry
  const comparison = item ? getPriceComparison(item, finding) : null
  const description = safeText(finding.standardDescription || item?.description || finding.description)
  const codeLine = `${finding.cptCode}${finding.ncciBundledWith ? `  ->  related to ${finding.ncciBundledWith}` : ''}`
  const benchmark =
    comparison?.zeroLabel
      ? comparison.zeroLabel
      : comparison
        ? formatDollars(comparison.expected)
        : finding.medicareRate != null
          ? formatDollars(finding.medicareRate)
          : '-'
  const detailLines = [
    `Description: ${description}`,
    `Reason for dispute: ${safeText(finding.description)}`,
    `Recommendation: ${safeText(finding.recommendation)}`,
    `Billed amount: ${item ? formatDollars(item.billedAmount) : '-'}`,
    `Medicare benchmark rate: ${benchmark}`,
  ]
  if (comparison && comparison.savings > 0) {
    detailLines.push(`Estimated savings: ${formatDollars(comparison.savings)}`)
  }
  if (finding.hospitalPriceSource) {
    detailLines.push(`Hospital price source: ${finding.hospitalPriceSource}`)
  }

  const textHeight = detailLines.length * 13 + 24
  doc.setFillColor(255, 255, 255)
  doc.setDrawColor(218, 223, 231)
  doc.roundedRect(x, y, width, textHeight, 8, 8, 'FD')

  doc.setFillColor(finding.severity === 'error' ? 183 : 210, finding.severity === 'error' ? 28 : 140, finding.severity === 'error' ? 28 : 85)
  doc.roundedRect(x + 10, y + 10, 70, 16, 8, 8, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(255, 255, 255)
  doc.text(finding.severity.toUpperCase(), x + 20, y + 21)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(16, 33, 58)
  doc.text(codeLine, x + 92, y + 21)

  let cursor = y + 38
  detailLines.forEach((line) => {
    cursor = drawWrappedText(doc, line, x + 12, cursor, width - 24, { fontSize: 9 })
  })

  return y + textHeight + 10
}

export function downloadResultReport(input: ResultReportInput): void {
  const { result, lineItems } = input
  const generatedAt = input.generatedAt ?? new Date()
  const createPdf = jsPDF as unknown as PdfFactory
  let doc: jsPDF
  try {
    doc = new createPdf({ unit: 'pt', format: 'a4' })
  } catch {
    doc = createPdf({ unit: 'pt', format: 'a4' })
  }
  const margin = 40
  const pageWidth = doc.internal.pageSize.getWidth()
  const contentWidth = pageWidth - margin * 2
  const title = result.extractedMeta?.hospitalName
    ? `${result.extractedMeta.hospitalName} Audit Report`
    : 'Hospital Bill Audit Report'

  // Report plan:
  // 1. Branded title + metadata snapshot
  // 2. Summary strip for top-line totals
  // 3. Grouped findings by audit category with a clear section band
  // 4. Full finding cards with description, dispute reason, benchmark, and savings context
  // 5. No dispute-letter appendix in the PDF

  doc.setFillColor(245, 247, 250)
  doc.rect(0, 0, pageWidth, 110, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(16, 33, 58)
  doc.text(title, margin, 48)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(97, 109, 126)
  doc.text('Structured audit report for patient review and dispute follow-up.', margin, 66)

  let y = 88
  drawLabelValue(doc, 'Hospital', textOrDash(result.extractedMeta?.hospitalName), margin, y, contentWidth / 2 - 12)
  drawLabelValue(doc, 'Account', textOrDash(result.extractedMeta?.accountNumber), margin + contentWidth / 2 + 12, y, contentWidth / 2 - 12)
  y += 44
  drawLabelValue(doc, 'Service date', textOrDash(result.extractedMeta?.dateOfService), margin, y, contentWidth / 2 - 12)
  drawLabelValue(doc, 'Generated', formatDateTime(generatedAt), margin + contentWidth / 2 + 12, y, contentWidth / 2 - 12)
  y += 56

  y = drawSummaryStrip(doc, result, margin, y, contentWidth)

  const groupedFindings = groupFindings(result.findings, lineItems)

  if (groupedFindings.length === 0) {
    drawWrappedText(doc, 'No audit findings were generated for this bill.', margin, y, contentWidth, { fontSize: 12 })
  } else {
    groupedFindings.forEach(({ group, entries }) => {
      y = ensureSpace(doc, y, 48, margin)
      y = drawGroupHeader(doc, group.title, group.tint, margin, y, contentWidth)
      entries.forEach((entry) => {
        y = ensureSpace(doc, y, 150, margin)
        y = drawFindingCard(doc, entry, margin, y, contentWidth)
      })
    })
  }

  const blob = doc.output('blob')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = input.fileName ?? 'hospital-bill-audit-report.pdf'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
