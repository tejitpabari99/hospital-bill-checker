/// <reference types="@testing-library/jest-dom" />

import { render } from '@testing-library/svelte'
import { describe, it, expect } from 'vitest'
import ResultsSummary from './ResultsSummary.svelte'
import type { AuditResult } from '$lib/types'

describe('ResultsSummary', () => {
  it('renders the hospital-price stat and attribution when hospital data is present', () => {
    const summary: AuditResult['summary'] & {
      aboveHospitalListCount: number
      aboveHospitalListTotal: number
      hospitalName: string
      hospitalMrfUrl: string
    } = {
      totalBilled: 1800,
      potentialOvercharge: 750,
      errorCount: 1,
      warningCount: 2,
      cleanCount: 3,
      aboveHospitalListCount: 2,
      aboveHospitalListTotal: 600,
      hospitalName: 'Memorial Hermann Hospital',
      hospitalMrfUrl: 'https://example.org/mrf.json',
    }

    const { container, getByRole, getByText } = render(ResultsSummary, { props: { summary } })

    expect(container.querySelector('.summary-strip.five-col')).toBeTruthy()
    expect(container.querySelectorAll('.stat')).toHaveLength(5)
    expect(getByText(/above hospital's own price list/i)).toBeInTheDocument()
    const hospitalStatValue = container.querySelector('.stat.hospital-above .stat-value')
    if (!hospitalStatValue) throw new Error('Expected hospital stat value')
    expect(hospitalStatValue).toHaveTextContent('2')
    expect(getByRole('link', { name: /required cms price transparency file/i })).toHaveAttribute(
      'href',
      'https://example.org/mrf.json'
    )
  })
})
