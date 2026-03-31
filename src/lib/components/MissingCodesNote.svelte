<script lang="ts">
  let {
    id = 'missing-codes',
    class: className = '',
  } = $props<{ id?: string; class?: string }>()
</script>

<section {id} class={`missing-codes-note ${className}`.trim()}>
  <div class="header">
    <span class="eyebrow">Missing codes</span>
    <h3>Why some codes are not shown</h3>
  </div>

  <p>
    We only surface standard CPT and HCPCS billing codes. Hospitals also use revenue codes and
    internal facility codes, but those are not used for the core pricing checks here.
  </p>

  <p>
    If your bill includes those fields, that is normal. The audit focuses on codes that can be
    compared against Medicare rules, coding edits, and common billing patterns.
  </p>
</section>

<style>
  .missing-codes-note {
    padding: 16px 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-subtle);
    box-shadow: none;
  }

  .header {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 10px;
  }

  .eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }

  h3 {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  p {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.65;
  }

  p + p {
    margin-top: 6px;
  }
</style>
