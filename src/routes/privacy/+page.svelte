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

    <h2>The Google Gemini API</h2>
    <p>
      The analysis is powered by Google Gemini. Bill codes and dollar amounts are sent to the Gemini API for processing.
      We do not send patient name, date of birth, or medical record number to the API.
      For details on how Google handles API data, see
      <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google's privacy policy</a>.
    </p>

    <h2>The savings counter</h2>
    <p>
      When an audit completes, we automatically increment an anonymous running total by the potential overcharge amount found. No user identity, IP address, or bill data is attached to that number. It is a single aggregate counter — nothing more.
    </p>

    <h2>Live user counter</h2>
    <p>
      To show how many people are currently using the tool, we track an anonymous session identifier
      in your browser's sessionStorage (not localStorage — it is cleared when you close the tab).
      This identifier is sent to our server as a heartbeat every 60 seconds and expires after 5 minutes
      of inactivity. It is a random UUID with no connection to you, your bill, or any other data.
    </p>

    <h2>Cookies and analytics</h2>
    <p>
      None. No cookies are set. No analytics scripts are loaded. No third-party trackers of any kind.
    </p>

    <h2>Questions or concerns</h2>
    <p>
      This project is open source. If you have questions about how it works or want to audit the code yourself,
      open an issue on the
      <a href="https://github.com" target="_blank" rel="noopener noreferrer">GitHub repository</a>.
    </p>
  </div>
</main>

<style>
  .privacy-page {
    min-height: 100vh;
    background: var(--bg);
    padding: 40px 24px 80px;
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
    margin-bottom: 36px;
  }

  .back-link:hover {
    color: var(--text-primary);
  }

  h1 {
    font-family: var(--font-display);
    font-size: 36px;
    font-weight: 400;
    color: var(--text-primary);
    margin: 0 0 4px;
    letter-spacing: -0.01em;
  }

  .last-updated {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-ghost);
    margin: 0 0 40px;
    letter-spacing: 0.02em;
  }

  h2 {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-primary);
    margin: 36px 0 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  p {
    font-size: 15px;
    color: var(--text-secondary);
    line-height: 1.75;
    margin: 0 0 14px;
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
