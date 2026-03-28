# Example Bills

These are **synthetically generated** example bills for testing. They do not contain any real patient data.

## Files

| File | Description | Expected findings |
|------|-------------|------------------|
| `example-er-visit.json` | Emergency room visit with upcoded E&M and one NCCI violation | 2 errors, 1 warning |
| `example-pharmacy.json` | Outpatient visit with inflated J-code pharmacy charge | 1 error |
| `example-clean.json` | Clean bill with no issues | 0 errors |

## Format

Each file is a `BillInput` JSON object matching the schema in `src/lib/types.ts`.

To test via API (with local dev server running):
```bash
curl -X POST http://localhost:5173/api/audit \
  -H "Content-Type: application/json" \
  -d @examples/example-er-visit.json
```
