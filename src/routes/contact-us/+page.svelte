<script lang="ts">
  import FeedbackForm from '$lib/components/FeedbackForm.svelte'
</script>

<svelte:head>
  <title>Contact Us - Hospital Bill Checker</title>
  <meta name="description" content="Report a missed code, billing issue, or incorrect result from Hospital Bill Checker." />
</svelte:head>

<main class="container contact-page">
  <a href="/" class="back-link">← Back to Hospital Bill Checker</a>

  <section class="hero card">
    <p class="eyebrow">Contact</p>
    <h1>Notice something wrong?</h1>
    <p class="intro">
      Use this page to report a missed billing code, an incorrect flag, or a hospital bill detail that deserves another look.
    </p>
    <div class="hero-points">
      <span>Billing and coding review</span>
      <span>Insurance-aware context</span>
      <span>Healthcare-specific language</span>
    </div>
  </section>

  <section class="form-wrap">
    <FeedbackForm mode="form" />
  </section>

  <section class="secondary card">
    <h2>What to include</h2>
    <ul>
      <li>The code or charge that looks off</li>
      <li>What the bill says versus what you expected</li>
      <li>Any related insurance or coverage detail</li>
    </ul>
    <p>
      We use this to improve the billing checks and catch more hospital and insurance issues accurately.
    </p>
  </section>
</main>

<style>
  .contact-page {
    padding-top: 48px;
    padding-bottom: 80px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .back-link {
    display: inline-block;
    font-size: 14px;
    color: var(--text-muted);
    text-decoration: none;
    margin-bottom: 4px;
  }

  .hero {
    padding: 28px;
    border-radius: var(--radius-lg);
    background: var(--bg-card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-sm);
  }

  .eyebrow {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent);
    margin: 0 0 10px;
    display: block;
  }

  h1 {
    font-family: var(--font-display);
    margin: 0;
    font-size: 30px;
    line-height: 1.1;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }

  .intro {
    margin: 12px 0 0;
    font-size: 15px;
    line-height: 1.7;
    color: var(--text-muted);
    max-width: 56ch;
  }

  .hero-points {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }

  .hero-points span {
    padding: 5px 10px;
    border-radius: var(--radius);
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .form-wrap {
    max-width: 680px;
  }

  .secondary {
    padding: 24px 28px;
    border-radius: var(--radius-lg);
    background: var(--bg-card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-sm);
  }

  .secondary h2 {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin: 0 0 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  .secondary ul {
    margin: 0 0 12px;
    padding-left: 20px;
    line-height: 1.8;
    color: var(--text-secondary);
    font-size: 14px;
  }

  .secondary p {
    margin: 0;
    color: var(--text-muted);
    line-height: 1.6;
    font-size: 14px;
  }

  @media (max-width: 640px) {
    .hero,
    .secondary {
      padding: 20px;
    }

    h1 {
      font-size: 24px;
    }
  }
</style>
