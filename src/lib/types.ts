export type BillType = 'practitioner' | 'outpatient' | 'dme' | 'inpatient' | 'unknown'

export interface LineItem {
  cpt: string        // CPT or HCPCS code
  description: string
  units: number
  billedAmount: number
  serviceDate?: string
  modifiers?: string[]  // e.g. ["-25", "LT"]
  icd10Codes?: string[] // diagnosis codes on the bill
  quantity?: number
}

export interface BillInput {
  lineItems: LineItem[]
  rawText?: string      // raw bill text; used when lineItems have $0 amounts (text PDF path)
  hospitalName?: string
  hospitalAddress?: string
  hospitalPhone?: string
  hospitalNpi?: string
  accountNumber?: string
  dateOfService?: string
  billTotal?: number
  admissionDate?: string
  dischargeDate?: string
  goodFaithEstimate?: number
  patientName?: string  // NOT sent to Claude — for letter placeholders only
  billType?: BillType
  patientState?: string
  serviceZip?: string
  drgCode?: string
}

export type ConfidenceLevel = 'high' | 'medium' | 'low'

export interface AuditFinding {
  lineItemIndex: number
  cptCode: string
  severity: 'error' | 'warning' | 'info'
  errorType:
    | 'upcoding'
    | 'unbundling'
    | 'mue_units'
    | 'pharmacy_markup'
    | 'opps_benchmark'
    | 'ipps_drg'
    | 'dmepos_benchmark'
    | 'dmepos_skipped'
    | 'ambulance_benchmark'
    | 'ambulance_skipped'
    | 'icd10_mismatch'
    | 'duplicate'
    | 'above_hospital_list_price'
    | 'arithmetic_error'
    | 'date_error'
    | 'no_surprises_act'
    | 'other'
  confidence?: ConfidenceLevel
  description: string        // plain English for patient
  standardDescription?: string  // official CPT/HCPCS code name from standard references
  medicareRate?: number      // from MPFS
  markupRatio?: number       // billedAmount / medicareRate
  ncciBundledWith?: string   // the Column 1 CPT it's bundled into
  recommendation: string     // what patient should do
  hospitalGrossCharge?: number
  hospitalCashPrice?: number
  hospitalPriceSource?: string
}

export interface DisputeLetter {
  text: string               // full letter text
  placeholders: string[]     // list of amber placeholder labels found in text
}

export interface AuditResult {
  findings: AuditFinding[]
  disputeLetter: DisputeLetter
  summary: {
    totalBilled: number
    potentialOvercharge: number
    errorCount: number
    warningCount: number
    cleanCount: number
    aboveHospitalListCount?: number
    aboveHospitalListTotal?: number
    hospitalName?: string
    hospitalMrfUrl?: string
  }
  extractedMeta: {
    hospitalName?: string
    hospitalAddress?: string
    hospitalPhone?: string
    accountNumber?: string
    dateOfService?: string
    billTotal?: number
    admissionDate?: string
    dischargeDate?: string
    billType?: BillType
  }
}

export class AuditRefusalError extends Error {
  constructor(message = 'Claude refused to process this bill') {
    super(message)
    this.name = 'AuditRefusalError'
  }
}

export class AuditParseError extends Error {
  constructor(message = 'Failed to parse Claude response as JSON') {
    super(message)
    this.name = 'AuditParseError'
  }
}

export class AuditTimeoutError extends Error {
  constructor(message = 'Audit timed out — please try again') {
    super(message)
    this.name = 'AuditTimeoutError'
  }
}
