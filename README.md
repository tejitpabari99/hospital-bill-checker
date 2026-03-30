# Hospital Bill Checker

**Find errors in your hospital bill. Free, open source, no login required.**

Upload your hospital bill and get an automated audit that checks for:
- **Upcoding** — charges for more complex services than you received
- **Unbundling** — services billed separately that should be combined
- **Pharmacy markup** — drugs billed far above CMS fair prices
- **ICD-10 mismatches** — diagnosis codes that don't justify the procedure

A ready-to-send dispute letter is generated automatically.

## Why open source?

Competitors in this space are closed products. You have to trust them. With this tool, the code is public — you can verify exactly what we do with your data (nothing: zero storage, zero logging of bill contents).

> "No login. No account. Never."

## How it works

```
PDF upload → Gemini Vision → Gemini audit → dispute letter
               (reads PDF)    (MPFS + NCCI +  (with amber
                               ASP + AI)       placeholders)
```

1. You upload your itemized hospital bill (PDF or photo)
2. We extract the billing codes using `pdf-parse` (or Claude Vision for scanned bills)
3. We check codes against three CMS public datasets: Medicare rates (MPFS), bundling rules (NCCI), and drug prices (ASP)
4. Claude audits the bill for errors and generates a dispute letter
5. Results are shown immediately — nothing is stored

## Stack

- **Frontend:** SvelteKit
- **AI:** Gemini API (`gemini-2.5-pro-exp-03-25` for audit, `gemini-2.0-flash` for vision)
- **PDF parsing:** `pdf-parse` + Claude Vision fallback
- **CMS data:** MPFS, NCCI, ASP (public datasets, rebuilt quarterly via Python scripts)
- **Deploy:** Railway / traditional Node.js server
- **Savings counter:** Local JSON file (persistent on traditional server)

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/hospital-bill-checker
cd hospital-bill-checker
bun install
cp .env.example .env  # add GEMINI_API_KEY
python3 scripts/build_mpfs.py && python3 scripts/build_ncci.py && python3 scripts/build_asp.py
bun run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full setup and architecture details.

## Data sources

| Data | Source | Update frequency |
|------|--------|-----------------|
| Medicare rates | [CMS MPFS](https://www.cms.gov/medicare/physician-fee-schedule/search) | Annual |
| Bundling rules | [CMS NCCI](https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits) | Quarterly |
| Drug prices | [CMS ASP](https://www.cms.gov/medicare/medicare-part-b-drug-average-sales-price) | Quarterly |

## Disclaimer

This tool provides information for educational purposes and to help patients ask questions. It does not provide medical or legal advice. A flagged item does not mean you were definitely overcharged — it means you have grounds to request an explanation. Always consult a qualified medical billing advocate for complex disputes.

## License

MIT — see [LICENSE](LICENSE)
