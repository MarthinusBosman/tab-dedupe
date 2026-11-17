# Edge Add-ons submission (Partner Center)

Copy-paste text for the first, manual submission. Later versions go through `.github/workflows/release.yml`.

## Package

`npm run build` → upload `dist/tab-dedupe-<version>.zip`.

## Availability

- Visibility: Public
- Markets: all

## Properties

- Category: Productivity
- Website: https://github.com/MarthinusBosman/tab-dedupe
- Support contact: https://github.com/MarthinusBosman/tab-dedupe/issues
- Mature content: no

## Privacy

**Single purpose**

Prevents duplicate tabs: when you open a page that is already open, it switches to the existing tab instead of
opening a new one, using URL rules you control.

**Permission justification**

- `tabs`: Needed to read the URLs of open tabs, to detect whether a newly opened page is already open and to switch
  to, update or close tabs. URLs are processed locally and never transmitted.
- `storage`: Saves the user's rules and settings, and the last downloaded copy of any online ruleset.
- `webNavigation`: Follows a newly opened tab through redirects (sign-in pages, link scanners) so a link that lands on an already-open page is still recognised. Only redirects of a just-opened
  tab are looked at; nothing is stored or transmitted.
- `alarms`: Refreshes user-added online rulesets on a schedule (default every 24 hours).
- `scripting`: Only used when the user turns on the optional duplicate marker, to add "🔁" to the title of
  duplicate tabs. Nothing else on the page is read or changed.
- Optional host permission `<all_urls>`: Requested at runtime only when the user enables the duplicate marker
  (needed to set tab titles) or adds an online ruleset hosted on a server without open CORS headers. Not granted
  at install.

**Remote code**: No, I am not using remote code. (Online rulesets and link wrappers are JSON data containing URL
patterns; they are validated and never executed.)

**Data usage**: collects none of the listed data types. Tick all three certifications.

**Privacy policy URL**: https://github.com/MarthinusBosman/tab-dedupe/blob/main/PRIVACY.md

## Store listing (English)

- Logo: `store/logo300.png`
- Short description: comes from the manifest.

**Description**

Too many duplicate tabs? Tab Dedupe switches to the tab you already have open instead of opening the same page
again.

When a new tab opens a page that's already open, whether from a link, a URL you typed into a new tab, or a link
from another app, Tab Dedupe closes the new tab and brings you to the existing one. Navigating inside a tab is
never interrupted.

Decide what "the same page" means with simple URL rules:
- By default, pages match when the URL is the same, ignoring #fragments and trailing slashes.
- Add rules with * to ignore part of a URL and {name} for one tab per value. For example,
  dev.azure.com/*/*/_git/*/pullrequest/* keeps a single Azure DevOps pull-request tab, and
  dev.azure.com/*/*/_git/{repo}/pullrequest/* keeps one per repository.
- For each rule, choose whether the existing tab switches to the newly opened URL or just comes to the front.
- Give a rule several URL patterns to treat different addresses as the same page, e.g. dev.azure.com and
  visualstudio.com links to the same pull request.
- Subscribe to online rulesets (JSON files, for example on GitHub) that refresh automatically, and export/import
  your own rules.
- Optional aggressive mode: one tab per site, with exceptions.

Also included:
- "Close duplicates now" closes all but the most recently used tab in each group.
- An optional 🔁 marker in the title of duplicate tabs.
- Ctrl+click from a matching tab still opens a new tab (configurable).
- A pause switch, and a toolbar badge showing how many duplicates are open.
- Choose how pinned tabs and tab groups are handled, e.g. keep duplicates separate per tab group.

Pinned tabs are never closed and InPrivate tabs are never touched. No tracking, no data collection; open source under the MIT licence.

**Search terms**: duplicate tabs, tab manager, dedupe, close duplicate tabs, Azure DevOps, productivity

## Certification notes

To test: open any page, then open the same URL in a new tab; the new tab closes and the first one is focused.
Settings page → "Test a URL" shows which rule matches. Online rulesets are plain JSON (example:
https://raw.githubusercontent.com/MarthinusBosman/tab-dedupe/main/rulesets/default_ruleset.json); nothing is executed.
