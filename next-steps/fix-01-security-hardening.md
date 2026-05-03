# Fix 01: Security Hardening

> **AGENT INSTRUCTIONS:** You are implementing fix 01.
> Work in `/root/projects/hospital-bill-checker`. Read `next-steps/README.md` for project context.

**Goal:** Harden the API against rate-limit bypass, unbounded LLM output values, and injection of raw LLM strings into API responses. These issues affect a medical billing application where malicious or erroneous output could mislead patients about their bills.

---

## Background

Seven security issues were found during review:

1. **In-process rate limiter** (`rateLimitMap`) is wiped on every process restart and provides zero protection in multi-process deployments (e.g. Node cluster, PM2, container orchestration). `/api/parse` has no rate limiting at all.
2. **`X-Forwarded-For` used as rate-limit key without validation** — a client can send `X-Forwarded-For: 1.2.3.4` to impersonate any IP and reset their quota. The code takes only the first split value but does not validate it is actually an IP.
3. **Vision-extracted `units` and `amount`** pass through `toFiniteNumber` but are never clamped to `MAX_UNITS` / `MAX_MONEY`. A malicious PDF could cause the LLM to return `amount: 999999999` which would pass through to the audit engine unchecked.
4. **`sanitizeCount` accepts `0` and fractional values** like `0.5` — units should be positive integers only.
5. **`parseWarning` returns raw LLM string verbatim** — if a malicious PDF triggers a crafted `errorMessage` from the LLM, that string goes directly to the client with no sanitization (prompt injection / false medical claims).
6. **`disputeLetter.text` returned verbatim from LLM** — if frontend ever renders with `@html` or innerHTML, XSS risk.
7. **`rateLimitMap` is never purged** of expired entries — unbounded memory growth over time.
8. **Dead `'-59'` entry in `MODIFIER_59_FAMILY`** — the sanitizer strips leading dashes, so `'-59'` never matches; only `'59'` ever does.

---

## Task 1: Fix `sanitizeCount` to require positive integers

**File:** `src/routes/api/audit/+server.ts`

Find this function (lines 69-75):

```typescript
function sanitizeCount(value: unknown, field: string): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_UNITS) {
    throw error(400, `${field} invalid`)
  }
  return value
}
```

Replace it with:

```typescript
function sanitizeCount(value: unknown, field: string): number | undefined {
  if (value == null) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isInteger(value) ||
    value > MAX_UNITS
  ) {
    throw error(400, `${field} must be a positive integer`)
  }
  return value
}
```

**What changed:** `value < 0` became `value <= 0` (blocks zero) and added `!Number.isInteger(value)` (blocks `0.5`, `1.5`, etc.).

---

## Task 2: Validate `X-Forwarded-For` before using as rate-limit key

**File:** `src/routes/api/audit/+server.ts`

Find this block near line 174:

```typescript
const forwarded = request.headers.get('x-forwarded-for')
const ip = forwarded ? forwarded.split(',')[0].trim() : 'unknown'
```

Replace it with:

```typescript
const forwarded = request.headers.get('x-forwarded-for')
// Only trust the header if it looks like a real IP (IPv4 or IPv6).
// Client-controlled header — do not trust arbitrary strings as the rate-limit key.
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{3,39}$/
const rawIp = forwarded ? forwarded.split(',')[0].trim() : ''
const ip = IP_RE.test(rawIp) ? rawIp : 'unknown'
```

This means a forged or malformed `X-Forwarded-For` falls back to `'unknown'`, which effectively becomes a single shared bucket rather than an escape hatch. For a proper multi-process fix see Task 3, but this prevents trivial bypass.

---

## Task 3: Purge expired entries from `rateLimitMap`

**File:** `src/routes/api/audit/+server.ts`

After the line:

```typescript
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
```

Add a periodic cleanup interval:

```typescript
// Purge expired rate-limit entries every 5 minutes to prevent unbounded memory growth.
// This runs in-process; for multi-process deployments replace with Redis or a reverse-proxy rule.
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(key)
  }
}, 5 * 60 * 1000).unref()
```

The `.unref()` call ensures the interval does not prevent Node.js from exiting cleanly.

---

## Task 4: Add a comment about multi-process rate limiting

**File:** `src/routes/api/audit/+server.ts`

Find the existing constant block near the top:

```typescript
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000
```

Replace with:

```typescript
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000
// NOTE: rateLimitMap is in-process only. In a multi-process or containerized deployment,
// replace with a shared Redis store (e.g. ioredis + sliding window) or rely on a
// reverse-proxy rate limiter (nginx limit_req, Cloudflare rate limiting, etc.).
// The in-process limiter is adequate for single-process deployments only.
```

---

## Task 5: Clamp vision-extracted `units` and `amount` to safe bounds

