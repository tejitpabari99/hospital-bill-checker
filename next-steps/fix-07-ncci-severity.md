# Fix 07: NCCI Modifier Indicator Severity

> **AGENT INSTRUCTIONS:** You are implementing fix 07.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Fix NCCI modifier_indicator severity logic so that indicator=1 produces a `warning` (not an error), indicator=9 is silently skipped, and the recommendation text accurately reflects what each indicator means.

---

## Background

CMS NCCI `modifier_indicator` values have three distinct meanings:

| Value | Meaning | Correct behavior |
|-------|---------|-----------------|
| `'0'` | Always bundled — no override possible | Emit finding with `severity: 'error'` |
| `'1'` | Modifier -59 / X{EPSU} can override with documentation | Emit finding with `severity: 'warning'`; SUPPRESS finding entirely if modifier is present |
| `'9'` | Not applicable | Skip entirely — no finding |

**Current bug in `src/lib/server/audit-rules.ts`** (the NCCI block inside `buildDeterministicFindings`):

```typescript
const modifierCanOverride = pair.modifier_indicator !== '0'
const modifierOverrides = modifierCanOverride && hasModifier59
if (modifierOverrides) continue
// falls through — always pushes finding with severity: 'error'
```

This has two problems:

1. When `modifier_indicator === '1'` with NO modifier present: pushes `severity: 'error'` — should be `severity: 'warning'` because the provider may have documentation that justifies separate billing.
2. When `modifier_indicator === '9'`: `modifierCanOverride = true`, `modifierOverrides = false` (no -59 present) → pushes `severity: 'error'` — should `continue` (skip entirely, this pair is not applicable).

---

## Task 1: Fix the modifier_indicator branching logic

**File:** `src/lib/server/audit-rules.ts`

Find the NCCI loop block inside `buildDeterministicFindings`. It looks approximately like this:

```typescript
const modifierCanOverride = pair.modifier_indicator !== '0'
const modifierOverrides = modifierCanOverride && hasModifier59
if (modifierOverrides) continue
// ... finding push with hardcoded severity: 'error'
```

Replace the modifier_indicator handling with:

```typescript
const ind = String(pair.modifier_indicator).trim()
if (ind === '9') continue  // not applicable — no finding

const modifierCanOverride = ind === '1'
const modifierOverrides = modifierCanOverride && hasModifier59Family
if (modifierOverrides) continue  // documentation present, separate billing allowed

const severity: 'error' | 'warning' = modifierCanOverride ? 'warning' : 'error'
```

Then, in the finding push that follows, replace the hardcoded `severity: 'error'` with `severity`.

---

## Task 2: Update the recommendation text per indicator type

**File:** `src/lib/server/audit-rules.ts`

In the same NCCI finding push block, update the `recommendation` field so it reflects the actual indicator meaning. After computing `severity`, also compute `recommendation`:

```typescript
const recommendation =
  modifierCanOverride
    ? 'Separate billing may be permitted with modifier -59 or X{EPSU} and appropriate documentation. Request the medical record and authorization letter.'
    : 'This code pair is always bundled — separate billing is not permitted regardless of documentation.'
```

Then use `recommendation` in the finding object instead of a hardcoded string.

---

## Task 3: Confirm `hasModifier59Family` variable name

The existing code may use `hasModifier59` (checking the `-59` modifier family). After fix-01, the dead `'-59'` entry was removed from `MODIFIER_59_FAMILY`. Ensure the variable being checked in the NCCI block uses the full family set (`['59', 'XE', 'XP', 'XS', 'XU']`). If the variable is still named `hasModifier59`, rename it to `hasModifier59Family` for clarity, or leave the name as-is if changing it would require touching too many call sites — consistency with the rest of the file is more important than the rename.

---

## Tests to add in `src/lib/server/audit-rules.test.ts`

Add the following tests. Use the `ncciDb` fixture already established in the test file. If no fixture exists, skip the DB-dependent tests with `it.skipIf(!ncciDb)(...)`.

