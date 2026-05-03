import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { auditBill } from '$lib/server/claude'
import { AuditRefusalError, AuditParseError, AuditTimeoutError } from '$lib/types'
import type { BillInput, BillType, LineItem } from '$lib/types'
import { incrementStats } from '$lib/server/stats'
import { randomUUID } from 'crypto'
import { createServerLogger, serializeError } from '$lib/server/logger.js'

const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const MAX_LINE_ITEMS = 100
const MAX_RAW_TEXT_LENGTH = 200_000
const MAX_MONEY = 100_000_000
const MAX_UNITS = 10_000
const BILL_TYPES = new Set<BillType>(['practitioner', 'outpatient', 'dme', 'inpatient', 'unknown'])
const CPT_OR_HCPCS_RE = /^(?:\d{5}|[A-Z]\d{4})$/
const MODIFIER_RE = /^[A-Z0-9]{2}$/
const ICD10_RE = /^[A-TV-Z][0-9][A-Z0-9](?:\.?[A-Z0-9]{1,4})?$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const STATE_RE = /^[A-Z]{2}$/
const ZIP_RE = /^\d{5}(?:-\d{4})?$/
const PHONE_RE = /^[0-9+().\-\s]{7,32}$/
const NPI_RE = /^\d{10}$/
const DRG_RE = /^\d{3}$/

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeString(
  value: unknown,
  field: string,
  options: { max: number; required?: boolean; pattern?: RegExp; uppercase?: boolean } = { max: 255 },
): string | undefined {
  if (value == null) {
    if (options.required) throw error(400, `${field} required`)
    return undefined
  }
  if (typeof value !== 'string') throw error(400, `${field} must be a string`)

  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    if (options.required) throw error(400, `${field} required`)
    return undefined
  }

  const result = options.uppercase ? normalized.toUpperCase() : normalized
  if (result.length > options.max) throw error(400, `${field} too long`)
  if (options.pattern && !options.pattern.test(result)) throw error(400, `${field} invalid`)
  return result
}

function sanitizeMoney(value: unknown, field: string, required = false): number | undefined {
  if (value == null) {
    if (required) throw error(400, `${field} required`)
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_MONEY) {
    throw error(400, `${field} invalid`)
  }
  return value
}

function sanitizeCount(value: unknown, field: string): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_UNITS) {
    throw error(400, `${field} invalid`)
  }
  return value
}

function sanitizeStringList(
  value: unknown,
  field: string,
  options: { maxCount: number; maxLength: number; pattern: RegExp; uppercase?: boolean },
): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw error(400, `${field} must be an array`)
  if (value.length > options.maxCount) throw error(400, `${field} too many values`)

  return value.map((item, index) => {
    if (typeof item !== 'string') throw error(400, `${field}[${index}] must be a string`)
    const normalized = item.replace(/\s+/g, '').replace(/^-/, '')
    const result = options.uppercase ? normalized.toUpperCase() : normalized
    if (!result || result.length > options.maxLength || !options.pattern.test(result)) {
      throw error(400, `${field}[${index}] invalid`)
    }
    return result
  })
}

function sanitizeLineItem(value: unknown, index: number): LineItem {
  if (!isObject(value)) throw error(400, `lineItems[${index}] invalid`)

  return {
    cpt: sanitizeString(value.cpt, `lineItems[${index}].cpt`, {
      max: 5,
      required: true,
      pattern: CPT_OR_HCPCS_RE,
      uppercase: true,
    })!,
    description: sanitizeString(value.description, `lineItems[${index}].description`, {
      max: 500,
      required: true,
    })!,
    billedAmount: sanitizeMoney(value.billedAmount, `lineItems[${index}].billedAmount`, true)!,
    units: sanitizeCount(value.units, `lineItems[${index}].units`) ?? 1,
    serviceDate: sanitizeString(value.serviceDate, `lineItems[${index}].serviceDate`, {
      max: 10,
      pattern: ISO_DATE_RE,
    }),
    modifiers: sanitizeStringList(value.modifiers, `lineItems[${index}].modifiers`, {
      maxCount: 4,
      maxLength: 2,
      pattern: MODIFIER_RE,
      uppercase: true,
    }),
    icd10Codes: sanitizeStringList(value.icd10Codes, `lineItems[${index}].icd10Codes`, {
      maxCount: 12,
      maxLength: 8,
      pattern: ICD10_RE,
      uppercase: true,
    }),
    quantity: sanitizeCount(value.quantity, `lineItems[${index}].quantity`),
  }
}

