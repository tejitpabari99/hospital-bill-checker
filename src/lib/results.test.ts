import { describe, expect, it } from 'vitest'
import type { AuditFinding, LineItem } from '$lib/types'
import { buildResultSections, buildSummaryFindings, getDisplayDescription } from './results'

function lineItem(cpt: string, description: string, billedAmount = 100): LineItem {
  return { cpt, description, units: 1, billedAmount }
}

function finding(overrides: Partial<AuditFinding> & Pick<AuditFinding, 'lineItemIndex' | 'cptCode' | 'severity' | 'errorType' | 'recommendation'>): AuditFinding {
  return { ...overrides } as AuditFinding
}

describe('result display helpers', () => {
  it('prefers the standard description over the bill description', () => {
    const item = lineItem('93010', 'Redacted bill description')
    const auditFinding = finding({
      lineItemIndex: 0,
      cptCode: '93010',
      severity: 'error',
      errorType: 'unbundling',
      recommendation: 'Ask for the bundled ECG code.',
      standardDescription: 'Electrocardiogram, interpretation and report only',
    })

    expect(getDisplayDescription(item, auditFinding)).toBe('Electrocardiogram, interpretation and report only')
  })

  it('falls back to the bill description when no standard description exists', () => {
    const item = lineItem('99285', 'Emergency department visit, high complexity')

    expect(getDisplayDescription(item, null)).toBe('Emergency department visit, high complexity')
  })
})

describe('buildResultSections', () => {
  it('sorts sections and groups related codes together', () => {
    const lineItems = [
      lineItem('93000', 'ECG complete'),
      lineItem('93010', 'Redacted ECG interpretation'),
      lineItem('99285', 'ER visit'),
      lineItem('J0696', 'Ceftriaxone'),
      lineItem('80053', 'CMP'),
      lineItem('99285', 'ER visit duplicate'),
      lineItem('85025', 'CBC'),
    ]

    const findings: AuditFinding[] = [
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
        lineItemIndex: 5,
        cptCode: '99285',
        severity: 'error',
        errorType: 'duplicate',
        recommendation: 'Remove the extra duplicate charge.',
        standardDescription: 'Emergency department visit, high medical decision making complexity',
      }),
      finding({
        lineItemIndex: 3,
        cptCode: 'J0696',
        severity: 'error',
        errorType: 'pharmacy_markup',
        recommendation: 'Review the drug charge against CMS pricing.',
        standardDescription: 'Injection, ceftriaxone sodium, per 250 mg',
      }),
      finding({
        lineItemIndex: 2,
        cptCode: '99285',
        severity: 'warning',
        errorType: 'upcoding',
        recommendation: 'Confirm whether the visit level matches the clinical note.',
        standardDescription: 'Emergency department visit, high medical decision making complexity',
      }),
      finding({
        lineItemIndex: 4,
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
        recommendation: "Compare the bill to the hospital's own published charge.",
        standardDescription: 'Blood count; complete (CBC), automated',
        hospitalGrossCharge: 12,
        hospitalPriceSource: 'https://example.org/mrf.json',
      }),
    ]

    const sections = buildResultSections(lineItems, findings)

    expect(sections.map((section) => section.key)).toEqual([
      'unbundling',
      'duplicate',
      'pharmacy_markup',
      'upcoding',
      'icd10_mismatch',
      'above_hospital_list_price',
    ])

    const unbundling = sections[0]
    expect(unbundling.title).toBe('Unbundling Issues')
    expect(unbundling.groups).toHaveLength(1)
    expect(unbundling.groups[0].title).toBe('Should be bundled with 93000')
    expect(unbundling.groups[0].entries.map((entry) => entry.item.cpt)).toEqual(['93000', '93010'])
  })

  it('separates bill-level findings from line-item sections', () => {
    const lineItems = [lineItem('99285', 'ER visit')]
    const findings: AuditFinding[] = [
      finding({
        lineItemIndex: -1,
        cptCode: 'TOTAL',
        severity: 'error',
        errorType: 'arithmetic_error',
        recommendation: 'Request a corrected bill total.',
        standardDescription: 'Bill arithmetic error',
      }),
    ]

    const sections = buildResultSections(lineItems, findings)
    const summaryFindings = buildSummaryFindings(findings)

    expect(sections).toHaveLength(1)
    expect(sections[0].key).toBe('clean')
    expect(summaryFindings).toHaveLength(1)
    expect(summaryFindings[0].cptCode).toBe('TOTAL')
  })
})