**File:** `src/lib/server/pdf.ts`

Find `sanitizeVisionLineItems` — it currently does:

```typescript
const units = toFiniteNumber(rawItem.units, 1)
const quantity = toFiniteNumber(rawItem.quantity, units)
const amount = toFiniteNumber(rawItem.amount, 0)
```

Replace those three lines with:

```typescript
const MAX_VISION_UNITS = 10_000    // matches MAX_UNITS in the API validator
const MAX_VISION_AMOUNT = 100_000_000  // matches MAX_MONEY in the API validator

const rawUnits = toFiniteNumber(rawItem.units, 1)
const units = Math.min(Math.max(rawUnits, 0), MAX_VISION_UNITS)

const rawQuantity = toFiniteNumber(rawItem.quantity, units)
const quantity = Math.min(Math.max(rawQuantity, 0), MAX_VISION_UNITS)

const rawAmount = toFiniteNumber(rawItem.amount, 0)
const amount = Math.min(Math.max(rawAmount, 0), MAX_VISION_AMOUNT)
```

Note: negative amounts from LLM are clamped to 0 (not rejected) because vision occasionally returns negative credit line items; we want to discard those silently rather than fail the whole parse.

---

## Task 6: Sanitize `parseWarning` before returning to client

**File:** `src/lib/server/pdf.ts`

Find the block where `parsed.errorMessage` is used (around line 267):

```typescript
if (parsed.errorMessage) {
  log.error('vision-domain-error', { errorMessage: parsed.errorMessage })
  return {
    rawText: '',
    cptCodesFound: [],
    pageCount,
    usedVision: true,
    parseWarning: parsed.errorMessage,
  }
}
```

Replace with:

```typescript
if (parsed.errorMessage) {
  log.error('vision-domain-error', { errorMessage: parsed.errorMessage })
  // Sanitize the LLM-produced error string before returning to the client.
  // Only pass through messages matching a safe allow-list of expected reasons.
  // All other LLM-generated text is replaced with a generic message.
  const SAFE_ERROR_PATTERNS = [
    /not a medical bill/i,
    /not a hospital bill/i,
    /could not read/i,
    /too blurry/i,
    /too large/i,
    /password.?protected/i,
    /corrupt/i,
    /blank/i,
  ]
  const isSafe = SAFE_ERROR_PATTERNS.some(re => re.test(String(parsed.errorMessage)))
  const safeWarning = isSafe
    ? String(parsed.errorMessage).slice(0, 200)
    : "We couldn't process this document. Please try uploading a clearer scan of your itemized bill."
  return {
    rawText: '',
    cptCodesFound: [],
    pageCount,
    usedVision: true,
    parseWarning: safeWarning,
  }
}
```

---

## Task 7: Remove dead `'-59'` entry from `MODIFIER_59_FAMILY`

**File:** `src/lib/server/audit-rules.ts`

Find line 66:

```typescript
const MODIFIER_59_FAMILY = ['59', '-59', 'XE', 'XP', 'XS', 'XU']
```

Replace with:

```typescript
// '-59' is intentionally excluded: the sanitizer in +server.ts strips leading dashes
// (see sanitizeStringList → replace(/^-/, '')), so '-59' never appears in modifiers[].
const MODIFIER_59_FAMILY = ['59', 'XE', 'XP', 'XS', 'XU']
```

---

## Task 8: Add a code comment about dispute letter XSS risk

**File:** `src/lib/server/claude.ts`

Find the line that assigns `disputeLetterText` (around line 183):

```typescript
if (letterResult.text) {
  disputeLetterText = letterResult.text
```

Add a comment immediately above the `return` statement that builds the final response (around line 213):

```typescript
  // SECURITY NOTE: disputeLetter.text is raw LLM output.
  // The frontend MUST render it as plain text (e.g. inside <pre> or with textContent).
  // Never render with {@html ...} or innerHTML — the LLM output is not sanitized for HTML.
  return {
    findings: allFindings,
    disputeLetter: { text: disputeLetterText, placeholders },
```

---

## Verification

- [ ] `sanitizeCount(0, 'x')` throws a 400 error
- [ ] `sanitizeCount(0.5, 'x')` throws a 400 error
- [ ] `sanitizeCount(1, 'x')` returns `1`
- [ ] `sanitizeCount(10000, 'x')` returns `10000`
- [ ] `sanitizeCount(10001, 'x')` throws a 400 error
- [ ] `npm run check` passes with no TypeScript errors
- [ ] `npm run test` passes

---

## Commit

```bash
git add src/routes/api/audit/+server.ts src/lib/server/pdf.ts src/lib/server/audit-rules.ts src/lib/server/claude.ts
git commit -m "fix: harden rate limiter, clamp LLM output bounds, sanitize parseWarning, remove dead modifier"
```
