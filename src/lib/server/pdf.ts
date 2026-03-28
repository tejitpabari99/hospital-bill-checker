import { PDFParse } from 'pdf-parse'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

// CPT/HCPCS code pattern: 5 digits, or J/G/A + 4 digits
// Negative lookbehind: exclude numbers preceded by $, -, or digit (part of account/dollar amounts)
// Negative lookahead: exclude numbers followed by . (decimal dollar amounts) or - (account number continuation)
const CPT_PATTERN = /(?<![0-9$\-])(?<!\d)\b([0-9]{5}|[JGABC][0-9]{4})\b(?![.\-0-9])/g

export interface ParsedLineItem {
  code: string
  description: string
  units: number
  amount: number
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
    accountNumber?: string | null
    dateOfService?: string | null
  }
}

export async function parsePDFBuffer(buffer: Buffer): Promise<ParsedBill> {
  // Step 1: Try pdf-parse for embedded text
  let rawText = ''
  let pageCount = 1

  try {
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    const result = await parser.getText()
    rawText = result.text ?? ''
    pageCount = result.pages?.length ?? 1
  } catch {
    // pdf-parse failed — will fall through to Vision
  }

  // Warn if >8 pages
  const parseWarning = pageCount > 8
    ? 'Bills over 8 pages may not fully process — try uploading just the itemized charges page.'
    : undefined

  // Check if we found CPT codes in the text
  // Preserve duplicates so the audit layer can detect duplicate billing
  const codesFromText = rawText.match(CPT_PATTERN) ?? []

  if (codesFromText.length > 0) {
    // Text-based PDF: return rawText so audit can extract amounts directly
    return { rawText, cptCodesFound: codesFromText, pageCount, usedVision: false, parseWarning }
  }

  // Step 2: No CPT codes found — route to Claude Vision
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

    return {
      rawText: parsed.rawText ?? text,
      cptCodesFound: parsed.cptCodes ?? [],
      pageCount,
      usedVision: true,
      parseWarning,
      lineItems: parsed.lineItems ?? [],
      extractedMeta: {
        hospitalName: parsed.hospitalName ?? null,
        accountNumber: parsed.accountNumber ?? null,
        dateOfService: parsed.dateOfService ?? null,
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
