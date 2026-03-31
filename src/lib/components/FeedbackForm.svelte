<script lang="ts">
  const FORMSPREE_ID = 'mvzvkepd'

  let { mode = 'cta', showRating = true } = $props<{
    mode?: 'cta' | 'form'
    showRating?: boolean
  }>()

  let rating = $state(0)
  let hovered = $state(0)
  let email = $state('')
  let message = $state('')
  let status = $state<'idle' | 'sending' | 'success' | 'error'>('idle')
  const showForm = $derived(mode === 'form')

  async function submit(e: Event) {
    e.preventDefault()
    if (!message.trim()) return
    status = 'sending'
    try {
      const res = await fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: rating || undefined, email: email || undefined, message })
      })
      status = res.ok ? 'success' : 'error'
    } catch {
      status = 'error'
    }
  }
</script>

{#if showForm}
  <div class="feedback-card">
    {#if status === 'success'}
      <div class="success-state">
        <span class="success-icon">✓</span>
        <p class="success-text">Thanks for the feedback!</p>
        <p class="success-sub">It helps us make this tool better for everyone.</p>
      </div>
    {:else}
      <div class="card-header">
        <span class="card-accent-line"></span>
        <div>
          <h3 class="feedback-heading">Notice something wrong?</h3>
          <p class="feedback-subtext">Send details about a billing issue, a missed code, or an incorrect result.</p>
        </div>
      </div>

      <form onsubmit={submit} class="feedback-form">
        {#if showRating}
          <div class="field">
            <div class="field-label" id="feedback-rating-label">How clear was the result? <span class="optional">(optional)</span></div>
            <div
              class="stars"
              onmouseleave={() => hovered = 0}
              role="group"
              aria-labelledby="feedback-rating-label"
            >
              {#each [1, 2, 3, 4, 5] as star}
                <button
                  type="button"
                  class="star-btn"
                  class:filled={star <= (hovered || rating)}
                  aria-label="Rate {star} star{star !== 1 ? 's' : ''}"
                  onmouseenter={() => hovered = star}
                  onclick={() => rating = rating === star ? 0 : star}
                >
                  {star <= (hovered || rating) ? '★' : '☆'}
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="field">
          <label for="feedback-email" class="field-label">Email <span class="optional">(optional)</span></label>
          <input
            id="feedback-email"
            type="email"
            class="field-input"
            placeholder="you@example.com"
            bind:value={email}
            autocomplete="email"
          />
        </div>

        <div class="field">
          <label for="feedback-message" class="field-label">What should we look at? <span class="required">*</span></label>
          <textarea
            id="feedback-message"
            class="field-input field-textarea"
            placeholder="Tell us what looks off, what code was missed, or what should be investigated."
            bind:value={message}
            rows="5"
            required
          ></textarea>
        </div>

        {#if status === 'error'}
          <p class="feedback-error">Something went wrong. Please try again.</p>
        {/if}

        <button
          type="submit"
          class="btn btn-primary feedback-submit"
          disabled={status === 'sending' || !message.trim()}
        >
          {status === 'sending' ? 'Sending…' : 'Send report'}
        </button>
      </form>
    {/if}
  </div>
{:else}
  <div class="cta-plain">
    <h3>Notice something wrong?</h3>
    <p>
      <a href="/contact-us">Click here</a> to report a missed code, billing inconsistency, or anything that should be reviewed.
    </p>
  </div>
{/if}

<style>
  .cta-plain h3 {
    font-family: var(--font-sans);
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 4px;
    color: var(--text-primary);
  }

  .cta-plain p {
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: var(--text-muted);
  }

  .cta-plain a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .feedback-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 28px;
    max-width: 520px;
    margin: 0 auto;
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 24px;
  }

  .card-accent-line {
    display: block;
    flex-shrink: 0;
    width: 3px;
    height: 38px;
    background: var(--accent);
    border-radius: 2px;
    margin-top: 3px;
  }

  .feedback-heading {
    font-family: var(--font-sans);
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 3px;
    line-height: 1.2;
  }

  .feedback-subtext {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
  }

  .feedback-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.01em;
  }

  .optional {
    font-weight: 400;
    color: var(--text-ghost);
  }

  .required {
    color: var(--error);
  }

  .field-input {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text-primary);
    font-family: var(--font-sans);
    transition: border-color 0.15s, box-shadow 0.15s;
    width: 100%;
    box-sizing: border-box;
  }

  .field-input:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: 0 0 0 3px rgba(45, 106, 79, 0.12);
  }

  .field-input::placeholder {
    color: var(--text-ghost);
  }

  .field-textarea {
    resize: vertical;
    min-height: 96px;
  }

  .stars {
    display: flex;
    gap: 4px;
  }

  .star-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: 24px;
    color: var(--border-strong);
    line-height: 1;
    transition: color 0.1s, transform 0.1s;
  }

  .star-btn:hover,
  .star-btn.filled {
    color: var(--accent);
  }

  .star-btn:hover {
    transform: scale(1.12);
  }

  .feedback-submit {
    width: 100%;
    margin-top: 4px;
  }

  .feedback-error {
    color: var(--error);
    font-size: 13px;
    margin: 0;
  }

  /* Success state */
  .success-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 16px 0 8px;
    text-align: center;
    gap: 6px;
  }

  .success-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    background: var(--success-bg);
    border: 1px solid var(--success-border);
    color: var(--success);
    border-radius: 50%;
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .success-text {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    font-family: var(--font-sans);
  }

  .success-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
  }
</style>