export function validateAuditInput(body: unknown): BillInput {
  if (!isObject(body) || !Array.isArray(body.lineItems)) {
    throw error(400, 'lineItems array required')
  }
  if (body.lineItems.length === 0) throw error(400, 'lineItems cannot be empty')
  if (body.lineItems.length > MAX_LINE_ITEMS) throw error(400, `Too many line items (max ${MAX_LINE_ITEMS})`)

  const billType = sanitizeString(body.billType, 'billType', { max: 20 }) as BillType | undefined
  if (billType && !BILL_TYPES.has(billType)) throw error(400, 'billType invalid')

  return {
    lineItems: body.lineItems.map(sanitizeLineItem),
    rawText: sanitizeString(body.rawText, 'rawText', { max: MAX_RAW_TEXT_LENGTH }),
    hospitalName: sanitizeString(body.hospitalName, 'hospitalName', { max: 160 }),
    hospitalAddress: sanitizeString(body.hospitalAddress, 'hospitalAddress', { max: 300 }),
    hospitalPhone: sanitizeString(body.hospitalPhone, 'hospitalPhone', { max: 32, pattern: PHONE_RE }),
    hospitalNpi: sanitizeString(body.hospitalNpi, 'hospitalNpi', { max: 10, pattern: NPI_RE }),
    accountNumber: sanitizeString(body.accountNumber, 'accountNumber', { max: 80 }),
    dateOfService: sanitizeString(body.dateOfService ?? body.serviceDate, 'dateOfService', {
      max: 10,
      pattern: ISO_DATE_RE,
    }),
    billTotal: sanitizeMoney(body.billTotal, 'billTotal'),
    admissionDate: sanitizeString(body.admissionDate, 'admissionDate', { max: 10, pattern: ISO_DATE_RE }),
    dischargeDate: sanitizeString(body.dischargeDate, 'dischargeDate', { max: 10, pattern: ISO_DATE_RE }),
    goodFaithEstimate: sanitizeMoney(body.goodFaithEstimate, 'goodFaithEstimate'),
    patientName: sanitizeString(body.patientName, 'patientName', { max: 120 }),
    billType,
    patientState: sanitizeString(body.patientState, 'patientState', {
      max: 2,
      pattern: STATE_RE,
      uppercase: true,
    }),
    serviceZip: sanitizeString(body.serviceZip, 'serviceZip', { max: 10, pattern: ZIP_RE }),
    drgCode: sanitizeString(body.drgCode, 'drgCode', { max: 3, pattern: DRG_RE }),
  }
}

export const POST: RequestHandler = async ({ request }) => {
  const traceId = randomUUID().slice(0, 8)
  const log = createServerLogger('audit', traceId)
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : 'unknown'
  const start = Date.now()
  log.info('request-start', { ip })

  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (entry && now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT_MAX) {
      log.warn('rate-limited', { ip, count: entry.count })
      return json(
        { error: 'rate_limited', message: 'Too many requests. Please try again in a minute.' },
        { status: 429 }
      )
    }
    entry.count++
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    log.warn('invalid-json-body')
    throw error(400, 'Invalid JSON body')
  }

  const input = validateAuditInput(body)

  log.info('validated-input', {
    lineItems: input.lineItems.length,
    hospitalName: input.hospitalName ?? null,
    hasBillTotal: input.billTotal != null,
    hasAdmissionDate: Boolean(input.admissionDate),
    hasDischargeDate: Boolean(input.dischargeDate),
    hasGfe: input.goodFaithEstimate != null,
  })

  try {
    const result = await auditBill(input, traceId)
    log.info('request-finished', {
      ms: Date.now() - start,
      findings: result.findings.length,
      errors: result.summary.errorCount,
      warnings: result.summary.warningCount,
      aboveHospitalList: result.summary.aboveHospitalListCount ?? 0,
    })
    incrementStats({
      potentialOvercharge: result.summary.potentialOvercharge,
      errorCount: result.summary.errorCount,
      warningCount: result.summary.warningCount,
    }).catch((err) => log.error('stats-increment-failed', { error: serializeError(err) }))
    return json(result)
  } catch (err) {
    if (err instanceof AuditRefusalError) {
      log.warn('refusal', { message: err.message, ms: Date.now() - start })
      return json({ error: 'refusal', message: err.message }, { status: 422 })
    }
    if (err instanceof AuditParseError) {
      log.error('parse-error', { message: err.message, ms: Date.now() - start })
      return json({ error: 'parse_error', message: 'Our AI returned an unexpected response. Please try again.' }, { status: 502 })
    }
    if (err instanceof AuditTimeoutError) {
      log.error('timeout', { message: err.message, ms: Date.now() - start })
      return json({ error: 'timeout', message: err.message }, { status: 504 })
    }
    log.error('unhandled-error', { error: serializeError(err) })
    throw error(500, 'Internal server error')
  }
}
