// Settings + online rulesets, shared by background, popup and options.
import { validateRuleset, aggressiveRule } from "./rules.js";

// Rulesets every install subscribes to. Copies ship inside the extension (see seedBundledRulesets), so they work
// straight after install and offline; the GitHub versions replace them on the first refresh.
const REPO_RAW = "https://raw.githubusercontent.com/MarthinusBosman/tab-dedupe/main/rulesets/";
export const DEFAULT_RULESETS = {
  [`${REPO_RAW}default_ruleset.json`]: "rulesets/default_ruleset.json",
  [`${REPO_RAW}default_wrappers.json`]: "rulesets/default_wrappers.json",
};

export const DEFAULT_SETTINGS = {
  paused: false,
  // Ctrl+click / "Duplicate tab" from the only matching tab: "keepBoth" opens it anyway, "applyRule" treats it like any other.
  openerSelf: "keepBoth",
  // Pinned tabs: "switch" (switch to them, never change or close them), "redirect" (like any other tab, never closed), "ignore".
  pinned: "switch",
  // Tab groups: "preferSame" (a match in another group is only switched to), "separate" (per group), "ignore".
  groups: "preferSame",
  markers: false,
  // Keep checking a new tab while it's being redirected (link scanners, sign-in hops), until you navigate it yourself.
  followRedirects: true,
  // Aggressive: a catch-all "one tab per site" rule after all other rules, except these hostnames.
  aggressive: false,
  aggressiveExclude: [],
  refreshHours: 24,
  rulesetUrls: Object.keys(DEFAULT_RULESETS),
  defaultsAdded: true, // existing installs get DEFAULT_RULESETS added once (background.js), never again after removal
  disabledRemote: [],
  rules: [],
  // Your own link wrappers: {kind: "unwrap", id, name, pattern, param, enabled}.
  wrappers: [],
};

export const MARK = "\u{1F501} "; // 🔁

export async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ settings });
  return settings;
}

export async function getRulesets() {
  const { rulesets } = await chrome.storage.local.get("rulesets");
  return rulesets || {};
}

/**
 * Local rules first (top to bottom), then online rules in ruleset order, then the aggressive catch-all. Link
 * wrappers (kind "unwrap": yours and online ones) ride along in the same list; keyFor applies them first.
 */
export async function getAllRules(settings) {
  settings ||= await getSettings();
  const rulesets = await getRulesets();
  const remote = settings.rulesetUrls.flatMap((url) =>
    (rulesets[url]?.rules || []).map((r) => ({ ...r, enabled: !settings.disabledRemote.includes(r.id) })),
  );
  const aggressive = settings.aggressive ? [aggressiveRule(settings.aggressiveExclude)] : [];
  return [...settings.rules, ...remote, ...aggressive, ...(settings.wrappers || [])];
}

/** Store the bundled copies of the default rulesets that haven't been downloaded yet. */
export async function seedBundledRulesets() {
  const rulesets = await getRulesets();
  let changed = false;
  for (const [url, path] of Object.entries(DEFAULT_RULESETS)) {
    if (rulesets[url]?.rules?.length) continue;
    const json = await (await fetch(chrome.runtime.getURL(path))).json();
    rulesets[url] = { ...validateRuleset(json, url), fetchedAt: null, bundled: true, error: null };
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ rulesets });
}

/** Download every configured ruleset; on failure keep the last good copy and record the error. */
export async function refreshRulesets() {
  const settings = await getSettings();
  const old = await getRulesets();
  const next = {};
  for (const url of settings.rulesetUrls) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = validateRuleset(await res.json(), url);
      next[url] = { ...parsed, fetchedAt: Date.now(), error: null };
    } catch (e) {
      let fallback = old[url];
      if (!fallback?.rules?.length && DEFAULT_RULESETS[url]) {
        // A default ruleset that can't be downloaded yet: use the copy shipped with the extension.
        const json = await (await fetch(chrome.runtime.getURL(DEFAULT_RULESETS[url]))).json();
        fallback = { ...validateRuleset(json, url), fetchedAt: null, bundled: true };
      }
      next[url] = { ...(fallback || { name: url, rules: [], fetchedAt: null }), error: String(e.message || e) };
    }
  }
  await chrome.storage.local.set({ rulesets: next });
  return next;
}
