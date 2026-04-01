/**
 * Gemini function declarations for the tool-calling audit flow.
 * These mirror the deterministic lookup helpers in audit-rules.ts.
 */
export const AUDIT_TOOL_DECLARATIONS = [
  {
    name: 'lookup_mpfs_rate',
    description: 'Look up the Medicare Physician Fee Schedule rate for a CPT or HCPCS code.',
    parameters: {
      type: 'OBJECT',
      properties: {
        cptCode: { type: 'STRING', description: 'CPT or HCPCS code' },
      },
      required: ['cptCode'],
    },
  },
  {
    name: 'check_ncci_bundling',
    description: 'Check if a CPT code is bundled into another code per CMS NCCI PTP edits.',
    parameters: {
      type: 'OBJECT',
      properties: {
        cptCode: { type: 'STRING', description: 'The code to check' },
        allCodesOnBill: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'All CPT/HCPCS codes present on the bill',
        },
        modifiers: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Modifiers on this line item',
        },
      },
      required: ['cptCode', 'allCodesOnBill'],
    },
  },
  {
    name: 'check_mue_units',
    description: 'Check if units billed for a CPT code exceed the CMS Medically Unlikely Edit limit.',
    parameters: {
      type: 'OBJECT',
      properties: {
        cptCode: { type: 'STRING' },
        unitsBilled: { type: 'NUMBER', description: 'Total units billed for this code on this date' },
      },
      required: ['cptCode', 'unitsBilled'],
    },
  },
  {
    name: 'check_lcd_coverage',
    description: 'Check if the diagnosis codes on a line item support coverage for this procedure per CMS LCD rules.',
    parameters: {
      type: 'OBJECT',
      properties: {
        cptCode: { type: 'STRING' },
        icd10Codes: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'ICD-10 diagnosis codes present on this bill',
        },
      },
      required: ['cptCode', 'icd10Codes'],
    },
  },
]
