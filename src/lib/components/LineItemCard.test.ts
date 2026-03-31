/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render } from '@testing-library/svelte'
import { describe, it, expect } from 'vitest'
import LineItemCard from './LineItemCard.svelte'
import type { AuditFinding, LineItem } from '$lib/types'

describe('LineItemCard', () => {
  it('renders the hospital price comparison when the finding includes hospital pricing', async () => {
    const item: LineItem = {
      cpt: '99285',
      description: 'Emergency department visit, high complexity',
      units: 1,
      billedAmount: 1200,
      icd10Codes: ['R07.9'],
    }

    const finding: AuditFinding & {
      hospitalGrossCharge: number
      hospitalCashPrice: number
      hospitalPriceSource: string
    } = {
      lineItemIndex: 0,
      cptCode: '99285',
      severity: 'warning',
      errorType: 'upcoding',
      confidence: 'high',
      description: 'This charge appears above the hospital published gross charge.',
      standardDescription: 'Emergency department visit, high medical decision making complexity',
      medicareRate: 450,
      markupRatio: 2.7,
      recommendation: 'Ask the billing office for a corrected claim.',
      hospitalGrossCharge: 450,
      hospitalCashPrice: 275,
      hospitalPriceSource: 'https://example.org/mrf.json',
    }

    const { container, getByRole, getByText } = render(LineItemCard, {
      props: { item, finding, index: 0 },
    })

    await fireEvent.click(getByRole('button'))

    const hospitalPriceRow = container.querySelector('.price-comparison.hospital-price')
    if (!hospitalPriceRow) throw new Error('Expected hospital price comparison row')
    expect(hospitalPriceRow).toHaveTextContent(/Hospital gross charge:\s*\$450\.00/)
    expect(getByText(/above hospital's own price list/i)).toBeInTheDocument()
    expect(getByRole('link', { name: /view file/i })).toHaveAttribute('href', 'https://example.org/mrf.json')
  })
})
