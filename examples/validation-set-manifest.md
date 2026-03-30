# Validation Set Manifest

Source folder: `https://drive.google.com/drive/folders/17UQvF7ma_EcQseFbcaIhdiwlRF24Sb_9`

This folder is the Drive-backed validation inventory for `hospital-bill-checker`.
All items below are either already mirrored in `examples/test-images/` or are
the source copies for those local test assets.

## Inventory

| Asset | Type | Drive file title | Drive file ID | Status | Notes |
|---|---|---|---|---|---|
| Stanford front page | JPG | `1728679915072.jpg` | `1DN3IsEUVr_H5DhPZQuqlgk2kjKrKD-NF` | Mirrored locally | Scanned/image-style bill page. Good Vision path test. |
| Stanford back page | JPG | `1728680002072.jpg` | `1cm93E1kwDU4R2gluvRLfQVeU81v9-Kls` | Mirrored locally | Companion scanned page. Good for multi-page image handling. |
| Riverside itemized bill | PDF | `Sample-Itemized-Billing-Statement-Riverside.pdf` | `1q1lU_lZR1Dvw4Fhw5Yw0wSyZs1fnHlx5` | Mirrored locally | Real itemized hospital bill. Strong candidate for overcharge detection. |
| HCA itemized bill | PDF | `Sample-Itemized-Billing-Statement-HCA-Hospital.pdf` | `1e9DLaL5fnJLh4gZmGpD2UNt03ebzJUMJ` | Mirrored locally | Real itemized hospital bill. |
| VCU itemized bill | PDF | `Sample-Itemized-Billing-Statement-VCU.pdf` | `10Fw59Hhk9A_6h5o3LJcqpo8WIfxYhaef` | Mirrored locally | Real itemized hospital bill. |
| Sentara itemized bill | PDF | `Sample-Itemized-Billing-Statement-Sentara.pdf` | `1_hLx8vc7uufuU-6QkMVLvkuRbPf48sfH` | Mirrored locally | Real itemized hospital bill. |
| Mayo itemized statement | PDF | `doc-20078974.pdf` | `13nE5I7NRL6VWwig6eGh3Z-leMCTzf48A` | Mirrored locally | Real bill statement with visible CPT context. |
| SSM Health sample bill | PDF | `ssm-health-sample-hospital-bill.pdf` | `120_3oairBBYQp358Ihkh9T0DYDIa5Kvx` | Mirrored locally | Real statement-style hospital bill. |

## Duplicates / Overlap

- The Drive inventory is a mirror of files already checked into `examples/test-images/`.
- Do not redownload these unless you are replacing the local copies with fresher source files.
- `doc-20078974.pdf` is the Mayo itemized statement and should be treated as the same validation case as the local Mayo sample.
- The two Stanford JPGs should be treated as a paired scanned test case.

## Recommended Validation Order

1. `example-clean.json`
2. `example-er-visit.json`
3. `example-pharmacy.json`
4. `clean-bill.pdf`
5. `upcoding-scenario.pdf`
6. `ncci-unbundling.pdf`
7. `duplicate-billing.pdf`
8. `pharmacy-markup.pdf`
9. `icd10-mismatch.pdf`
10. `summary-bill-no-cpt.pdf`
11. Stanford front/back JPG pair
12. Riverside, HCA, VCU, Sentara, Mayo, SSM bills

## Validation Notes

- Run audits one file at a time to avoid Gemini rate-limit collisions.
- Keep a result log with the exact file name, parse route used, findings count,
  and any false positives or missing codes.
- Treat the Drive folder as the canonical source index; the repo-local copies are
  the test fixtures used during development.
