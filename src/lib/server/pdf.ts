import * as pdfParseModule from 'pdf-parse'
const pdfParse = (pdfParseModule as any).default ?? pdfParseModule
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

// CPT/HCPCS code pattern: 5 digits, or J/G/A + 4 digits
const CPT_PATTERN = /\b([0-9]{5}|[JGABC][0-9]{4})\b/g

export interface ParsedBill {
  rawText: string
  cptCodesFound: string[]
  pageCount: number
  usedVision: boolean
  parseWarning?: string  // set if >8 pages, blurry, etc.
}

export async function parsePDFBuffer(buffer: Buffer): Promise<ParsedBill> {
  // Step 1: Try pdf-parse for embedded text
  let rawText = ''
  let pageCount = 1

  try {
    const result = await pdfParse(buffer)
    rawText = result.text
    pageCount = result.numpages
  } catch {
    // pdf-parse failed — will fall through to Vision
  }

  // Warn if >8 pages
  const parseWarning = pageCount > 8
    ? 'Bills over 8 pages may not fully process — try uploading just the itemized charges page.'
    : undefined

  // Check if we found CPT codes in the text
  const codesFromText = [...new Set(rawText.match(CPT_PATTERN) ?? [])]

  if (codesFromText.length > 0) {
    return { rawText, cptCodesFound: codesFromText, pageCount, usedVision: false, parseWarning }
  }

  // Step 2: No CPT codes found — route to Claude Vision
  // For multi-page PDFs, we'd convert pages to images client-side and pass them here.
  // For now, try Vision with the raw text as context.
  return await parseWithVision(buffer, pageCount, parseWarning)
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

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64,
            },
          } as any,
          {
            type: 'text',
            text: `Extract all billing information from this hospital bill. Return a JSON object with:
{
  "rawText": "all text content from the bill",
  "cptCodes": ["list", "of", "CPT", "HCPCS", "codes", "found"],
  "hospitalName": "hospital name or null",
  "accountNumber": "account number or null",
  "dateOfService": "date or null",
  "lineItems": [
    { "code": "99285", "description": "ER visit", "units": 1, "amount": 800.00 }
  ],
  "errorMessage": null
}

If this is an EOB (Explanation of Benefits) not a hospital bill, set errorMessage to "This is an insurance EOB, not a hospital bill. Please upload your itemized hospital bill instead."
If the image is too blurry to read, set errorMessage to "We couldn't read this clearly. Try a better-lit photo."
If no CPT/ICD codes found, set errorMessage to "This looks like a summary bill. Request the itemized statement from your hospital."`,
          },
        ],
      }],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
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

    return {
      rawText: parsed.rawText ?? text,
      cptCodesFound: parsed.cptCodes ?? [],
      pageCount,
      usedVision: true,
      parseWarning,
    }
  } catch {
    return {
      rawText: '',
      cptCodesFound: [],
      pageCount,
      usedVision: true,
      parseWarning: 'Audit failed — please try again. Your file was not saved.',
    }
  }
}
