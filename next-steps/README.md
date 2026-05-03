# Hospital Bill Checker — Next Steps Implementation Plan

> **ORCHESTRATOR INSTRUCTIONS — READ FIRST:**
> Each step file in this folder is a self-contained implementation task.
> **Dispatch each step as a SEPARATE agent.** Do not combine steps into one agent.
> Give the agent the full content of the step file plus enough project context (listed at top of each step).
> Wait for each agent to complete and commit before dispatching the next one.
> Steps must be done IN ORDER — later steps depend on earlier ones.

---

## Overview

This plan transforms the Hospital Bill Checker from a mostly-LLM-driven audit tool into a **deterministic, rule-based
system** backed by CMS data in SQLite. The LLM is now used only for:
1. Vision extraction (reading the bill image/PDF)
2. Document classification (Practitioner / Outpatient / DME / Inpatient)
3. Dispute letter generation (formatting findings into a readable letter)

Everything else — every check, every finding, every rate lookup — is deterministic SQL.

---

## Step Order

| Step | File | Description | Commit |
|------|------|-------------|--------|
| 00 | [step-00-sqlite-infrastructure.md](./step-00-sqlite-infrastructure.md) | SQLite db helper module + data-loader pattern | `feat: add sqlite infrastructure` |
| 01 | [step-01-ncci-sqlite.md](./step-01-ncci-sqlite.md) | NCCI → SQLite (Practitioner + Outpatient + DME) | `feat: migrate ncci to sqlite` |
| 02 | [step-02-mue-sqlite.md](./step-02-mue-sqlite.md) | MUE → SQLite (Practitioner + Outpatient + DME) | `feat: migrate mue to sqlite` |
| 03 | [step-03-mpfs-sqlite.md](./step-03-mpfs-sqlite.md) | MPFS → SQLite (stage 1) | `feat: migrate mpfs to sqlite` |
| 04 | [step-04-clfs-sqlite.md](./step-04-clfs-sqlite.md) | CLFS → SQLite | `feat: migrate clfs to sqlite` |
| 05 | [step-05-asp-sqlite.md](./step-05-asp-sqlite.md) | ASP → SQLite | `feat: migrate asp to sqlite` |
| 06 | [step-06-opps-apc-sqlite.md](./step-06-opps-apc-sqlite.md) | OPPS Addendum A + B → SQLite (new) | `feat: add opps apc sqlite` |
| 07 | [step-07-ipps-drg-sqlite.md](./step-07-ipps-drg-sqlite.md) | IPPS MS-DRG → SQLite (new) | `feat: add ipps drg sqlite` |
| 08 | [step-08-dmepos-sqlite.md](./step-08-dmepos-sqlite.md) | DMEPOS fee schedule → SQLite (new) | `feat: add dmepos sqlite` |
| 09 | [step-09-ambulance-sqlite.md](./step-09-ambulance-sqlite.md) | Ambulance fee schedule → SQLite (new) | `feat: add ambulance fee schedule sqlite` |
| 10 | [step-10-hospital-directory-sqlite.md](./step-10-hospital-directory-sqlite.md) | Hospital directory SQLite + Trilliant search | `feat: add hospital directory sqlite` |
| 11 | [step-11-vision-modifiers.md](./step-11-vision-modifiers.md) | Vision extraction: add modifiers + quantity | `feat: extract modifiers and quantity from bills` |
| 12 | [step-12-document-classification.md](./step-12-document-classification.md) | LLM document classification (bill type) | `feat: add bill type classification` |
| 13 | [step-13-audit-engine-sqlite.md](./step-13-audit-engine-sqlite.md) | Rewrite audit engine: full SQLite routing, remove LLM findings | `feat: deterministic audit engine with sqlite` |
| 14 | [step-14-hospital-pricing-trilliant.md](./step-14-hospital-pricing-trilliant.md) | Hospital pricing via Trilliant web + local DuckDB cache | `feat: hospital pricing via trilliant` |
| 15 | [step-15-how-it-works-indicators.md](./step-15-how-it-works-indicators.md) | Add deterministic/AI indicators to how-it-works | `feat: add deterministic indicators to how-it-works` |
| 16 | [step-16-learn-page.md](./step-16-learn-page.md) | New /learn page (medical education content) | `feat: add learn page` |
| 17 | [step-17-data-endpoint.md](./step-17-data-endpoint.md) | New /data endpoint (data source documentation) | `feat: add data documentation endpoint` |
| 18 | [step-18-data-cleanup-docs.md](./step-18-data-cleanup-docs.md) | data-cleanup.md + data staleness notice | `docs: add data cleanup documentation` |
| 19 | [step-19-testing.md](./step-19-testing.md) | Integration tests for all new code | `test: add integration tests for sqlite pipeline` |
| 20 | [step-20-future-steps.md](./step-20-future-steps.md) | Future work reference (MPFS stage 2, etc.) | reference doc only |

