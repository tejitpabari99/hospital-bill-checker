/**
 * claude-worker.mjs
 * Child process: receives audit context + deterministic findings via stdin,
 * calls Gemini to generate a dispute letter.
 * Writes { text } or { error } to stdout.
 */
import { GoogleGenerativeAI } from '@google/generative-ai'

let inputData = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { inputData += chunk })
process.stdin.on('end', async () => {
  try {
    const { prompt } = JSON.parse(inputData.trim())

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.3 },
    })

    const result = await model.generateContent(prompt)
    const text = result.response.text()
    process.stdout.write(JSON.stringify({ text }))
    process.exit(0)
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.message ?? String(err) }))
    process.exit(0)
  }
})
