import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { parsePDFBuffer } from '$lib/server/pdf'

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB

function isRecognizedFileType(buf: Buffer): boolean {
  // PDF: %PDF
  if (buf.length >= 4 &&
      buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return true
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 &&
      buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return true
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return true
  }
  // WebP: bytes 0-3 are "RIFF" AND bytes 8-11 are "WEBP"
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return true
  }
  return false
}

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

  if (!isRecognizedFileType(buffer)) {
    throw error(400, 'Unsupported file type. Please upload a PDF, JPG, PNG, or WebP.')
  }

  try {
    const result = await parsePDFBuffer(buffer)
    return json(result)
  } catch (err) {
    console.error('PDF parse error:', err)
    throw error(500, 'Failed to parse PDF')
  }
}
