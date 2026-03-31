import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditFinding, AuditResult, LineItem } from '$lib/types'

type PdfOp = { method: string; args: unknown[] }

let currentDoc: MockPdf | null = null

class MockPdf {
  public readonly operations: PdfOp[] = []
  public readonly internal = {
    pageSize: {
      getWidth: () => 595.28,
      getHeight: () => 841.89,
    },
  }

  setTextColor = vi.fn((...args: unknown[]) => {
    this.operations.push({ method: 'setTextColor', args })
  })
  setFont = vi.fn((...args: unknown[]) => {
    this.operations.push({ method: 'setFont', args })
  })
  setFontSize = vi.fn((...args: unknown[]) => {
    this.operations.push({ method: 'setFontSize', args })
  })
  setFillColor = vi.fn((...args: unknown[]) => {
    this.operations.push({ method: 'setFillColor', args })
  })
  setDrawColor = vi.fn((...args: unknown[]) => {
    this.operations.push({ method: 'setDrawColor', args })
  })
  rect = vi.fn((...args: unknown[]) => {
    this.operations.push({ method: 'rect', args })
  })
  roundedRect = vi.fn((...args: unknown[]) => {
    this.operations.push({ method: 'roundedRect', args })
  })
  addPage = vi.fn(() => {
    this.operations.push({ method: 'addPage', args: [] })
  })
  splitTextToSize = vi.fn((text: string) => {
    this.operations.push({ method: 'splitTextToSize', args: [text] })
    return text.split('\n')
  })
  text = vi.fn((value: string | string[], ...args: unknown[]) => {
    const textValue = Array.isArray(value) ? value.join('\n') : value
    this.operations.push({ method: 'text', args: [textValue, ...args] })
  })
  output = vi.fn(() => new Blob(['report'], { type: 'application/pdf' }))
}

vi.mock('jspdf', () => ({
  jsPDF: vi.fn(function MockJsPdf() {
    if (!currentDoc) throw new Error('Mock PDF not initialized')
    return currentDoc
  }),
}))

function finding(
  overrides: Partial<AuditFinding> &
    Pick<AuditFinding, 'lineItemIndex' | 'cptCode' | 'severity' | 'errorType' | 'recommendation'>
): AuditFinding {
  return { ...overrides } as AuditFinding
}

function lineItem(cpt: string, billedAmount: number): LineItem {
  return { cpt, description: `${cpt} description`, units: 1, billedAmount }
}

describe('downloadResultReport', () => {
  beforeEach(() => {
    currentDoc = new MockPdf()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders a grouped audit report without appending the dispute letter', async () => {
    const { downloadResultReport } = await import('./result-report')

    const lineItems: LineItem[] = [
      lineItem('93000', 250),
      lineItem('93010', 45),
      lineItem('99285', 500),
      lineItem('J0696', 50),
      lineItem('99213', 150),
      lineItem('80053', 40),
      lineItem('85025', 35),
    ]

    const result: AuditResult = {
      findings: [
        finding({
          lineItemIndex: 1,
          cptCode: '93010',
          severity: 'error',
          errorType: 'unbundling',
          recommendation: 'Ask for the bundled ECG code.',
          standardDescription: 'Electrocardiogram, interpretation and report only',
          ncciBundledWith: '93000',
        }),
        finding({
          lineItemIndex: 2,
          cptCode: '99285',
          severity: 'error',
          errorType: 'duplicate',
          recommendation: 'Remove the duplicate charge.',
          standardDescription: 'Emergency department visit, high medical decision making complexity',
        }),
        finding({
          lineItemIndex: 3,
          cptCode: 'J0696',
          severity: 'warning',
          errorType: 'pharmacy_markup',
          recommendation: 'Review the drug charge against CMS pricing.',
          standardDescription: 'Injection, ceftriaxone sodium, per 250 mg',
          medicareRate: 1.45,
          markupRatio: 6.2,
        }),
        finding({
          lineItemIndex: 4,
          cptCode: '99213',
          severity: 'warning',
          errorType: 'upcoding',
          recommendation: 'Confirm whether the visit level matches the clinical note.',
          standardDescription: 'Office or other outpatient visit for the evaluation and management of an established patient',
          medicareRate: 94.88,
        }),
        finding({
          lineItemIndex: 5,
          cptCode: '80053',
          severity: 'warning',
          errorType: 'icd10_mismatch',
          recommendation: 'Confirm that the diagnosis supports the lab panel.',
          standardDescription: 'Comprehensive metabolic panel',
        }),
        finding({
          lineItemIndex: 6,
          cptCode: '85025',
          severity: 'warning',
          errorType: 'above_hospital_list_price',
          recommendation: "Compare the bill to the hospital's published charge.",
          standardDescription: 'Blood count; complete (CBC), automated',
          hospitalGrossCharge: 12,
          hospitalPriceSource: 'https://example.org/mrf.json',
        }),
      ],
      disputeLetter: {
        text: 'This should not be printed in the report.',
        placeholders: [],
      },
      summary: {
        totalBilled: 1020,
        potentialOvercharge: 220,
        errorCount: 2,
        warningCount: 4,
        cleanCount: 1,
        aboveHospitalListCount: 1,
        aboveHospitalListTotal: 23,
      },
      extractedMeta: {
        hospitalName: 'Test Hospital',
        accountNumber: 'A123',
        dateOfService: '2026-03-31',
      },
    }

    downloadResultReport({
      result,
      lineItems,
      generatedAt: new Date('2026-03-31T12:00:00Z'),
      fileName: 'report.pdf',
    })

    const textOutput = currentDoc?.operations
      .filter((op) => op.method === 'text')
      .map((op) => String(op.args[0]))
      .join('\n') ?? ''

    expect(textOutput).toContain('Test Hospital Audit Report')
    expect(textOutput).toContain('Unbundling Issues')
    expect(textOutput).toContain('Duplicate Charges')
    expect(textOutput).toContain('Pharmacy Markup')
    expect(textOutput).toContain('Upcoding Flags')
    expect(textOutput).toContain('Diagnosis Mismatches')
    expect(textOutput).toContain('Above Hospital List Price')
    expect(textOutput).not.toContain('Dispute Letter')
    expect(textOutput).toContain('93010')
    expect(textOutput).toContain('99285')
    expect(textOutput).toContain('J0696')
    expect(textOutput).toContain('99213')
    expect(textOutput).toContain('80053')
    expect(textOutput).toContain('85025')
  })
})
