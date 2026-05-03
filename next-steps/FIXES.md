# Fix Steps — Post-Review Issues

Generated from code review of commits `9ac2a7d` → `2edf889`.

## Fix Order

| Fix | File | Description | Priority |
|-----|------|-------------|----------|
| 01 | fix-01-security-hardening.md | Security: rate limiting, input bounds, output sanitization | HIGH |
| 02 | fix-02-audit-engine-correctness.md | Audit rule bugs: double-findings, wrong regex, silent failures | CRITICAL |
| 03 | fix-03-python-pipeline-correctness.md | Python data pipeline: NCCI layout, MUE nulls, MPFS columns | HIGH |
| 04 | fix-04-trilliant-robustness.md | Trilliant: atomic writes, phone dedup, column mapping | HIGH |
| 05 | fix-05-frontend-ui-fixes.md | UI: garbled text, wrong numbering, input validation | MEDIUM |
| 06 | fix-06-test-improvements.md | Tests: assertions, missing edge cases, fixture consistency | MEDIUM |

## Implementation Notes

- Fix 02 is the highest-priority: audit engine bugs cause wrong patient advice
- Fix 01 and 03 are next: security and data integrity
- Fixes 05 and 06 are lower-risk but should not be skipped
- Each fix is self-contained and can be dispatched as a separate agent

## Issue Cross-Reference

| Issue | Fix File | Description |
|-------|----------|-------------|
| S1 | fix-01 | In-process rate limiter wiped on restart |
| S2 | fix-01 | X-Forwarded-For not validated |
| S3 | fix-01 | Vision units/amount not bounds-clamped |
| S4 | fix-01 | /api/parse has no rate limiting (noted, not implemented) |
| S5 | fix-01 | parseWarning returns raw LLM string |
| S6 | fix-01 | disputeLetter.text XSS comment added |
| S8 | fix-01 | sanitizeCount accepts 0 and fractional |
| S9 | fix-01 | rateLimitMap never purged |
| S10 | fix-01 | Dead '-59' entry in MODIFIER_59_FAMILY |
| A1 | fix-02 | OPPS does not add to alreadyFlaggedCodes |
| A2 | fix-02 | Ambulance regex matches A03xx drug codes |
| A3 | fix-02 | MPFS rate dollar assertion comment added |
| A4 | fix-02 | MUE MAI String() coercion |
| A5 | fix-02 | DMEPOS/ambulance info finding on skip |
| A6 | fix-02 | billedAmount string coercion |
| A7 | fix-02 | Outpatient falls through to MPFS benchmark |
| A8 | fix-02 | Duplicate Check 7 label |
| P1 | fix-03 | NCCI INSERT OR REPLACE silent conflict |
| P2 | fix-03 | NCCI layout detection fragility |
| P3 | fix-03 | MUE suppressed values dropped |
| P4 | fix-03 | OPPS header detection fragility |
| P7 | fix-03 | MPFS hardcoded column indices |
| P10 | fix-03 | requirements.txt bogus beautifulsoup4 version |
| P12 | fix-03 | ASP CSV fallback may pick wrong file |
| P5 | fix-04 | Trilliant phone ignored in cache key |
| P6 | fix-04 | Trilliant partial SQLite cleanup race |
| P9 | fix-04 | Trilliant min/max negotiated column mapping |
| F1 | fix-05 | Garbled how-it-works paragraph |
| F2 | fix-05 | Learn page AI step numbering inverted |
| F3 | fix-05 | Data page false subtitle + hardcoded counts |
| F4 | fix-05 | GFE input NaN sent to server |
| F8 | fix-05 | how-it-works missing prerender |
| F5 | fix-06 | Integration test only asserts Array.isArray |
| F6 | fix-06 | Triple-billing test name contradicts assertion |
| F7 | fix-06 | {@html} XSS pattern comment added |
| F9 | fix-06 | MUE fixture field names inconsistent |
| A9 | fix-06 | Missing test: OPPS zero-rate packaged service |
| A10 | fix-06 | Missing test: billedAmount as string |
| A11 | fix-06 | Missing test: A03xx code not ambulance |
| A12 | fix-06 | Missing test: integer MAI through audit engine |

## Issues Not Implemented (Require External Infrastructure)

| Issue | Reason |
|-------|--------|
| S1 (full) | Multi-process rate limiting requires Redis or reverse-proxy config — out of scope for a code fix |
| S4 | /api/parse rate limiting — requires creating `src/routes/api/parse/+server.ts` rate limit, out of scope for this fix batch |
| S7 | hospitalMrfUrl re-validation — requires network call to verify URL is still Trilliant-hosted; deferred to a dedicated security pass |
| P8 | DMEPOS double-insert on second run — requires pre-delete or idempotency change across the full DMEPOS build script; deferred |
| P11 | Atomic write pattern for all build scripts — architectural change affecting all 9 scripts; deferred to a dedicated pipeline hardening pass |
