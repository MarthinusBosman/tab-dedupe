import { decideNewTab, planDuplicates, tabUrl } from "./lib/rules.js";
import { getSettings, getAllRules, refreshRulesets, MARK, DEFAULT_SETTINGS } from "./lib/store.js";

const WEB = /^https?:\/\//i;
const ALL_SITES = { origins: ["<all_urls>"] };

// Tabs that were opened without a web URL yet (blank new tab, or a link whose URL arrives a moment later).
// The first web URL they get is treated as "opening a new tab". Kept in session storage so it survives SW restarts.
async function getFresh() {
  return (await chrome.storage.session.get("fresh")).fresh || {};
}
async function setFresh(fresh) {
  await chrome.storage.session.set({ fresh });
}

// Don't treat tabs restored at browser start-up as newly opened.
let restoringUntil = 0;
const booted = chrome.storage.session.get("booted").then(async ({ booted: b }) => {
  if (!b) {
    restoringUntil = Date.now() + 10_000;
    await chrome.storage.session.set({ booted: true });
  }
});

async function handleNewTab(tab) {
  await booted;
  if (Date.now() < restoringUntil || tab.discarded) return console.debug("tab-dedupe: skip (start-up restore)", tab.id);
  const settings = await getSettings();
  const rules = await getAllRules(settings);
  const tabs = await chrome.tabs.query({});
  const self = { ...(tabs.find((t) => t.id === tab.id) || {}), ...tab };
  const d = decideNewTab(self, tabs, rules, settings);
  console.debug("tab-dedupe:", tabUrl(self), JSON.stringify(d));
  if (d.action !== "switch" && d.action !== "navigate") return;
  const target = tabs.find((t) => t.id === d.targetId);
  try {
    await chrome.tabs.update(d.targetId, d.action === "navigate" ? { url: d.url, active: true } : { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
    await chrome.tabs.remove(tab.id);
  } catch (e) {
    console.warn("Tab Dedupe: could not switch", e);
  }
}

chrome.tabs.onCreated.addListener(async (tab) => {
  const url = tabUrl(tab);
  if (WEB.test(url)) {
    await handleNewTab(tab);
  } else {
    const fresh = await getFresh();
    fresh[tab.id] = true;
    await setFresh(fresh);
  }
  scheduleRefresh();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) {
    const fresh = await getFresh();
    if (fresh[tabId] && WEB.test(info.url)) {
      delete fresh[tabId];
      await setFresh(fresh);
      await handleNewTab({ ...tab, url: info.url });
    }
  }
  if (info.status === "loading") applied.delete(tabId); // page reload drops the injected marker
  if (info.url || info.status || "pinned" in info) scheduleRefresh();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  applied.delete(tabId);
  const fresh = await getFresh();
  if (fresh[tabId]) {
    delete fresh[tabId];
    await setFresh(fresh);
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
  const plan = planDuplicates(tabs, await getAllRules(settings));
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
  const tabs = await chrome.tabs.query({});
  const { closeIds } = planDuplicates(tabs, await getAllRules());
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
      const tabs = await chrome.tabs.query({});
      return { count: planDuplicates(tabs, await getAllRules()).closeIds.length };
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
