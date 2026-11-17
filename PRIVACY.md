# Privacy policy: Tab Dedupe

Last updated: 17 November 2026

Tab Dedupe does not collect, store, sell or share any personal data. It has no analytics, no tracking and no
server of its own.

What it accesses, and why:

- **Tab URLs and titles** (`tabs` permission): to tell whether a page you open is already open in another tab.
  This happens entirely inside your browser; URLs are never sent anywhere.
- **Settings** (`storage`): your rules and options are saved in your browser. If you use Edge sync, Edge syncs them
  across your own devices, as it does for any extension.
- **Page titles** (optional, all-sites permission): only if you switch on the 🔁 duplicate marker, the extension
  adds 🔁 to the title of duplicate tabs. It reads and changes nothing else on the page.
- **Online rulesets** (optional): if you add a ruleset URL, the extension downloads that JSON file on a schedule.
  Only that URL is requested, and no data about you or your tabs is sent with it. The server you choose may log
  the request as any web server would.

Source code: https://github.com/MarthinusBosman/tab-dedupe

Questions: open an issue at https://github.com/MarthinusBosman/tab-dedupe/issues
