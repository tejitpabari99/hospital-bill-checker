/// <reference types="@testing-library/jest-dom" />

import { render } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import DisputeLetter from './DisputeLetter.svelte'
import type { DisputeLetter as DisputeLetterType } from '$lib/types'

function decodeMailBody(href: string): string {
  const url = new URL(href)
  return decodeURIComponent(url.searchParams.get('body') ?? '')
}

describe('DisputeLetter', () => {
  it('formats the email body as a per-code list with labeled subitems', () => {
    const letter: DisputeLetterType = {
      text: [
        '# Dispute Letter',
        '',
        '| CPT Code | Description | Reason for dispute | Medicare benchmark rate |',
        '| --- | --- | --- | --- |',
        '| 93010 | ECG interpretation | Should be bundled with 93000 | $6.45 |',
        '| 70450 | CT head without contrast | Compare with the 70460 bundle | $106.20 |',
      ].join('\n'),
      placeholders: [],
    }

    const { getByRole } = render(DisputeLetter, { props: { letter } })

    const gmailLink = getByRole('link', { name: /gmail/i })
    const body = decodeMailBody(gmailLink.getAttribute('href') ?? '')

    expect(body).toContain('CPT Code: 93010')
    expect(body).toContain('Description: ECG interpretation')
    expect(body).toContain('Reason for dispute: Should be bundled with 93000')
    expect(body).toContain('Medicare benchmark rate: $6.45')
    expect(body).toContain('CPT Code: 70450')
    expect(body).toContain('Reason for dispute: Compare with the 70460 bundle')
    expect((body.match(/CPT Code:/g) ?? []).length).toBe(2)
  })
})
