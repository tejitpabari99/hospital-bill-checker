<script lang="ts">
  interface DataSource {
    id: string
    name: string
    description: string
    billTypes: string[]
    refreshCadence: string
    stalenessWarning: string
    cmsUrl: string
    localFile: string
    buildScript: string
    columnsUsed: string[]
    table: string
  }

  const sources: DataSource[] = [
    {
      id: 'ncci',
      name: 'NCCI PTP Edits',
      description: 'Procedure-to-Procedure bundling edits — pairs of CPT/HCPCS codes that cannot be billed together on the same claim.',
      billTypes: ['Practitioner', 'Outpatient Hospital', 'DME'],
      refreshCadence: 'Quarterly (Jan, Apr, Jul, Oct)',
      stalenessWarning: 'Up to 30 days after CMS quarterly release date.',
      cmsUrl: 'https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-policy-manual',
      localFile: 'data/ncci.sqlite',
      buildScript: 'scripts/build_ncci_sqlite.py',
      table: 'ncci_ptp',
      columnsUsed: ['col1_code', 'col2_code', 'effective_date', 'deletion_date', 'modifier_indicator', 'bill_type'],
    },
    {
      id: 'mue',
      name: 'MUE — Medically Unlikely Edits',
      description: 'Maximum units per HCPCS code per claim line. Only MAI=3 edits (hard claim-line denials) are used.',
      billTypes: ['Practitioner', 'Outpatient Hospital', 'DME'],
      refreshCadence: 'Quarterly',
      stalenessWarning: 'Up to 30 days after CMS quarterly release date.',
      cmsUrl: 'https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits',
      localFile: 'data/mue.sqlite',
      buildScript: 'scripts/build_mue_sqlite.py',
      table: 'mue_edits',
      columnsUsed: ['hcpcs_code', 'mue_value', 'mai', 'bill_type'],
    },
    {
      id: 'mpfs',
      name: 'Medicare Physician Fee Schedule (MPFS)',
      description: 'National non-facility payment rate for physician and professional services. Rate = NONFAC_TOTAL_RVU × $33.29 (2026 CF).',
      billTypes: ['Practitioner'],
      refreshCadence: 'Annually (January)',
      stalenessWarning: 'Up to 30 days after CMS annual release. Conversion factor ($33.29) is 2026 value.',
      cmsUrl: 'https://www.cms.gov/medicare/physician-fee-schedule/search/overview',
      localFile: 'data/mpfs.sqlite',
      buildScript: 'scripts/build_mpfs_sqlite.py',
      table: 'mpfs_rates',
      columnsUsed: ['hcpcs_code', 'modifier', 'nonfac_total_rvu', 'nonfac_rate'],
    },
    {
      id: 'clfs',
      name: 'Clinical Laboratory Fee Schedule (CLFS)',
      description: 'CMS payment limits for clinical laboratory tests billed to Medicare.',
      billTypes: ['All'],
      refreshCadence: 'Annual rate updates; effective dates vary per code',
      stalenessWarning: 'Up to 30 days after CMS annual release.',
      cmsUrl: 'https://www.cms.gov/medicare/payment/fee-schedules/clinical-laboratory',
      localFile: 'data/clfs.sqlite',
      buildScript: 'scripts/build_clfs_sqlite.py',
      table: 'clfs_rates (full history), clfs_current (latest per code view)',
      columnsUsed: ['hcpcs_code', 'payment_limit', 'effective_date'],
    },
    {
      id: 'asp',
      name: 'Average Sales Price (ASP)',
      description: 'CMS Medicare Part B drug payment limits for J-codes, Q-codes, and other injectable/infusion HCPCS codes.',
      billTypes: ['All'],
      refreshCadence: 'Quarterly',
      stalenessWarning: 'Up to 30 days after CMS quarterly release.',
      cmsUrl: 'https://www.cms.gov/medicare/payment/part-b-drugs/average-sales-price',
      localFile: 'data/asp.sqlite',
      buildScript: 'scripts/build_asp_sqlite.py',
      table: 'asp_payment_limits',
      columnsUsed: ['hcpcs_code', 'asp_payment_limit', 'quarter'],
    },
    {
      id: 'opps',
      name: 'OPPS Addendum B + A (APC Rates)',
      description: 'Outpatient Prospective Payment System rates — maps HCPCS codes to APC groups with Medicare payment amounts for hospital outpatient services.',
      billTypes: ['Outpatient Hospital'],
      refreshCadence: 'Annually (January) with quarterly updates',
      stalenessWarning: 'Up to 30 days after CMS annual/quarterly release.',
      cmsUrl: 'https://www.cms.gov/medicare/payment/prospective-payment-systems/hospital-outpatient',
      localFile: 'data/opps.sqlite',
      buildScript: 'scripts/build_opps_sqlite.py',
      table: 'opps_addendum_b, opps_addendum_a',
      columnsUsed: ['hcpcs_code', 'apc', 'payment_rate', 'apc_title'],
    },
    {
      id: 'ipps',
      name: 'IPPS DRG Weights',
      description: 'Medicare Inpatient Prospective Payment System DRG relative weights and geometric mean lengths of stay.',
      billTypes: ['Inpatient'],
      refreshCadence: 'Annually (October federal fiscal year start)',
      stalenessWarning: 'Up to 30 days after CMS annual release.',
      cmsUrl: 'https://www.cms.gov/medicare/payment/prospective-payment-systems/acute-inpatient-pps',
      localFile: 'data/ipps.sqlite',
      buildScript: 'scripts/build_ipps_sqlite.py',
      table: 'ipps_drg_rates',
      columnsUsed: ['drg_code', 'drg_title', 'relative_weight', 'geometric_mean_los'],
    },
    {
      id: 'dmepos',
      name: 'DMEPOS Fee Schedule',
      description: 'State-specific Medicare payment rates for durable medical equipment, prosthetics, orthotics, and supplies.',
      billTypes: ['DME'],
      refreshCadence: 'Annually',
      stalenessWarning: 'Up to 30 days after CMS annual release.',
      cmsUrl: 'https://www.cms.gov/medicare/payment/fee-schedules/durable-medical-equipment',
      localFile: 'data/dmepos.sqlite',
      buildScript: 'scripts/build_dmepos_sqlite.py',
      table: 'dmepos_base, dmepos_state_rates',
      columnsUsed: ['hcpcs_code', 'state', 'modifier', 'rental_rate'],
    },
    {
      id: 'ambulance',
      name: 'Ambulance Fee Schedule',
      description: 'Medicare base payment rates for emergency and non-emergency ambulance transport, mapped by ZIP code to carrier locality.',
      billTypes: ['All'],
      refreshCadence: 'Annually',
      stalenessWarning: 'Up to 30 days after CMS annual release.',
      cmsUrl: 'https://www.cms.gov/medicare/payment/fee-schedules/ambulance',
      localFile: 'data/ambulance.sqlite',
      buildScript: 'scripts/build_ambulance_sqlite.py',
      table: 'ambulance_rates, ambulance_geography',
      columnsUsed: ['hcpcs_code', 'carrier', 'locality', 'base_rate', 'zip_code'],
    },
    {
      id: 'hospital-dir',
      name: 'Hospital Directory',
      description: 'CMS Hospital General Information — used to match bill hospital name to a known CMS-registered facility and find pricing data.',
      billTypes: ['All'],
      refreshCadence: 'Updated by CMS periodically (roughly quarterly)',
      stalenessWarning: 'Rebuilt from CMS on demand. May be weeks behind CMS latest.',
      cmsUrl: 'https://data.cms.gov/provider-data/dataset/xubh-q36u',
      localFile: 'data/hospital_directory.sqlite',
      buildScript: 'scripts/build_hospital_directory_sqlite.py',
      table: 'hospitals',
      columnsUsed: ['facility_name', 'normalized_name', 'state', 'phone_digits', 'provider_id'],
    },
    {
      id: 'hospital-mrf',
      name: 'Hospital MRF Pricing (Trilliant/Oria)',
      description: 'Per-hospital price files sourced from Trilliant Health\'s Oria platform, which aggregates hospital Machine-Readable Files required by the CMS Price Transparency rule.',
      billTypes: ['All'],
      refreshCadence: 'On-demand, cached 7 days locally per hospital',
      stalenessWarning: 'Data is cached for up to 7 days. Underlying MRF files are published by hospitals — update frequency varies (some monthly, some annually).',
      cmsUrl: 'https://www.cms.gov/priorities/key-initiatives/hospital-price-transparency',
      localFile: 'data/hospital_cache/<hospital_id>.sqlite',
      buildScript: 'scripts/fetch_hospital_trilliant.py',
      table: 'charges, meta',
      columnsUsed: ['code', 'description', 'gross_charge', 'discounted_cash', 'min_negotiated', 'max_negotiated', 'setting'],
    },
  ]
