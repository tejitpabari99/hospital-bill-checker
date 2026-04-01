import { spawn } from 'child_process'
import { join } from 'path'
import { GEMINI_API_KEY } from '$env/static/private'

// All Anthropic API calls and pdf-parse are run in child processes so that
// any fatal signal (SDK crash, pdfjs Worker crash) is isolated from the main server.
// Paths are anchored to CWD (Vite dev runs from project root).
const VISION_SCRIPT = join(process.cwd(), 'src/lib/server/vision-extract.mjs')

function callVision(base64: string): Promise<{ text: string } | { error: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VISION_SCRIPT], {
      timeout: 60_000,
      env: { ...process.env, GEMINI_API_KEY },
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('close', () => {
      try {
        resolve(JSON.parse(output))
      } catch {
        resolve({ error: 'Vision process returned invalid output' })
      }
    })
    child.on('error', (err) => resolve({ error: err.message }))
    child.stdin.write(JSON.stringify({ base64 }))
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

export async function parsePDFBuffer(buffer: Buffer): Promise<ParsedBill> {
  const base64 = buffer.toString('base64')
  if (base64.length > 15_000_000) {
    return {
      rawText: '',
      cptCodesFound: [],
      pageCount: 1,
      usedVision: true,
      parseWarning: 'This file is too large to process. Try uploading just the itemized charges page.',
    }
  }
  return await parseWithVision(buffer, 1, undefined)
}

async function parseWithVision(buffer: Buffer, pageCount: number, parseWarning?: string): Promise<ParsedBill> {
  // Convert PDF buffer to base64 for Claude Vision
  // Note: Claude Vision accepts PDFs directly as documents (not just images)
  const base64 = buffer.toString('base64')

  // Stay under 15MB encoded
  if (base64.length > 15_000_000) {
    return {
      rawText: '',
      cptCodesFound: [],
      pageCount,
      usedVision: true,
      parseWarning: 'This file is too large to process. Try uploading just the itemized charges page.',
    }
  }

  const result = await callVision(base64)

  if ('error' in result) {
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

    if (parsed.errorMessage) {
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

    return {
      rawText: parsed.rawText ?? text,
      cptCodesFound: sanitizedCodes,
      pageCount,
      usedVision: true,
      parseWarning,
      lineItems: filterStandardLineItems(parsed.lineItems),
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
  } catch {
    return {
      rawText: '',
      cptCodesFound: [],
      pageCount,
      usedVision: true,
      parseWarning: "We couldn't read this file. Try a clearer scan or a different page.",
    }
  }
}
