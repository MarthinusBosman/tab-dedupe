// Pure tab-matching logic. No chrome.* calls here so it can be unit-tested in Node.

const WEB = /^https?:$/;

function parse(url) {
  try {
    const u = new URL(url);
    return WEB.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

function hostPath(u) {
  return (u.host + u.pathname).replace(/\/+$/, "");
}

/** Default identity of a page: host + path + query, ignoring scheme, #fragment and trailing slash. */
export function normalizeUrl(url) {
  const u = parse(url);
  return u ? hostPath(u) + u.search : null;
}

/**
 * Link wrappers are entries with kind "unwrap": {pattern, param}. A URL matching the pattern is a redirect page
 * (e.g. a link scanner) whose real destination is in query parameter `param`. Returns {url, by}: the real URL and
 * the wrapper that unwrapped it, or the URL unchanged and by = null. Nested wrappers are unwrapped up to 3 deep.
 */
export function unwrapUrl(url, entries = []) {
  const wrappers = entries.filter((w) => w.kind === "unwrap" && w.enabled !== false && w.param);
  let by = null;
  for (let depth = 0; depth < 3; depth++) {
    const u = parse(url);
    if (!u) break;
    const w = wrappers.find((x) => rulePatterns(x).some((p) => compiledFor(p).match(url)));
    const inner = w && u.searchParams.get(w.param);
    if (!inner || !parse(inner)) break;
    url = inner;
    by = w;
  }
  return { url, by };
}

const escape = (s) => s.replace(/[.+^$()|[\]\\?]/g, "\\$&");

/**
 * Compile a rule pattern.
 *   *       ignore one URL part (path segment or query value)
 *   **      ignore anything (across slashes)
 *   {name}  one tab per distinct value of this part. Variables are matched by name, so several patterns in one rule
 *           can put the same {name} in different places (e.g. in the domain on one line, the path on another).
 * Anything after the pattern (more path, query, #fragment) is ignored, unless the pattern itself contains "?",
 * in which case the query is matched too. match() returns {name: value} (empty object without variables) or null.
 */
export function compilePattern(pattern) {
  const p = String(pattern).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  const usesQuery = p.includes("?");
  const names = [];
  let body = "";
  for (let i = 0; i < p.length; ) {
    if (p.startsWith("**", i)) { body += ".*"; i += 2; continue; }
    if (p[i] === "*") { body += "[^/?&#]+"; i += 1; continue; }
    if (p[i] === "{") {
      const end = p.indexOf("}", i);
      if (end > i) { names.push(p.slice(i + 1, end).trim()); body += "([^/?&#]+)"; i = end + 1; continue; }
    }
    body += escape(p[i]);
    i += 1;
  }
  const regex = new RegExp(`^${body}(?:[/&].*)?$`, "i");
  return {
    names,
    match(url) {
      const u = parse(url);
      if (!u) return null;
      const m = regex.exec(hostPath(u) + (usesQuery ? u.search : ""));
      if (!m) return null;
      const vars = {};
      names.forEach((n, i) => (vars[n] = m[i + 1]));
      return vars;
    },
  };
}

const compiled = new Map();
function compiledFor(pattern) {
  let c = compiled.get(pattern);
  if (!c) {
    c = compilePattern(pattern);
    compiled.set(pattern, c);
  }
  return c;
}

const decode = (v) => {
  try { return decodeURIComponent(v); } catch { return v; }
};

/** A rule's patterns: `patterns` array (rulesets) or `pattern` with one pattern per line. */
export function rulePatterns(rule) {
  const list = Array.isArray(rule.patterns) ? rule.patterns : String(rule.pattern ?? "").split("\n");
  return list.map((p) => String(p).trim()).filter(Boolean);
}

/** A warning when a rule's lines use different variables (then pages on different lines never match). */
export function patternWarning(rule) {
  const sets = [...new Set(rulePatterns(rule).map((p) => [...new Set(compiledFor(p).names)].sort().join(",")))];
  if (sets.length < 2) return null;
  const all = [...new Set(sets.flatMap((s) => s.split(",")).filter(Boolean))].map((n) => `{${n}}`).join(", ");
  return `Every line should use the same variables (${all}); otherwise pages on different lines never count as the same.`;
}

const hostExcluded = (url, hosts) => {
  const h = parse(url)?.hostname.toLowerCase();
  return !!h && hosts.some((x) => h === x || h.endsWith(`.${x}`));
};

/**
 * Group key for a URL: link wrappers are unwrapped first, then the first enabled matching rule decides, else the
 * normalized URL. `rules` may mix rules and link-wrapper entries (kind "unwrap").
 */
export function keyFor(url, rules) {
  const unwrapped = unwrapUrl(url, rules);
  url = unwrapped.url;
  const extra = unwrapped.by ? { unwrappedBy: unwrapped.by, realUrl: url } : {};
  for (const rule of rules) {
    if (rule.enabled === false || rule.kind === "unwrap") continue;
    if (rule.excludeHosts?.length && hostExcluded(url, rule.excludeHosts)) continue;
    for (const p of rulePatterns(rule)) {
      const m = compiledFor(p).match(url);
      if (!m) continue;
      const vars = Object.keys(m).sort().map((n) => `${n}=${decode(m[n]).toLowerCase()}`).join("|");
      return { key: `rule:${rule.id}:${vars}`, rule, vars: m, ...extra };
    }
  }
  const n = normalizeUrl(url);
  return n === null ? null : { key: `url:${n}`, rule: null, ...extra };
}

export const AGGRESSIVE_ID = "builtin-aggressive";
/** Aggressive mode: a catch-all rule, checked after all others, giving one tab per hostname. */
export function aggressiveRule(excludeHosts = []) {
  return {
    id: AGGRESSIVE_ID, name: "Aggressive: one tab per site", pattern: "{site}", onMatch: "navigate", enabled: true,
    excludeHosts: excludeHosts.map((h) => h.trim().toLowerCase().replace(/^\*\./, "")).filter(Boolean),
  };
}

export const tabUrl = (t) => t.pendingUrl || t.url || "";
const isWeb = (t) => !t.incognito && parse(tabUrl(t)) !== null;
const groupOf = (t) => (t.groupId == null ? -1 : t.groupId); // -1 = not in a group (chrome.tabGroups.TAB_GROUP_ID_NONE)
const byRecent = (a, b) =>
  (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) || (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.id - a.id;

/**
 * settings.pinned: "switch" (default) switch to a pinned match but never change or close it,
 *                  "redirect" treat pinned tabs like any other (still never closed), "ignore" leave pinned tabs out.
 * settings.groups: "preferSame" (default) prefer a match in the same tab group; one in another group is only
 *                  switched to, never changed, "separate" only tabs in the same group count, "ignore" groups don't matter.
 */
const modes = (settings = {}) => ({ pinned: settings.pinned || "switch", groups: settings.groups || "preferSame" });
const counts = (t, m) => isWeb(t) && !(t.pinned && m.pinned === "ignore");

/**
 * What to do with a freshly opened tab.
 * Returns {action: "none"} | {action: "keep"} (duplicate allowed, e.g. ctrl+click from the matching tab)
 *       | {action: "switch", targetId} | {action: "navigate", targetId, url}
 */
export function decideNewTab(newTab, tabs, rules, settings) {
  const m = modes(settings);
  if (settings.paused || newTab.pinned || !isWeb(newTab)) return { action: "none" };
  const url = tabUrl(newTab);
  const k = keyFor(url, rules);
  if (!k) return { action: "none" };
  const g = groupOf(newTab);
  const rank = (t) => (m.groups === "preferSame" && groupOf(t) !== g ? 2 : 0) + (t.pinned && m.pinned === "switch" ? 1 : 0);
  const matches = tabs
    .filter((t) => t.id !== newTab.id && counts(t, m) && keyFor(tabUrl(t), rules)?.key === k.key)
    .filter((t) => m.groups !== "separate" || groupOf(t) === g)
    .sort((a, b) => rank(a) - rank(b) || byRecent(a, b));
  if (!matches.length) return { action: "none" };
  // Opened from a tab that is itself a match (Ctrl+click, "Duplicate tab", or a link from another app while you're
  // on that tab): open it next to the one you're on, and never send it to some other matching tab instead.
  if (settings.openerSelf !== "applyRule" && newTab.openerTabId != null && matches.some((t) => t.id === newTab.openerTabId)) {
    return { action: "keep" };
  }
  const target = matches[0];
  const mayChange = !(target.pinned && m.pinned !== "redirect") && !(m.groups === "preferSame" && groupOf(target) !== g);
  const real = (x) => normalizeUrl(unwrapUrl(x, rules).url);
  if (mayChange && k.rule?.onMatch !== "switch" && real(tabUrl(target)) !== real(url)) {
    return { action: "navigate", targetId: target.id, url };
  }
  return { action: "switch", targetId: target.id };
}

/**
 * Duplicates across open tabs: which tabs are duplicates and which to close. Pinned tabs are never closed; with
 * groups "preferSame" one tab per group is kept; otherwise the most recently used tab is kept.
 */
export function planDuplicates(tabs, rules, settings) {
  const m = modes(settings);
  const buckets = new Map();
  for (const t of tabs) {
    if (!counts(t, m)) continue;
    const k = keyFor(tabUrl(t), rules);
    if (!k) continue;
    const key = m.groups === "separate" ? `${k.key}|${groupOf(t)}` : k.key;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const closeIds = [];
  const duplicateIds = new Set();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort(byRecent);
    const keep = new Set(bucket.filter((t) => t.pinned));
    if (m.groups === "preferSame") {
      const seen = new Set();
      for (const t of bucket) {
        const g = groupOf(t);
        if (g !== -1 && !seen.has(g) && !t.pinned) { seen.add(g); keep.add(t); }
      }
    }
    if (!keep.size) keep.add(bucket[0]);
    const close = bucket.filter((t) => !keep.has(t));
    if (!close.length) continue;
    bucket.forEach((t) => duplicateIds.add(t.id));
    closeIds.push(...close.map((t) => t.id));
  }
  return { closeIds, duplicateIds };
}

/** One rule from a ruleset/export file, normalised; null if unusable. Patterns end up newline-joined in `pattern`. */
function readEntry(r, kind) {
  if (!r || typeof r !== "object") return null;
  const raw = Array.isArray(r.patterns) ? r.patterns : typeof r.pattern === "string" ? [r.pattern] : [];
  const patterns = rulePatterns({ patterns: raw.filter((p) => typeof p === "string") });
  if (!patterns.length) return null;
  try { patterns.forEach((p) => compilePattern(p)); } catch { return null; }
  const base = {
    name: typeof r.name === "string" ? r.name : patterns[0],
    pattern: patterns.join("\n"),
    enabled: r.enabled !== false,
    id: typeof r.id === "string" ? r.id : null,
  };
  if (kind === "unwrap") {
    if (typeof r.param !== "string" || !r.param.trim()) return null;
    return { ...base, kind, param: r.param.trim() };
  }
  return { ...base, onMatch: r.onMatch === "switch" ? "switch" : "navigate" };
}

/** {rules, wrappers} from a ruleset/export file: {name?, rules?: [...], unwrap?: [...]}. */
function entriesOf(json) {
  if (!json || typeof json !== "object" || (!Array.isArray(json.rules) && !Array.isArray(json.unwrap))) {
    throw new Error('Not a ruleset: expected {"rules": [...]} and/or {"unwrap": [...]}');
  }
  return {
    rules: (Array.isArray(json.rules) ? json.rules : []).map((r) => readEntry(r, "rule")).filter(Boolean),
    wrappers: (Array.isArray(json.unwrap) ? json.unwrap : []).map((r) => readEntry(r, "unwrap")).filter(Boolean),
  };
}

/**
 * Validate a downloaded ruleset: {name?, rules?: [{pattern | patterns, name?, onMatch?, id?}],
 * unwrap?: [{pattern | patterns, param, name?, id?}]}. Returns one list: rules, then link wrappers (kind "unwrap").
 */
export function validateRuleset(json, url) {
  const { rules, wrappers } = entriesOf(json);
  const sig = (r) => r.id ?? rulePatterns(r).join("|");
  return {
    name: typeof json.name === "string" ? json.name : url,
    rules: [
      ...rules.map((r) => ({ id: `${url}#${sig(r)}`, name: r.name, pattern: r.pattern, onMatch: r.onMatch, enabled: true, source: url })),
      ...wrappers.map((w) => ({ kind: "unwrap", id: `${url}#unwrap:${sig(w)}`, name: w.name, pattern: w.pattern, param: w.param, enabled: true, source: url })),
    ], // online entries are switched off per user in settings.disabledRemote
  };
}

const patternsOut = (r) => {
  const patterns = rulePatterns(r);
  return patterns.length > 1 ? { patterns } : { pattern: patterns[0] || "" };
};

/** The user's rules and link wrappers as a ruleset file (the same format online rulesets use). */
export function exportRules(rules, wrappers = [], name = "My Tab Dedupe rules") {
  const out = {
    name,
    rules: rules.map((r) => ({
      name: r.name || rulePatterns(r)[0] || "",
      ...patternsOut(r),
      onMatch: r.onMatch === "switch" ? "switch" : "navigate",
      enabled: r.enabled !== false,
    })),
  };
  if (wrappers.length) {
    out.unwrap = wrappers.map((w) => ({ name: w.name || rulePatterns(w)[0] || "", ...patternsOut(w), param: w.param, enabled: w.enabled !== false }));
  }
  return out;
}

/** Add the rules and link wrappers from a file, skipping ones that are already present. */
export function importRules(existingRules, existingWrappers, json) {
  const { rules: newRules, wrappers: newWrappers } = entriesOf(json);
  const ruleSig = (r) => rulePatterns(r).join("\n");
  const wrapSig = (w) => `${rulePatterns(w).join("\n")}|${w.param}`;
  const haveRules = new Set(existingRules.map(ruleSig));
  const haveWraps = new Set(existingWrappers.map(wrapSig));
  const rules = [...existingRules], wrappers = [...existingWrappers];
  let added = 0, skipped = 0;
  for (const r of newRules) {
    if (haveRules.has(ruleSig(r))) { skipped++; continue; }
    haveRules.add(ruleSig(r));
    rules.push({ id: `local-${crypto.randomUUID()}`, name: r.name, pattern: r.pattern, onMatch: r.onMatch, enabled: r.enabled });
    added++;
  }
  for (const w of newWrappers) {
    if (haveWraps.has(wrapSig(w))) { skipped++; continue; }
    haveWraps.add(wrapSig(w));
    wrappers.push({ kind: "unwrap", id: `local-${crypto.randomUUID()}`, name: w.name, pattern: w.pattern, param: w.param, enabled: w.enabled });
    added++;
  }
  return { rules, wrappers, added, skipped };
}
