/// <reference types="@testing-library/jest-dom" />

import { render } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import HowItWorksPage from './how-it-works/+page.svelte'
import PrivacyPage from './privacy/+page.svelte'
import ContactPage from './contact-us/+page.svelte'

describe('Static page copy', () => {
  it('describes deterministic checks versus AI checks on the how-it-works page', () => {
    const { getByText } = render(HowItWorksPage)

    expect(getByText(/rule-based lookup from cms data tables/i)).toBeInTheDocument()
    expect(getByText(/all billing error findings are deterministic/i)).toBeInTheDocument()
    expect(getByText(/drug overcharges use the cms asp dataset/i)).toBeInTheDocument()
    expect(getByText(/lab codes are checked against clfs when available/i)).toBeInTheDocument()
    expect(getByText(/medicaid practitioner services edition/i)).toBeInTheDocument()
  })

  it('explains which checks never send data to ai in the privacy policy', () => {
    const { getByText } = render(PrivacyPage)

    expect(getByText(/for checks that require clinical reasoning/i)).toBeInTheDocument()
    expect(getByText(/no data is sent to any ai model/i)).toBeInTheDocument()
    expect(getByText(/anonymous running total/i)).toBeInTheDocument()
  })

  it('asks for modifier -59 and X{EPSU} context on the contact page', () => {
    const { getByText } = render(ContactPage)

    expect(getByText(/whether a modifier -59 or x\{epsu\} was present/i)).toBeInTheDocument()
    expect(getByText(/lab-rate or hospital price comparison that looks wrong/i)).toBeInTheDocument()
  })
})
