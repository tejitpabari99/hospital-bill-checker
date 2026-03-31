/**
 * Standalone script: reads JSON { prompt } from stdin,
 * calls Gemini API, writes JSON { text } or { error } to stdout.
 * Runs as a child process so SDK fatal signals don't affect the main server.
 */
import { GoogleGenerativeAI } from '@google/generative-ai'

let inputData = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { inputData += chunk })
process.stdin.on('end', async () => {
  try {
    const { prompt } = JSON.parse(inputData.trim())
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    // pro first for audit quality; flash as 503 fallback only
    const models = ['gemini-2.5-pro', 'gemini-2.5-flash']
    let lastError = null

    for (const modelName of models) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { temperature: 0 },  // deterministic output
        })
        const result = await model.generateContent(prompt)
        const text = result.response.text()
        process.stdout.write(JSON.stringify({ text, model: modelName }))
        process.exit(0)
      } catch (err) {
        lastError = err
        const message = err?.message ?? String(err)
        const lower = message.toLowerCase()
        if (!lower.includes('503') && !lower.includes('high demand') && !lower.includes('service unavailable')) {
          throw err
        }
      }
    }

    throw lastError ?? new Error('Gemini returned no response')
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.message ?? String(err) }))
    process.exit(0)
  }
})
