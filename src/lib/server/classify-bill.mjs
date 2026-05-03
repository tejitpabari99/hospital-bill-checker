/**
 * classify-bill.mjs
 * Child process: reads extracted bill JSON from stdin, calls Gemini to classify bill type.
 * Writes { billType } or { error } to stdout.
 *
 * billType: 'practitioner' | 'outpatient' | 'dme' | 'inpatient' | 'unknown'
 */
import { GoogleGenerativeAI } from '@google/generative-ai'

let inputData = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { inputData += chunk })
process.stdin.on('end', async () => {
  try {
    const { rawText, lineItems, hospitalName, admissionDate, dischargeDate, drgCode } = JSON.parse(inputData.trim())

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0 },
    })

    // Build a concise summary for classification
    const cptList = (lineItems ?? []).map(li => li.code ?? li.cpt).filter(Boolean).slice(0, 20).join(', ')
    const hasDrg = drgCode || (rawText ?? '').match(/\bDRG\b/i) || (rawText ?? '').match(/\bMS-DRG\b/i)
    const hasAdmission = admissionDate || dischargeDate
    const dmeKeywords = (rawText ?? '').match(/\b(DME|durable medical|equipment supplier|wheelchair|CPAP|oxygen|prosthetic)\b/i)
    const ub04Keywords = (rawText ?? '').match(/\b(UB-04|revenue code|facility|outpatient hospital|type of bill)\b/i)

    const prompt = `You are classifying a medical bill. Based on the information below, respond with ONLY a JSON object.

Bill information:
- Hospital/provider name: ${hospitalName ?? 'unknown'}
- CPT/HCPCS codes billed: ${cptList || 'none found'}
- Has DRG code: ${hasDrg ? 'YES' : 'no'}
- Has admission + discharge dates: ${hasAdmission ? 'YES' : 'no'}
- Raw bill text excerpt: "${(rawText ?? '').slice(0, 400)}"

Classify this bill into EXACTLY one of these types:
- "practitioner" — physician or professional services bill (office visit, procedure by doctor)
- "outpatient" — hospital outpatient facility bill (hospital departments, UB-04 form)
- "dme" — durable medical equipment supplier bill (equipment, supplies, CPAP, wheelchair)
- "inpatient" — hospital inpatient admission (has DRG, admission/discharge dates covering multi-day stay)
- "unknown" — cannot determine from available information

Respond with ONLY this JSON and nothing else:
{ "billType": "practitioner" }

Pick the single best type. If the bill could be practitioner or outpatient, prefer "outpatient" for hospital facility bills and "practitioner" for physician office bills.`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()

    // Extract JSON from response
    const jsonMatch = text.match(/\{[^}]+\}/)
    if (!jsonMatch) {
      process.stdout.write(JSON.stringify({ billType: 'unknown' }))
      process.exit(0)
    }

    const parsed = JSON.parse(jsonMatch[0])
    const billType = parsed.billType

    const VALID_TYPES = ['practitioner', 'outpatient', 'dme', 'inpatient', 'unknown']
    if (!VALID_TYPES.includes(billType)) {
      process.stdout.write(JSON.stringify({ billType: 'unknown' }))
      process.exit(0)
    }

    process.stdout.write(JSON.stringify({ billType }))
    process.exit(0)
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.message ?? String(err), billType: 'unknown' }))
    process.exit(0)
  }
})
