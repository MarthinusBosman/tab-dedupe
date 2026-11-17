import { decideNewTab, planDuplicates, tabUrl, upgradeBuiltInRules } from "./lib/rules.js";
import { getSettings, getAllRules, refreshRulesets, MARK, DEFAULT_SETTINGS } from "./lib/store.js";

const WEB = /^https?:\/\//i;
const ALL_SITES = { origins: ["<all_urls>"] };

// New tabs we're still watching, kept in session storage so it survives service-worker restarts.
//   fresh[tabId] = true                   opened without a web URL yet (blank tab, or the URL arrives a moment later);
//                                         its first web URL is treated as "opening a new tab".
//   follow[tabId] = {until, committed}    opened on a page that matched nothing; keep checking while it's still being
//                                         redirected (link scanners, sign-in hops), until you navigate it yourself.
const FOLLOW_MS = 30_000;
async function getWatch() {
  const { fresh = {}, follow = {} } = await chrome.storage.session.get(["fresh", "follow"]);
  return { fresh, follow };
}
async function setWatch(w) {
  await chrome.storage.session.set(w);
}

// Don't treat tabs restored at browser start-up as newly opened.
let restoringUntil = 0;
const booted = chrome.storage.session.get("booted").then(async ({ booted: b }) => {
  if (!b) {
    restoringUntil = Date.now() + 10_000;
    await chrome.storage.session.set({ booted: true });
  }
});

/** Returns true if the tab was handled (switched/navigated and closed). */
async function handleNewTab(tab, url) {
  await booted;
  if (Date.now() < restoringUntil || tab.discarded) {
    console.debug("tab-dedupe: skip (start-up restore)", tab.id);
    return true;
  }
  const settings = await getSettings();
  const rules = await getAllRules(settings);
  const tabs = await chrome.tabs.query({});
  const self = { ...(tabs.find((t) => t.id === tab.id) || {}), ...tab, url, pendingUrl: url };
  const d = decideNewTab(self, tabs, rules, settings);
  console.debug("tab-dedupe:", url, JSON.stringify(d));
  if (d.action !== "switch" && d.action !== "navigate") return d.action === "keep";
  const target = tabs.find((t) => t.id === d.targetId);
  try {
    await chrome.tabs.update(d.targetId, d.action === "navigate" ? { url: d.url, active: true } : { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
    await chrome.tabs.remove(tab.id);
  } catch (e) {
    console.warn("Tab Dedupe: could not switch", e);
  }
  return true;
}

/** First web URL of a new tab: decide, and if nothing matched keep following its redirects for a while. */
async function firstUrl(tab, url) {
  // Start following before deciding: a fast server redirect can commit while the decision is still running.
  const w = await getWatch();
  delete w.fresh[tab.id];
  w.follow[tab.id] = { until: Date.now() + FOLLOW_MS, committed: false };
  await setWatch(w);
  if (await handleNewTab(tab, url)) {
    const w2 = await getWatch();
    delete w2.follow[tab.id];
    await setWatch(w2);
  }
}

chrome.tabs.onCreated.addListener(async (tab) => {
  const url = tabUrl(tab);
  if (WEB.test(url)) {
    await firstUrl(tab, url);
  } else {
    const w = await getWatch();
    w.fresh[tab.id] = true;
    await setWatch(w);
  }
  scheduleRefresh();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url && WEB.test(info.url)) {
    const w = await getWatch();
    if (w.fresh[tabId]) await firstUrl(tab, info.url);
  }
  if (info.status === "loading") applied.delete(tabId); // page reload drops the injected marker
  if (info.url || info.status || "pinned" in info || "groupId" in info) scheduleRefresh();
});

// Redirects of a tab we're following: server redirects, script redirects (e.g. Teams Safe Links pages) and the
// automatic form posts of sign-in pages. Any other navigation means you're using the tab, so we stop.
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const w = await getWatch();
  const f = w.follow[d.tabId];
  if (!f) return;
  const redirect = d.transitionQualifiers.some((q) => q === "client_redirect" || q === "server_redirect");
  if (Date.now() > f.until || (!redirect && f.committed && d.transitionType !== "form_submit")) {
    delete w.follow[d.tabId];
    return setWatch(w);
  }
  f.committed = true;
  await setWatch(w);
  if (!redirect && d.transitionType !== "form_submit") return; // the tab's own first page load
  const tab = await chrome.tabs.get(d.tabId).catch(() => null);
  if (tab && (await handleNewTab(tab, d.url))) {
    const w2 = await getWatch();
    delete w2.follow[d.tabId];
    await setWatch(w2);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  applied.delete(tabId);
  const w = await getWatch();
  if (w.fresh[tabId] || w.follow[tabId]) {
    delete w.fresh[tabId];
    delete w.follow[tabId];
    await setWatch(w);
  }
  scheduleRefresh();
});

