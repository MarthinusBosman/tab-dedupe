# Tab Dedupe

An Edge extension: opening a page that's already open switches to the existing tab instead. Rules decide how
granular "the same page" is.

## Install

From Microsoft Edge Add-ons (link once the listing is live), or from source:

1. Open `edge://extensions` and turn on **Developer mode** (bottom left).
2. **Load unpacked** and pick this folder.

Edge shows "Turn off developer mode extensions?" at every start-up for unpacked extensions; pick **Cancel** to keep
it. The store version doesn't get this prompt.

## What it does

- A new tab whose page is already open (a link opened in a new tab, a URL typed into a new tab, a link from Teams or
  Outlook) is closed, and the existing tab is focused. Navigating inside a tab is never touched.
- Link wrappers (redirect pages such as Microsoft Safe Links in Teams and Outlook) are unwrapped to the real URL
  first. They are data, not code: the defaults live in `rulesets/default_wrappers.json`, and anyone can add more.
- New tabs are followed through redirects for a few seconds (switchable), so links that arrive via a redirect
  without a link wrapper are caught too.
- Default "same page": same URL ignoring `#fragment`, trailing slash and http/https. The query string still counts.
- Rules (settings page) group more pages together, e.g. one Azure DevOps PR tab regardless of PR number.
  Per rule, when a match is open: **switch to it and open the new URL there** (default) or **just switch to it**.
- Ctrl+click (or "Duplicate tab") when the only matching tab is the one you're in: by default the new tab opens
  anyway, so your current tab is never replaced. Configurable.
- **Close duplicates now** (popup and settings) closes all but the most recently used tab in each group.
- Optional 🔁 prefix on duplicate tab titles (asks for the all-sites permission when switched on).
- Pinned tabs (configurable): by default, opening a pinned page switches to the pinned tab without changing it.
  "Treat like any other tab" lets rules redirect pinned tabs; "Ignore" leaves them out. Pinned tabs are never closed.
- Tab groups (configurable): by default a match in the same group is preferred, and one in another group is only
  switched to, never changed; "Close duplicates now" keeps one tab per group. "Separate duplicates by group"
  deduplicates each group on its own; "Ignore groups" disregards them.
- InPrivate tabs are ignored. Tabs restored when Edge starts are not deduplicated.

## Rule patterns

Matched against `host/path` (scheme optional):

| Token    | Meaning                                       |
|----------|-----------------------------------------------|
| `*`      | ignore this part (one path segment)           |
| `**`     | ignore anything, across slashes               |
| `{name}` | one tab per distinct value of this part       |

Anything after the pattern (more path, query, fragment) is ignored. If the pattern contains `?`, the query is
matched too, e.g. `example.com/view?id={id}`.

- `dev.azure.com/*/*/_git/*/pullrequest/*`: one PR tab in total
- `dev.azure.com/*/*/_git/{repo}/pullrequest/*`: one PR tab per repo

A rule can have several patterns, one per line, to treat different URLs as the same page. Variables are matched by
name, so the same `{org}` can sit in the domain on one line and in the path on another:

```
dev.azure.com/{org}/{project}/_git/*/pullrequest/*
{org}.visualstudio.com/{project}/_git/*/pullrequest/*
```

**Aggressive mode** (settings, off by default) adds a catch-all "one tab per site" rule after all other rules, so
custom rules still win. A page on a site you already have open replaces that tab's page; list sites that should keep
several tabs as exceptions.

**Export / Import** (under the rules) saves your rules to a JSON file in the online-ruleset format, so an export
can also be hosted and subscribed to. Import adds rules and skips ones you already have.

The settings page has a "Test a URL" box that shows which rule matches.

## Online rulesets

Every install subscribes to the two default rulesets in this repo (copies ship with the extension, so they work
before the first download): `rulesets/default_ruleset.json` (rules) and `rulesets/default_wrappers.json` (link
wrappers). Every entry can be switched off individually in settings, and either ruleset can be removed. Add more
by URL in settings.
Rulesets are welcome as pull requests under `rulesets/`.

A ruleset is refreshed every 24 hours (configurable), or with **Refresh now**.
If a download fails, the last good copy is kept. Your own rules are checked first, and any online rule can be
switched off individually.

```json
{
  "name": "Azure DevOps",
  "rules": [
    { "name": "One PR tab", "patterns": ["dev.azure.com/*/*/_git/*/pullrequest/*", "*.visualstudio.com/*/_git/*/pullrequest/*"], "onMatch": "navigate" },
    { "name": "One board tab", "pattern": "dev.azure.com/*/*/_boards/board/**", "onMatch": "switch" }
  ]
}
```

Use `pattern` for one pattern or `patterns` for several. `onMatch`: `navigate` (default) or `switch`.

Link wrappers go in an `unwrap` list: a pattern for the redirect page and the query parameter holding the real link.

```json
{
  "name": "Default link wrappers",
  "unwrap": [
    { "name": "Microsoft Safe Links (Teams)", "pattern": "**/safelinks/*/atp-safelinks.html", "param": "url" },
    { "name": "Microsoft Safe Links (Outlook)", "pattern": "*.safelinks.protection.outlook.com", "param": "url" }
  ]
}
``` Hosts without open CORS headers (GitHub raw and gists are fine)
need host permission, which the settings page asks for when you add the URL.

## Development

No dependencies; needs Node 22+ and Edge.

```
npm test         # matching logic (node:test)
npm run e2e      # real headless Edge with the extension loaded, throwaway profile
npm run build    # dist/tab-dedupe-<version>.zip for the store
```

## Releasing

1. Bump `version` in `manifest.json`, commit, then `git tag v<version> && git push --tags`.
2. The Release workflow tests, builds the zip, attaches it to a GitHub release, and submits it to Edge Add-ons.

Store publishing needs, once: the first version submitted by hand in Partner Center (see `STORE.md`), the repo
variable `EDGE_PRODUCT_ID`, and `EDGE_CLIENT_ID` / `EDGE_API_KEY` secrets in the `edge-add-ons` environment (Partner
Center → Microsoft Edge → Publish API). The API key expires every 72 days.

## License

MIT
