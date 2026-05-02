/**
 * data-loader.ts
 * Queries SQLite databases and returns typed data for the audit engine.
 * Later steps add implementations of each loader function.
 */

import type { BillType } from '$lib/types'
import {
  getNcciDb,
  getMueDb,
  getMpfsDb,
  getClfsDb,
  getAspDb,
  getOppsDb,
  getIppsDb,
  getDmeposDb,
  getAmbulanceDb,
} from './db'

// ─── NCCI ────────────────────────────────────────────────────────────────────

export type NcciPairRow = {
  col1_code: string
  modifier_indicator: string  // '0' | '1' | '9'
  rationale: string | null
}

/**
 * Returns all active NCCI pairs where col2_code bundles into some col1_code,
 * filtered by bill type and service date.
 * serviceDateInt: YYYYMMDD integer. If 0, uses today.
 */
export function loadNcciPairs(
  col2Code: string,
  billType: BillType,
  serviceDateInt: number
): NcciPairRow[] {
  const db = getNcciDb()
  if (!db) return []

  // Map unknown/inpatient to practitioner as a conservative default until
  // later classification/routing steps handle bill type more explicitly.
  const dbBillType = billType === 'unknown' || billType === 'inpatient' ? 'practitioner' : billType

  const rows = db.prepare(`
    SELECT col1_code, modifier_indicator, rationale
    FROM ncci_ptp
    WHERE col2_code = ?
      AND bill_type = ?
      AND effective_date <= ?
      AND deletion_date >= ?
    ORDER BY effective_date DESC
  `).all(
    col2Code.toUpperCase().trim(),
    dbBillType,
    serviceDateInt,
    serviceDateInt
  ) as NcciPairRow[]

  return rows
}

// ─── MUE ─────────────────────────────────────────────────────────────────────

export type MueRow = {
  hcpcs_code: string
  mue_value: number
  mue_adjudication_indicator: string  // '1' | '2' | '3'
  mue_rationale: string | null
}

export function loadMueEdit(
  hcpcsCode: string,
  billType: BillType
): MueRow | null {
  const db = getMueDb()
  if (!db) return null

  const dbBillType = billType === 'unknown' ? 'practitioner' : billType

  const row = db.prepare(`
    SELECT hcpcs_code, mue_value, mue_adjudication_indicator, mue_rationale
    FROM mue_edits
    WHERE hcpcs_code = ? AND bill_type = ?
  `).get(
    hcpcsCode.toUpperCase().trim(),
    dbBillType
  ) as MueRow | undefined

  return row ?? null
}

// ─── MPFS ────────────────────────────────────────────────────────────────────

export type MpfsRow = {
  hcpcs_code: string
  description: string | null
  status_code: string | null
  nonfac_rate: number | null
  fac_rate: number | null
}

export function loadMpfsRate(hcpcsCode: string): MpfsRow | null {
  const db = getMpfsDb()
  if (!db) return null

  const row = db.prepare(`
    SELECT hcpcs_code, description, status_code, nonfac_rate, fac_rate
    FROM mpfs_rates
    WHERE hcpcs_code = ?
    ORDER BY fiscal_year DESC
    LIMIT 1
  `).get(hcpcsCode.toUpperCase().trim()) as MpfsRow | undefined

  return row ?? null
}

// ─── CLFS ────────────────────────────────────────────────────────────────────

export type ClfsRow = {
  hcpcs_code: string
  rate: number
  description: string | null
  indicator: string | null
  eff_date: string | null
}

export function loadClfsRate(hcpcsCode: string): ClfsRow | null {
  const db = getClfsDb()
  if (!db) return null

  // Use clfs_current for fast lookup (latest rate per code)
  const row = db.prepare(`
    SELECT hcpcs_code, rate, description, indicator, eff_date
    FROM clfs_current
    WHERE hcpcs_code = ?
  `).get(hcpcsCode.toUpperCase().trim()) as ClfsRow | undefined

  return row ?? null
}

// ─── ASP ─────────────────────────────────────────────────────────────────────

export type AspRow = {
  hcpcs_code: string
  payment_limit: number
  description: string | null
  dosage: string | null
}

export function loadAspLimit(hcpcsCode: string): AspRow | null {
  return null  // implemented in step-05
}

// ─── OPPS ────────────────────────────────────────────────────────────────────

export type OppsRow = {
  hcpcs_code: string
  short_descriptor: string | null
  status_indicator: string | null
  apc: string | null
  payment_rate: number | null
  apc_title: string | null
}

export function loadOppsRate(hcpcsCode: string, quarter?: string): OppsRow | null {
  return null  // implemented in step-06
}

// ─── IPPS ────────────────────────────────────────────────────────────────────

export type IppsRow = {
  ms_drg: string
  title: string | null
  relative_weight: number | null
  geometric_mean_los: number | null
  arithmetic_mean_los: number | null
}

export function loadDrgRate(drgCode: string, fiscalYear?: string): IppsRow | null {
  return null  // implemented in step-07
}

// ─── DMEPOS ──────────────────────────────────────────────────────────────────

export type DmeposRow = {
  hcpcs_code: string
  description: string | null
  mod: string | null
  mod2: string | null
  category: string | null
  ceiling: number | null
  floor: number | null
  state_code: string
  fee_amount: number | null
}

export function loadDmeposRate(hcpcsCode: string, stateCode: string): DmeposRow | null {
  return null  // implemented in step-08
}

// ─── Ambulance ───────────────────────────────────────────────────────────────

export type AmbulanceRow = {
  hcpcs_code: string
  short_description: string | null
  locality: string | null
  area_type: string | null
  base_rate: number | null
  mileage_rate: number | null
  rate_amount: number | null
}

export function loadAmbulanceRate(hcpcsCode: string, zipCode: string): AmbulanceRow | null {
  return null  // implemented in step-09
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a date string (any format parseable by Date constructor, or YYYYMMDD)
 * to a YYYYMMDD integer for NCCI/MUE date comparisons.
 * Falls back to today if input is invalid or empty.
 */
export function toServiceDateInt(dateStr: string | undefined | null): number {
  if (dateStr) {
    // Already YYYYMMDD?
    const compact = dateStr.replace(/-/g, '')
    if (/^\d{8}$/.test(compact)) {
      const n = parseInt(compact, 10)
      if (n > 19000101 && n < 21000101) return n
    }
    // Try Date parse
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return parseInt(`${y}${m}${day}`, 10)
    }
  }
  // Fallback: today
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return parseInt(`${y}${m}${day}`, 10)
}
