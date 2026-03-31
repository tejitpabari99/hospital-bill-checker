import '@testing-library/jest-dom/vitest'
import '@testing-library/svelte/vitest'

import { afterEach, vi } from 'vitest'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
