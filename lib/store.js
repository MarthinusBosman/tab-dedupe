// Settings + online rulesets, shared by background, popup and options.
import { validateRuleset } from "./rules.js";

export const DEFAULT_SETTINGS = {
  paused: false,
  // Ctrl+click / "Duplicate tab" from the only matching tab: "keepBoth" opens it anyway, "applyRule" treats it like any other.
  openerSelf: "keepBoth",
  // Pinned tabs: "switch" (switch to them, never change or close them), "redirect" (like any other tab, never closed), "ignore".
  pinned: "switch",
  // Tab groups: "preferSame" (a match in another group is only switched to), "separate" (per group), "ignore".
  groups: "preferSame",
  markers: false,
  refreshHours: 24,
  rulesetUrls: [],
  disabledRemote: [],
  rules: [
    {
      id: "default-ado-pr",
      name: "Azure DevOps: one PR tab",
      pattern: "dev.azure.com/*/*/_git/*/pullrequest/*",
      onMatch: "navigate",
      enabled: true,
    },
  ],
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

/** Local rules first (top to bottom), then online rules in ruleset order. */
export async function getAllRules(settings) {
  settings ||= await getSettings();
  const rulesets = await getRulesets();
  const remote = settings.rulesetUrls.flatMap((url) =>
    (rulesets[url]?.rules || []).map((r) => ({ ...r, enabled: !settings.disabledRemote.includes(r.id) })),
  );
  return [...settings.rules, ...remote];
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
      next[url] = { name: old[url]?.name || url, rules: old[url]?.rules || [], fetchedAt: old[url]?.fetchedAt || null, error: String(e.message || e) };
    }
  }
  await chrome.storage.local.set({ rulesets: next });
  return next;
}
