export interface LineItem {
  cpt: string        // CPT or HCPCS code
  description: string
  units: number
  billedAmount: number
  serviceDate?: string
  modifiers?: string[]  // e.g. ["-25", "LT"]
  icd10Codes?: string[] // diagnosis codes on the bill
}

export interface BillInput {
  lineItems: LineItem[]
  hospitalName?: string
  hospitalNpi?: string
  accountNumber?: string
  dateOfService?: string
  patientName?: string  // NOT sent to Claude — for letter placeholders only
}

export interface AuditFinding {
  lineItemIndex: number
  cptCode: string
  severity: 'error' | 'warning' | 'info'
  errorType: 'upcoding' | 'unbundling' | 'pharmacy_markup' | 'icd10_mismatch' | 'duplicate' | 'other'
  description: string        // plain English for patient
  medicareRate?: number      // from MPFS
  markupRatio?: number       // billedAmount / medicareRate
  ncciBundledWith?: string   // the Column 1 CPT it's bundled into
  recommendation: string     // what patient should do
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
  }
  extractedMeta: {
    hospitalName?: string
    accountNumber?: string
    dateOfService?: string
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
