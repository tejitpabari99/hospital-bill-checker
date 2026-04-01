import { spawn } from 'child_process'
import { join } from 'path'
import { GEMINI_API_KEY } from '$env/static/private'
import { createServerLogger, serializeError } from './logger.js'

// All Anthropic API calls and pdf-parse are run in child processes so that
// any fatal signal (SDK crash, pdfjs Worker crash) is isolated from the main server.
// Paths are anchored to CWD (Vite dev runs from project root).
const VISION_SCRIPT = join(process.cwd(), 'src/lib/server/vision-extract.mjs')

function callVision(base64: string, traceId?: string): Promise<{ text: string } | { error: string }> {
  const log = createServerLogger('parse', traceId)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VISION_SCRIPT], {
      timeout: 60_000,
      env: { ...process.env, GEMINI_API_KEY },
    })
    let output = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', () => {
      try {
        if (stderr.trim()) log.warn('vision-stderr', { stderr: stderr.slice(0, 4000) })
        resolve(JSON.parse(output))
      } catch {
        log.error('vision-invalid-output', {
          outputPreview: output.slice(0, 400),
          stderrPreview: stderr.slice(0, 400),
        })
        resolve({ error: 'Vision process returned invalid output' })
      }
    })
    child.on('error', (err) => {
      log.error('vision-child-error', { error: serializeError(err) })
      resolve({ error: err.message })
    })
    child.stdin.write(JSON.stringify({ base64, traceId }))
    child.stdin.end()
  })
}

export interface ParsedLineItem {
  code: string
  description: string
  units: number
  amount: number
}

function normalizeCptHcpcsCode(code: string): string | null {
  const trimmed = code.trim()
  const normalized = trimmed
    .replace(/^0+(\d{5})$/, '$1')
    .replace(/^0+([JGABC]\d{4})$/, '$1')

  return /^([0-9]{5}|[JGABC][0-9]{4})$/.test(normalized) ? normalized : null
}

function filterStandardLineItems(lineItems: ParsedLineItem[] | undefined): ParsedLineItem[] {
  if (!lineItems) return []
  return lineItems.flatMap((item) => {
    const code = normalizeCptHcpcsCode(item.code)
    if (!code) return []
    return [{ ...item, code }]
  })
}

export interface ParsedBill {
  rawText: string
  cptCodesFound: string[]
  pageCount: number
  usedVision: boolean
  parseWarning?: string  // set if >8 pages, blurry, etc.
  lineItems?: ParsedLineItem[]     // structured items from Vision (has amounts)
  extractedMeta?: {
    hospitalName?: string | null
    hospitalAddress?: string | null
    hospitalPhone?: string | null
    accountNumber?: string | null
    dateOfService?: string | null
    billTotal?: number | null
    admissionDate?: string | null
    dischargeDate?: string | null
  }
}

export async function parsePDFBuffer(buffer: Buffer, traceId?: string): Promise<ParsedBill> {
  const log = createServerLogger('parse', traceId)
  const base64 = buffer.toString('base64')
  log.info('parse-start', {
    bytes: buffer.length,
    base64Length: base64.length,
  })
  if (base64.length > 15_000_000) {
    log.error('parse-file-too-large', { base64Length: base64.length })
    return {
      rawText: '',
      cptCodesFound: [],
      pageCount: 1,
      usedVision: true,
      parseWarning: 'This file is too large to process. Try uploading just the itemized charges page.',
    }
  }
  return await parseWithVision(buffer, 1, undefined, traceId)
}

async function parseWithVision(buffer: Buffer, pageCount: number, parseWarning?: string, traceId?: string): Promise<ParsedBill> {
  const log = createServerLogger('parse', traceId)
  // Convert PDF buffer to base64 for Claude Vision
  // Note: Claude Vision accepts PDFs directly as documents (not just images)
  const base64 = buffer.toString('base64')

  // Stay under 15MB encoded
  if (base64.length > 15_000_000) {
    log.error('parse-file-too-large-vision', { base64Length: base64.length })
    return {
      rawText: '',
      cptCodesFound: [],
      pageCount,
      usedVision: true,
      parseWarning: 'This file is too large to process. Try uploading just the itemized charges page.',
    }
  }

  log.info('vision-call-start', { pageCount, base64Length: base64.length })
  const result = await callVision(base64, traceId)

  if ('error' in result) {
    log.error('vision-call-failed', { error: result.error })
    return {
      rawText: '',
      cptCodesFound: [],
      pageCount,
      usedVision: true,
      parseWarning: "We couldn't read this file. Try a clearer scan or a different page.",
    }
  }

  try {
    const text = result.text
    // Try code fence first, fall back to first {...} block, then raw text
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/)
    const parsed = JSON.parse(jsonMatch ? jsonMatch[1] : text)
    log.info('vision-json-parsed', {
      usedCodeFence: Boolean(text.match(/```(?:json)?\s*([\s\S]*?)```/)),
      hasErrorMessage: Boolean(parsed.errorMessage),
      rawCptCount: Array.isArray(parsed.cptCodes) ? parsed.cptCodes.length : 0,
      rawLineItemCount: Array.isArray(parsed.lineItems) ? parsed.lineItems.length : 0,
    })

    if (parsed.errorMessage) {
      log.error('vision-domain-error', { errorMessage: parsed.errorMessage })
      return {
        rawText: '',
        cptCodesFound: [],
        pageCount,
        usedVision: true,
        parseWarning: parsed.errorMessage,
      }
    }

    // Sanitize Vision-extracted CPT codes:
    // UB-04 bills often have Revenue Codes (4-digit, starts with 0) adjacent to CPT codes.
    // Claude sometimes reads them as a 6-digit string (e.g. "070486" instead of "70486").
    // Strip leading zeros to recover the real 5-char CPT/HCPCS code, then filter to valid format.
    const rawCodes: string[] = parsed.cptCodes ?? []
    const sanitizedCodes = rawCodes
      .map((c: string) => normalizeCptHcpcsCode(c))
      .filter((c: string | null): c is string => c !== null)
    const filteredLineItems = filterStandardLineItems(parsed.lineItems)
    log.info('vision-sanitized', {
      sanitizedCptCount: sanitizedCodes.length,
      filteredLineItemCount: filteredLineItems.length,
      sampleCodes: sanitizedCodes.slice(0, 10),
    })

    return {
      rawText: parsed.rawText ?? text,
      cptCodesFound: sanitizedCodes,
      pageCount,
      usedVision: true,
      parseWarning,
      lineItems: filteredLineItems,
      extractedMeta: {
        hospitalName: parsed.hospitalName ?? null,
        hospitalAddress: parsed.hospitalAddress ?? null,
        hospitalPhone: parsed.hospitalPhone ?? null,
        accountNumber: parsed.accountNumber ?? null,
        dateOfService: parsed.dateOfService ?? null,
        billTotal: typeof parsed.billTotal === 'number' ? parsed.billTotal : null,
        admissionDate: parsed.admissionDate ?? null,
        dischargeDate: parsed.dischargeDate ?? null,
      },
    }
  } catch (error) {
    log.error('vision-json-parse-failed', {
      message: error instanceof Error ? error.message : String(error),
      responsePreview: result.text.slice(0, 1200),
    })
    return {
      rawText: '',
      cptCodesFound: [],
      pageCount,
      usedVision: true,
      parseWarning: "We couldn't read this file. Try a clearer scan or a different page.",
    }
  }
}