</script>

<svelte:head>
  <title>Data Sources — Hospital Bill Checker</title>
  <meta name="description" content="All CMS data sources used by the hospital bill checker: what they are, when they're refreshed, and how we use them." />
</svelte:head>

<div class="page">
  <div class="page-header">
    <h1>Data Sources</h1>
    <p class="subtitle">Every dataset the app uses to check your bill. All rates come directly from CMS — no third-party data is used for pricing benchmarks.</p>
  </div>

  <div class="summary-row">
    <div class="summary-card">
      <span class="summary-num">{sources.length}</span>
      <span class="summary-label">Data sources</span>
    </div>
    <div class="summary-card">
      <span class="summary-num">4</span>
      <span class="summary-label">Updated quarterly</span>
    </div>
    <div class="summary-card">
      <span class="summary-num">6</span>
      <span class="summary-label">Updated annually</span>
    </div>
    <div class="summary-card">
      <span class="summary-num">SQLite</span>
      <span class="summary-label">Local storage format</span>
    </div>
  </div>

  <div class="callout">
    <strong>All benchmarks are Medicare rates.</strong> Medicare rates are not a ceiling — hospitals can and do charge more. They are the industry-standard benchmark for evaluating whether a charge is reasonable. Private insurers, employer plans, and uninsured patients all use Medicare rates as a reference point.
  </div>

  {#each sources as source}
    <section class="source-card" id={source.id}>
      <div class="source-header">
        <h2>{source.name}</h2>
        <div class="bill-type-tags">
          {#each source.billTypes as bt}
            <span class="bill-tag">{bt}</span>
          {/each}
        </div>
      </div>

      <p class="source-desc">{source.description}</p>

      <div class="source-meta">
        <div class="meta-row">
          <span class="meta-label">Refresh cadence</span>
          <span>{source.refreshCadence}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Data staleness</span>
          <span class="staleness">{source.stalenessWarning}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">CMS source</span>
          <a href={source.cmsUrl} target="_blank" rel="noopener">{source.cmsUrl}</a>
        </div>
        <div class="meta-row">
          <span class="meta-label">Local file</span>
          <code>{source.localFile}</code>
        </div>
        <div class="meta-row">
          <span class="meta-label">Build script</span>
          <code>{source.buildScript}</code>
        </div>
        <div class="meta-row">
          <span class="meta-label">Table(s)</span>
          <code>{source.table}</code>
        </div>
        <div class="meta-row">
          <span class="meta-label">Columns used</span>
          <div class="columns-list">
            {#each source.columnsUsed as col}
              <code class="col-badge">{col}</code>
            {/each}
          </div>
        </div>
      </div>
    </section>
  {/each}

  <section class="footer-note">
    <h2>Disclaimer</h2>
    <p>This app uses Medicare fee schedules as benchmarks. Medicare rates do not apply to all patients — private insurance, Medicaid, and self-pay patients may have different contracted rates. A charge exceeding the Medicare benchmark is not automatically illegal, but it may be grounds for a billing dispute or negotiation. Always consult a healthcare billing advocate or attorney before taking formal action.</p>
    <p>Data sourced directly from CMS public files. No warranty is made as to accuracy or completeness. CMS data files sometimes contain errors or delays.</p>
  </section>
</div>

<style>
  .page {
    max-width: 900px;
    margin: 0 auto;
    padding: 32px 24px 64px;
  }

  .page-header {
    margin-bottom: 32px;
  }

  .page-header h1 {
    font-size: 2rem;
    font-weight: 700;
    margin: 0 0 8px;
  }

  .subtitle {
    color: #64748b;
    margin: 0;
    font-size: 1rem;
    max-width: 620px;
  }

  .summary-row {
    display: flex;
    gap: 16px;
    margin-bottom: 32px;
    flex-wrap: wrap;
  }

  .summary-card {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 120px;
  }

  .summary-num {
    font-size: 1.5rem;
    font-weight: 700;
    color: #1e293b;
  }

  .summary-label {
    font-size: 12px;
    color: #64748b;
  }

  .callout {
    background: #fefce8;
    border: 1px solid #fde047;
    border-radius: 8px;
    padding: 14px 18px;
    margin-bottom: 32px;
    font-size: 14px;
    line-height: 1.6;
    color: #713f12;
  }

  .source-card {
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 20px;
  }

  .source-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .source-header h2 {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 0;
  }

  .bill-type-tags {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .bill-tag {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    background: #f1f5f9;
    color: #475569;
    border: 1px solid #e2e8f0;
    white-space: nowrap;
  }

  .source-desc {
    font-size: 14px;
    color: #374151;
    margin: 0 0 16px;
    line-height: 1.6;
  }

  .source-meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: #f8fafc;
    border-radius: 8px;
    padding: 16px;
    font-size: 13px;
  }

  .meta-row {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 8px;
    align-items: baseline;
  }

  .meta-label {
    font-weight: 600;
    color: #64748b;
    flex-shrink: 0;
  }

  .staleness {
    color: #92400e;
  }

  .source-meta a {
    color: #2563eb;
    text-decoration: underline;
    word-break: break-all;
    font-size: 12px;
  }

  code {
    background: #e2e8f0;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
    color: #1e293b;
    word-break: break-all;
  }

  .columns-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .col-badge {
    background: #ede9fe;
    color: #4c1d95;
    border: 1px solid #c4b5fd;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
  }

  .footer-note {
    margin-top: 48px;
    padding-top: 32px;
    border-top: 1px solid #e2e8f0;
  }

  .footer-note h2 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 12px;
    color: #64748b;
  }

  .footer-note p {
    font-size: 13px;
    color: #64748b;
    line-height: 1.7;
    margin: 0 0 10px;
  }

  @media (max-width: 480px) {
    .page {
      padding: 20px 16px 48px;
    }

    .meta-row {
      grid-template-columns: 1fr;
      gap: 2px;
    }

    .source-header {
      flex-direction: column;
      gap: 8px;
    }

    .summary-row {
      gap: 10px;
    }

    .summary-card {
      min-width: calc(50% - 5px);
      flex: 1;
    }
  }
</style>
