/**
 * Standalone script: reads JSON { base64 } from stdin,
 * calls Gemini Vision API on the PDF, writes JSON { text } or { error } to stdout.
 * Runs as a child process so SDK fatal signals don't affect the main server.
 */
import { GoogleGenerativeAI } from '@google/generative-ai'

let inputData = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { inputData += chunk })
process.stdin.on('end', async () => {
  try {
    const { base64 } = JSON.parse(inputData.trim())
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
    const result = await model.generateContent([
      { inlineData: { mimeType: 'application/pdf', data: base64 } },
      { text: `Extract billing information from this hospital bill. Return ONLY valid JSON (no prose before or after):
{
  "rawText": "brief summary of the bill — hospital name, dates, total charges only (max 200 chars)",
  "cptCodes": ["all", "standard", "CPT", "and", "HCPCS", "codes", "found"],
  "hospitalName": "hospital name or null",
  "accountNumber": "account number or null",
  "dateOfService": "date or null",
  "lineItems": [
    { "code": "99285", "description": "ER visit", "units": 1, "amount": 800.00 }
  ],
  "errorMessage": null
}

IMPORTANT: Keep lineItems to the top 20 most expensive charges only.
For UB-04 facility bills (with Revenue Codes), extract ONLY standard 5-digit CPT codes or HCPCS Level II codes (letter J/G/A/B/C + 4 digits) from the CPT/HCPCS column. Do NOT include 4-digit Revenue Codes (e.g. 0730, 0450) in the cptCodes array — Revenue Codes are not CPT codes. If only Revenue Codes are visible with no CPT column, extract any CPT/HCPCS codes you can identify from the description column.
If this is an EOB (Explanation of Benefits) not a hospital bill, set errorMessage to "This is an insurance EOB, not a hospital bill. Please upload your itemized hospital bill instead."
If the image is too blurry to read, set errorMessage to "We couldn't read this clearly. Try a better-lit photo."
If no CPT/ICD codes found at all, set errorMessage to "This looks like a summary bill. Request the itemized statement from your hospital."` },
    ])
    const text = result.response.text()
    process.stdout.write(JSON.stringify({ text }))
    process.exit(0)
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.message ?? String(err) }))
    process.exit(0)
  }
})
