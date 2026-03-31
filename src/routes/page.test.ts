/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render } from '@testing-library/svelte'
import { describe, it, expect, vi } from 'vitest'
import Page from './+page.svelte'

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Homepage flow', () => {
  it('keeps the upload screen structured and gates analysis until a file is selected', async () => {
    const { getByRole, getByLabelText, getByText, queryByText } = render(Page)

    const analyze = getByRole('button', { name: /analyze bill/i })
    expect(analyze).toBeDisabled()
    expect(getByText(/hospital bill checker/i)).toBeInTheDocument()
    expect(getByText(/no login/i)).toBeInTheDocument()
    expect(getByText(/no data stored/i)).toBeInTheDocument()
    expect(queryByText(/audit results/i)).toBeNull()

    const fileInput = getByLabelText(/upload bill file/i) as HTMLInputElement
    const file = new File(['fake pdf bytes'], 'bill.pdf', { type: 'application/pdf' })
    await fireEvent.change(fileInput, { target: { files: [file] } })

    expect(analyze).toBeEnabled()
  })

  it('progresses from upload to results and surfaces hospital pricing context', async () => {
    vi.useFakeTimers()

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/parse')) {
        return jsonResponse({
          lineItems: [
            {
              code: '99285',
              description: 'Emergency department visit, high complexity',
              amount: 1200,
              units: 1,
              icd10Codes: ['R07.9'],
            },
          ],
          cptCodesFound: ['99285'],
          extractedMeta: {
            hospitalName: 'Memorial Hermann Hospital',
            dateOfService: '2026-03-28',
            accountNumber: '12345',
          },
        })
      }

      if (url.endsWith('/api/audit')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { lineItems: Array<{ cpt: string }> }
        expect(body.lineItems).toHaveLength(1)

        return jsonResponse({
          findings: [
            {
              lineItemIndex: 0,
              cptCode: '99285',
              severity: 'warning',
              errorType: 'upcoding',
              confidence: 'high',
              description: 'This code was billed above the hospital published charge.',
              standardDescription: 'Emergency department visit, high medical decision making complexity',
              medicareRate: 450,
              markupRatio: 2.67,
              recommendation: 'Request a corrected bill and written justification.',
              hospitalGrossCharge: 450,
              hospitalCashPrice: 275,
              hospitalPriceSource: 'https://example.org/mrf.json',
            },
          ],
          disputeLetter: {
            text: 'Letter text',
            placeholders: ['[Your Full Name]'],
          },
          summary: {
            totalBilled: 1200,
            potentialOvercharge: 750,
            errorCount: 0,
            warningCount: 1,
            cleanCount: 0,
            aboveHospitalListCount: 1,
            aboveHospitalListTotal: 750,
            hospitalName: 'Memorial Hermann Hospital',
            hospitalMrfUrl: 'https://example.org/mrf.json',
          },
          extractedMeta: {
            hospitalName: 'Memorial Hermann Hospital',
            accountNumber: '12345',
            dateOfService: '2026-03-28',
          },
        })
      }

      throw new Error(`Unexpected fetch url: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { getByRole, getByLabelText, getByText, container } = render(Page)
    const fileInput = getByLabelText(/upload bill file/i) as HTMLInputElement
    const file = new File(['fake pdf bytes'], 'bill.pdf', { type: 'application/pdf' })
    await fireEvent.change(fileInput, { target: { files: [file] } })
    await fireEvent.click(getByRole('button', { name: /analyze bill/i }))

    expect(getByText(/reviewing your bill/i)).toBeInTheDocument()
    expect(getByText(/looking up hospital published prices/i)).toBeInTheDocument()

    await vi.runAllTimersAsync()

    expect(getByText(/audit results/i)).toBeInTheDocument()
    expect(getByText(/above hospital's own price list/i)).toBeInTheDocument()

    const lineItem = container.querySelector('.line-item') as HTMLElement
    await fireEvent.click(lineItem)

    const hospitalPriceRow = container.querySelector('.price-comparison.hospital-price')
    if (!hospitalPriceRow) throw new Error('Expected hospital price comparison row')
    expect(hospitalPriceRow).toHaveTextContent(/Hospital gross charge:\s*\$450\.00/)
    expect(getByText(/source: hospital's required cms price transparency file/i)).toBeInTheDocument()
  })
})
