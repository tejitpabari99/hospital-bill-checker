import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { parsePDFBuffer } from '$lib/server/pdf'

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB

export const POST: RequestHandler = async ({ request }) => {
  const contentType = request.headers.get('content-type') ?? ''

  if (!contentType.includes('multipart/form-data') && !contentType.includes('application/octet-stream')) {
    throw error(400, 'Expected multipart/form-data or application/octet-stream')
  }

  let buffer: Buffer

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      throw error(400, 'file field required')
    }
    if (file.size > MAX_FILE_SIZE) {
      throw error(413, 'File too large (max 20MB)')
    }
    buffer = Buffer.from(await file.arrayBuffer())
  } else {
    const bytes = await request.arrayBuffer()
    if (bytes.byteLength > MAX_FILE_SIZE) {
      throw error(413, 'File too large (max 20MB)')
    }
    buffer = Buffer.from(bytes)
  }

  try {
    const result = await parsePDFBuffer(buffer)
    return json(result)
  } catch (err) {
    console.error('PDF parse error:', err)
    throw error(500, 'Failed to parse PDF')
  }
}
