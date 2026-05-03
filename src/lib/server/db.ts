import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync } from 'fs'

const DATA_DIR = join(process.cwd(), 'data')

function openDb(filename: string): Database.Database | null {
  const path = join(DATA_DIR, filename)
  if (!existsSync(path)) return null
  try {
    const db = new Database(path, { readonly: true })
    // Probe the file — catches LFS pointer files that pass construction but fail on use
    db.prepare('SELECT 1').get()
    return db
  } catch (err) {
    console.warn(`[db] Failed to open ${filename}:`, err)
    return null
  }
}

// Each DB is opened once and cached for the lifetime of the process
let _ncci: Database.Database | null | undefined = undefined
let _mue: Database.Database | null | undefined = undefined
let _mpfs: Database.Database | null | undefined = undefined
let _clfs: Database.Database | null | undefined = undefined
let _asp: Database.Database | null | undefined = undefined
let _opps: Database.Database | null | undefined = undefined
let _ipps: Database.Database | null | undefined = undefined
let _dmepos: Database.Database | null | undefined = undefined
let _ambulance: Database.Database | null | undefined = undefined
let _hospitalDir: Database.Database | null | undefined = undefined

export function getNcciDb(): Database.Database | null {
  if (_ncci !== undefined) return _ncci
  return (_ncci = openDb('ncci.sqlite'))
}

export function getMueDb(): Database.Database | null {
  if (_mue !== undefined) return _mue
  return (_mue = openDb('mue.sqlite'))
}

export function getMpfsDb(): Database.Database | null {
  if (_mpfs !== undefined) return _mpfs
  return (_mpfs = openDb('mpfs.sqlite'))
}

export function getClfsDb(): Database.Database | null {
  if (_clfs !== undefined) return _clfs
  return (_clfs = openDb('clfs.sqlite'))
}

export function getAspDb(): Database.Database | null {
  if (_asp !== undefined) return _asp
  return (_asp = openDb('asp.sqlite'))
}

export function getOppsDb(): Database.Database | null {
  if (_opps !== undefined) return _opps
  return (_opps = openDb('opps.sqlite'))
}

export function getIppsDb(): Database.Database | null {
  if (_ipps !== undefined) return _ipps
  return (_ipps = openDb('ipps.sqlite'))
}

export function getDmeposDb(): Database.Database | null {
  if (_dmepos !== undefined) return _dmepos
  return (_dmepos = openDb('dmepos.sqlite'))
}

export function getAmbulanceDb(): Database.Database | null {
  if (_ambulance !== undefined) return _ambulance
  return (_ambulance = openDb('ambulance.sqlite'))
}

export function getHospitalDirectoryDb(): Database.Database | null {
  if (_hospitalDir !== undefined) return _hospitalDir
  return (_hospitalDir = openDb('hospital_directory.sqlite'))
}

/** Open a per-hospital pricing SQLite (converted from DuckDB). Returns null if not cached. */
export function getHospitalCacheDb(hospitalId: string): Database.Database | null {
  const safeName = hospitalId.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80)
  if (process.env.HOSPITAL_CACHE_DIR) {
    const path = join(process.env.HOSPITAL_CACHE_DIR, `${safeName}.sqlite`)
    if (!existsSync(path)) return null
    try {
      return new Database(path, { readonly: true })
    } catch (err) {
      console.warn(`[db] Failed to open ${path}:`, err)
      return null
    }
  }
  return openDb(join('hospital_cache', `${safeName}.sqlite`))
}

/** For writable access during script execution (not for server). */
export function openWritable(filename: string): Database.Database {
  const path = join(DATA_DIR, filename)
  return new Database(path)
}