// ---- badge + 🔁 markers ---------------------------------------------------------------------------------------

const applied = new Map(); // tabId -> marker state we last injected

function markTitle(on, mark) {
  const st = (window.__tabDedupe ||= { on: false, obs: null });
  st.on = on;
  const fix = () => {
    const t = document.title;
    if (st.on && !t.startsWith(mark)) document.title = mark + t;
    else if (!st.on && t.startsWith(mark)) document.title = t.slice(mark.length);
  };
  fix();
  if (on && !st.obs) {
    st.obs = new MutationObserver(fix);
    st.obs.observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
  } else if (!on && st.obs) {
    st.obs.disconnect();
    st.obs = null;
  }
}

async function setMarker(tabId, on) {
  if (applied.get(tabId) === on) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: markTitle, args: [on, MARK] });
    applied.set(tabId, on);
  } catch {
    applied.set(tabId, on); // e.g. edge:// or store pages; don't retry until the page reloads
  }
}

let timer = null;
function scheduleRefresh() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 400);
}

async function refresh() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  const plan = planDuplicates(tabs, await getAllRules(settings), settings);
  const n = plan.closeIds.length;
  await chrome.action.setBadgeText({ text: settings.paused ? "off" : n ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: settings.paused ? "#888" : "#c2410c" });
  const canMark = await chrome.permissions.contains(ALL_SITES);
  if (!canMark) return;
  const on = settings.markers;
  await Promise.all(
    tabs
      .filter((t) => WEB.test(t.url || "") && t.status === "complete")
      .filter((t) => on || applied.get(t.id) !== false) // when off, only clear tabs that may still be marked
      .map((t) => setMarker(t.id, on && plan.duplicateIds.has(t.id))),
  );
}

async function closeDuplicates() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  const { closeIds } = planDuplicates(tabs, await getAllRules(settings), settings);
  if (closeIds.length) await chrome.tabs.remove(closeIds);
  return closeIds.length;
}

// ---- online ruleset schedule ----------------------------------------------------------------------------------

async function ensureAlarm() {
  const { refreshHours } = await getSettings();
  const period = Math.max(1, Number(refreshHours) || 24) * 60;
  const existing = await chrome.alarms.get("rulesets");
  if (!existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create("rulesets", { periodInMinutes: period, delayInMinutes: existing ? period : 0.1 });
  }
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "rulesets") {
    await refreshRulesets();
    scheduleRefresh();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get("settings");
  if (!settings) await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  else if (settings.rules) {
    const rules = upgradeBuiltInRules(settings.rules);
    if (JSON.stringify(rules) !== JSON.stringify(settings.rules)) await chrome.storage.sync.set({ settings: { ...settings, rules } });
  }
  await ensureAlarm();
  scheduleRefresh();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  scheduleRefresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) {
    const before = changes.settings.oldValue || {};
    const after = changes.settings.newValue || {};
    if (JSON.stringify(before.rulesetUrls) !== JSON.stringify(after.rulesetUrls)) refreshRulesets().then(scheduleRefresh);
    if (before.refreshHours !== after.refreshHours) ensureAlarm();
  }
  if (area === "sync" || (area === "local" && changes.rulesets)) scheduleRefresh();
});
chrome.permissions.onAdded.addListener(scheduleRefresh);

// ---- popup / options messages ---------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "count") {
      const settings = await getSettings();
      const tabs = await chrome.tabs.query({});
      return { count: planDuplicates(tabs, await getAllRules(settings), settings).closeIds.length };
    }
    if (msg.type === "closeDuplicates") {
      const closed = await closeDuplicates();
      scheduleRefresh();
      return { closed };
    }
    if (msg.type === "refreshRulesets") {
      const rulesets = await refreshRulesets();
      scheduleRefresh();
      return { rulesets };
    }
    return {};
  })().then(reply, (e) => reply({ error: String(e) }));
  return true;
});
