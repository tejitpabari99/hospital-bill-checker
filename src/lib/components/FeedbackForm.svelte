<script lang="ts">
  const FORMSPREE_ID = 'mvzvkepd'

  let { showRating = true } = $props<{ showRating?: boolean }>()

  let rating = $state(0)
  let hovered = $state(0)
  let email = $state('')
  let message = $state('')
  let status = $state<'idle' | 'sending' | 'success' | 'error'>('idle')

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
        <h3 class="feedback-heading">How was your experience?</h3>
        <p class="feedback-subtext">Takes 30 seconds. Helps us improve.</p>
      </div>
    </div>

    <form onsubmit={submit} class="feedback-form">
      {#if showRating}
        <!-- Star rating -->
        <div class="field">
          <div class="field-label" id="feedback-rating-label">Rating <span class="optional">(optional)</span></div>
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

      <!-- Email -->
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

      <!-- Message -->
      <div class="field">
        <label for="feedback-message" class="field-label">Your feedback <span class="required">*</span></label>
        <textarea
          id="feedback-message"
          class="field-input field-textarea"
          placeholder="What worked well? What could be better?"
          bind:value={message}
          rows="4"
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
        {status === 'sending' ? 'Sending…' : 'Send Feedback'}
      </button>
    </form>
  {/if}
</div>

<style>
  .feedback-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px 28px 24px;
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
    width: 4px;
    height: 40px;
    background: var(--accent);
    border-radius: 4px;
    margin-top: 2px;
  }

  .feedback-heading {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
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
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .optional {
    font-weight: 400;
    color: var(--text-muted);
  }

  .required {
    color: var(--accent);
  }

  .field-input {
    background: var(--bg-main, var(--bg-card));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text-primary);
    font-family: inherit;
    transition: border-color 0.15s, box-shadow 0.15s;
    width: 100%;
    box-sizing: border-box;
  }

  .field-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .field-input::placeholder {
    color: var(--text-muted);
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
    font-size: 26px;
    color: var(--border);
    line-height: 1;
    transition: color 0.1s, transform 0.1s;
  }

  .star-btn:hover,
  .star-btn.filled {
    color: var(--accent);
  }

  .star-btn:hover {
    transform: scale(1.15);
  }

  .feedback-submit {
    width: 100%;
    margin-top: 4px;
  }

  .feedback-error {
    color: var(--error, #dc2626);
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
    width: 48px;
    height: 48px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    border-radius: 50%;
    font-size: 22px;
    font-weight: 700;
    margin-bottom: 8px;
  }

  .success-text {
    font-size: 17px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .success-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
  }
</style>
