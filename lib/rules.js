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

const escape = (s) => s.replace(/[.+^$()|[\]\\?]/g, "\\$&");

/**
 * Compile a rule pattern.
 *   *       ignore one URL part (path segment or query value)
 *   **      ignore anything (across slashes)
 *   {name}  one tab per distinct value of this part
 * Anything after the pattern (more path, query, #fragment) is ignored, unless the pattern itself contains "?",
 * in which case the query is matched too.
 */
export function compilePattern(pattern) {
  const p = String(pattern).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  const usesQuery = p.includes("?");
  let body = "";
  for (let i = 0; i < p.length; ) {
    if (p.startsWith("**", i)) { body += ".*"; i += 2; continue; }
    if (p[i] === "*") { body += "[^/?&#]+"; i += 1; continue; }
    if (p[i] === "{") {
      const end = p.indexOf("}", i);
      if (end > i) { body += "([^/?&#]+)"; i = end + 1; continue; }
    }
    body += escape(p[i]);
    i += 1;
  }
  const regex = new RegExp(`^${body}(?:[/&].*)?$`, "i");
  return {
    match(url) {
      const u = parse(url);
      if (!u) return null;
      const subject = hostPath(u) + (usesQuery ? u.search : "");
      const m = regex.exec(subject);
      return m ? m.slice(1) : null;
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

/** Group key for a URL: the first enabled matching rule, else the normalized URL. */
export function keyFor(url, rules) {
  for (const rule of rules) {
    if (rule.enabled === false || !rule.pattern) continue;
    const m = compiledFor(rule.pattern).match(url);
    if (m) return { key: `rule:${rule.id}:${m.map((v) => decode(v).toLowerCase()).join("|")}`, rule };
  }
  const n = normalizeUrl(url);
  return n === null ? null : { key: `url:${n}`, rule: null };
}

export const tabUrl = (t) => t.pendingUrl || t.url || "";
export const eligible = (t) => !t.pinned && !t.incognito && parse(tabUrl(t)) !== null;
const byRecent = (a, b) =>
  (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) || (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.id - a.id;

/**
 * What to do with a freshly opened tab.
 * Returns {action: "none"} | {action: "keep"} (duplicate allowed, e.g. ctrl+click from the matching tab)
 *       | {action: "switch", targetId} | {action: "navigate", targetId, url}
 */
export function decideNewTab(newTab, tabs, rules, settings) {
  if (settings.paused || !eligible(newTab)) return { action: "none" };
  const url = tabUrl(newTab);
  const k = keyFor(url, rules);
  if (!k) return { action: "none" };
  let matches = tabs
    .filter((t) => t.id !== newTab.id && eligible(t) && keyFor(tabUrl(t), rules)?.key === k.key)
    .sort(byRecent);
  if (!matches.length) return { action: "none" };
  if (settings.openerSelf !== "applyRule" && newTab.openerTabId != null) {
    matches = matches.filter((t) => t.id !== newTab.openerTabId);
    if (!matches.length) return { action: "keep" };
  }
  const target = matches[0];
  if (k.rule?.onMatch !== "switch" && normalizeUrl(tabUrl(target)) !== normalizeUrl(url)) {
    return { action: "navigate", targetId: target.id, url };
  }
  return { action: "switch", targetId: target.id };
}

/** Duplicate groups across open tabs: which tabs are duplicates and which to close (keeps most recently used). */
export function planDuplicates(tabs, rules) {
  const groups = new Map();
  for (const t of tabs) {
    if (!eligible(t)) continue;
    const k = keyFor(tabUrl(t), rules);
    if (!k) continue;
    if (!groups.has(k.key)) groups.set(k.key, []);
    groups.get(k.key).push(t);
  }
  const closeIds = [];
  const duplicateIds = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(byRecent);
    group.forEach((t) => duplicateIds.add(t.id));
    closeIds.push(...group.slice(1).map((t) => t.id));
  }
  return { closeIds, duplicateIds };
}

/** Validate a downloaded ruleset JSON: {name?, rules: [{pattern, name?, onMatch?, id?}]}. */
export function validateRuleset(json, url) {
  if (!json || typeof json !== "object" || !Array.isArray(json.rules)) {
    throw new Error('Not a ruleset: expected {"rules": [...]}');
  }
  const rules = [];
  for (const r of json.rules) {
    if (!r || typeof r.pattern !== "string" || !r.pattern.trim()) continue;
    try { compilePattern(r.pattern); } catch { continue; }
    rules.push({
      id: `${url}#${typeof r.id === "string" ? r.id : r.pattern}`,
      name: typeof r.name === "string" ? r.name : r.pattern,
      pattern: r.pattern,
      onMatch: r.onMatch === "switch" ? "switch" : "navigate",
      enabled: true,
      source: url,
    });
  }
  return { name: typeof json.name === "string" ? json.name : url, rules };
}