> **NOTE:** Step 20 is a reference document only — it describes future work but has no implementation tasks.
> The last implementation step is step 19. After step 19 is complete, the plan is done.
> See `learning-plan-1.md` in the project root for diagram specifications to supply to the `/learn` page.

---

## Project Context (give to every agent)

- **Repo:** `/root/projects/hospital-bill-checker`
- **Stack:** SvelteKit + TypeScript + Vite, Node adapter, `better-sqlite3` for SQLite, Gemini (Vision + Pro)
- **Python:** Scripts in `scripts/` use Python 3, dependencies in `scripts/requirements.txt`
- **Data dir:** `data/` — runtime, not committed to git (except seed files)
- **Static data dir:** `src/lib/data/` — currently JSON files loaded at build time, being migrated to SQLite in `data/`
- **Key server files:**
  - `src/lib/server/claude.ts` — audit orchestration
  - `src/lib/server/audit-rules.ts` — deterministic rule functions
  - `src/lib/server/vision-extract.mjs` — Gemini Vision child process
  - `src/lib/server/claude-worker.mjs` — Gemini audit child process
  - `src/lib/server/hospital-prices.ts` — MRF hospital price lookup
- **Commands:** `cd /root/projects/hospital-bill-checker && npm run check && npm run build`
- **Tests:** `npm run test` (vitest)

---

## Architecture Decisions (reference for all agents)

### SQLite database files (all in `data/`)
| File | Contains |
|------|----------|
| `data/ncci.sqlite` | NCCI PTP edits — all 3 bill types |
| `data/mue.sqlite` | MUE edits — all 3 bill types |
| `data/mpfs.sqlite` | MPFS physician fee schedule |
| `data/clfs.sqlite` | CLFS lab fee schedule |
| `data/asp.sqlite` | ASP drug payment limits |
| `data/opps.sqlite` | OPPS Addendum A + B |
| `data/ipps.sqlite` | IPPS MS-DRG weights |
| `data/dmepos.sqlite` | DMEPOS fee schedule |
| `data/ambulance.sqlite` | Ambulance fee schedule |
| `data/hospital_directory.sqlite` | Hospital search index |
| `data/hospital_cache/*.sqlite` | Per-hospital pricing (converted from DuckDB) |

### Data loading (TypeScript)
- `src/lib/server/db.ts` — opens/caches SQLite connections
- `src/lib/server/data-loader.ts` — queries SQLite, returns typed data
- `src/lib/server/audit-rules.ts` — pure deterministic functions (unchanged API, new data source)

### LLM usage (ONLY these 3)
1. `vision-extract.mjs` — extract bill data from PDF/image
2. Classification call (new) — determine bill type
3. `claude-worker.mjs` — generate dispute letter (NOT findings)

### Date filtering
NCCI and MUE store all rows (no expiry filter at ingest time). Queries filter by:
- `effective_date <= service_date_int`
- `deletion_date >= service_date_int`
If no service date on the bill, use today (YYYYMMDD integer).

### NCCI modifier validation
Stored per-pair `(col1_code, col2_code)`. Each pair has its own `modifier_indicator`:
- `'0'` = never allowed, always an error
- `'1'` = modifier -59 / X{EPSU} can override with documentation
- `'9'` = not applicable