```typescript
describe('buildDeterministicFindings — NCCI modifier_indicator severity', () => {
  it.skipIf(!ncciDb)(
    'modifier_indicator=0 pair without modifier produces severity: error',
    () => {
      // Query ncciDb for a pair with modifier_indicator = '0'
      const pair = ncciDb
        .prepare("SELECT column_1_code, column_2_code FROM ncci_edits WHERE modifier_indicator = '0' LIMIT 1")
        .get() as { column_1_code: string; column_2_code: string } | undefined
      if (!pair) return  // skip if DB has no indicator=0 pairs

      const lineItems = [
        li(pair.column_1_code, 500),
        li(pair.column_2_code, 250),
      ]
      const { findings } = buildDeterministicFindings(lineItems)
      const ncciFinding = findings.find(f => f.errorType === 'ncci_bundling')
      expect(ncciFinding).toBeDefined()
      expect(ncciFinding?.severity).toBe('error')
    }
  )

  it.skipIf(!ncciDb)(
    'modifier_indicator=1 pair without modifier produces severity: warning (not error)',
    () => {
      const pair = ncciDb
        .prepare("SELECT column_1_code, column_2_code FROM ncci_edits WHERE modifier_indicator = '1' LIMIT 1")
        .get() as { column_1_code: string; column_2_code: string } | undefined
      if (!pair) return  // skip if DB has no indicator=1 pairs

      const lineItems = [
        li(pair.column_1_code, 500),
        li(pair.column_2_code, 250),
      ]
      const { findings } = buildDeterministicFindings(lineItems)
      const ncciFinding = findings.find(f => f.errorType === 'ncci_bundling')
      expect(ncciFinding).toBeDefined()
      expect(ncciFinding?.severity).toBe('warning')
    }
  )

  it.skipIf(!ncciDb)(
    'modifier_indicator=1 pair WITH modifier -59 produces no finding (suppressed)',
    () => {
      const pair = ncciDb
        .prepare("SELECT column_1_code, column_2_code FROM ncci_edits WHERE modifier_indicator = '1' LIMIT 1")
        .get() as { column_1_code: string; column_2_code: string } | undefined
      if (!pair) return

      const lineItems = [
        { ...li(pair.column_1_code, 500), modifiers: ['59'] },
        li(pair.column_2_code, 250),
      ]
      const { findings } = buildDeterministicFindings(lineItems)
      const ncciFinding = findings.find(f => f.errorType === 'ncci_bundling')
      expect(ncciFinding).toBeUndefined()
    }
  )

  it.skipIf(!ncciDb)(
    'modifier_indicator=9 pair produces no finding (not applicable)',
    () => {
      const pair = ncciDb
        .prepare("SELECT column_1_code, column_2_code FROM ncci_edits WHERE modifier_indicator = '9' LIMIT 1")
        .get() as { column_1_code: string; column_2_code: string } | undefined
      if (!pair) return  // skip if DB has no indicator=9 pairs

      const lineItems = [
        li(pair.column_1_code, 500),
        li(pair.column_2_code, 250),
      ]
      const { findings } = buildDeterministicFindings(lineItems)
      const ncciFinding = findings.find(f => f.errorType === 'ncci_bundling')
      expect(ncciFinding).toBeUndefined()
    }
  )
})
```

---

## Verification

- [ ] A NCCI pair with `modifier_indicator='0'` and no modifier present → `severity: 'error'`
- [ ] A NCCI pair with `modifier_indicator='1'` and no modifier present → `severity: 'warning'`
- [ ] A NCCI pair with `modifier_indicator='1'` with modifier `'59'` present → no finding at all
- [ ] A NCCI pair with `modifier_indicator='9'` → no finding at all
- [ ] `npm run check` passes with no TypeScript errors
- [ ] `npm run test` passes

---

## Commit

```bash
git add src/lib/server/audit-rules.ts src/lib/server/audit-rules.test.ts
git commit -m "fix: ncci modifier severity — indicator=1 is warning, indicator=9 is skipped"
```
