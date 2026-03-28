<script lang="ts">
  // No script needed — static page
</script>

<svelte:head>
  <title>Privacy Policy — Hospital Bill Checker</title>
  <meta name="description" content="What Hospital Bill Checker does and doesn't collect about you." />
</svelte:head>

<main class="privacy-page">
  <div class="privacy-container">
    <a class="back-link" href="/">← Back</a>

    <h1>Privacy Policy</h1>
    <p class="last-updated">Last updated: March 2026</p>

    <p>
      Hospital Bill Checker is built around a simple principle: your medical bill is none of our business.
      Here's exactly what happens when you use this tool.
    </p>

    <h2>What we collect</h2>
    <p>
      Nothing. We do not create accounts, set cookies, run analytics, or store anything about you or your bill.
      There is no database of users, no log of bills submitted, and no session data retained after your browser tab closes.
    </p>

    <h2>What happens to your bill</h2>
    <p>
      When you submit a bill, the line item codes and amounts are held in memory for the duration of the analysis
      and then discarded. We never write your bill to disk or a database on our end. Once the results load,
      the server has no record that the request happened.
    </p>
    <p>
      We deliberately strip patient name, date of birth, and medical record number before anything leaves your browser.
      Those fields are used only to pre-fill the dispute letter on your screen.
    </p>

    <h2>The Anthropic API</h2>
    <p>
      The analysis is powered by Claude, Anthropic's AI. Bill codes and dollar amounts are sent to the
      <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer">Anthropic API</a>.
      Under Anthropic's standard terms, API inputs may be retained for up to 30 days for trust and safety review.
      We do not send patient name, date of birth, or medical record number to the API.
    </p>
    <p>
      If that retention window concerns you, you can review
      <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer">Anthropic's privacy policy</a>
      directly.
    </p>

    <h2>The savings counter</h2>
    <p>
      The one thing we do record: if you click "Share your savings," we increment an anonymous running total
      by the dollar amount you found. No user identity, IP address, or bill data is attached to that number.
      It is purely an aggregate counter — a single integer that goes up.
    </p>

    <h2>Cookies and analytics</h2>
    <p>
      None. No cookies are set. No analytics scripts are loaded. No third-party trackers of any kind.
    </p>

    <h2>Questions or concerns</h2>
    <p>
      This project is open source. If you have questions about how it works or want to audit the code yourself,
      open an issue on the
      <a href="https://github.com/anthropics/hospital-bill-checker/issues" target="_blank" rel="noopener noreferrer">GitHub repository</a>.
    </p>
  </div>
</main>

<style>
  .privacy-page {
    min-height: 100vh;
    background: var(--bg);
    padding: 40px 16px 80px;
  }

  .privacy-container {
    max-width: 640px;
    margin: 0 auto;
  }

  .back-link {
    display: inline-block;
    font-size: 14px;
    color: var(--text-muted);
    text-decoration: none;
    margin-bottom: 32px;
  }

  .back-link:hover {
    color: var(--text-primary);
  }

  h1 {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .last-updated {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 32px;
  }

  h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 28px 0 8px;
  }

  p {
    font-size: 15px;
    color: var(--text-primary);
    line-height: 1.7;
    margin: 0 0 12px;
  }

  a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  a:hover {
    opacity: 0.8;
  }
</style>
