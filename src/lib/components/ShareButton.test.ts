/// <reference types="@testing-library/jest-dom" />

import { render } from '@testing-library/svelte'
import { describe, expect, it } from 'vitest'
import ShareButton from './ShareButton.svelte'

describe('ShareButton', () => {
  it('offers more than a single social share destination', () => {
    const { container, getByText } = render(ShareButton, {
      props: { potentialOvercharge: 1250000 },
    })

    expect(getByText(/\$1\.3M in potential billing errors/i)).toBeInTheDocument()

    const links = Array.from(container.querySelectorAll('a.share-action[href]')).map((element) =>
      (element as HTMLAnchorElement).href
    )

    expect(links.length).toBeGreaterThanOrEqual(3)
    expect(links.some((href) => !href.includes('twitter.com'))).toBe(true)
  })
})
