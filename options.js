import { getSettings, saveSettings, getRulesets, getAllRules } from "./lib/store.js";
import { keyFor } from "./lib/rules.js";

const $ = (id) => document.getElementById(id);
const ALL_SITES = { origins: ["<all_urls>"] };
let settings;

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function onMatchSelect(value, onchange) {
  const s = el("select", { onchange: () => onchange(s.value) },
    el("option", { value: "navigate", textContent: "Switch to it and open the new URL there" }),
    el("option", { value: "switch", textContent: "Just switch to it" }));
  s.value = value;
  return s;
}

let saveTimer;
const saveRulesSoon = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings({ rules: settings.rules }).then(updateCount).then(runTest), 300);
};

function renderRules() {
  const body = $("rules");
  body.replaceChildren();
  settings.rules.forEach((r, i) => {
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= settings.rules.length) return;
      [settings.rules[i], settings.rules[j]] = [settings.rules[j], settings.rules[i]];
      saveRulesSoon();
      renderRules();
    };
    body.append(el("tr", {},
      el("td", {}, el("input", { type: "checkbox", checked: r.enabled !== false, onchange: (e) => { r.enabled = e.target.checked; saveRulesSoon(); } })),
      el("td", {}, el("input", { type: "text", value: r.name || "", oninput: (e) => { r.name = e.target.value; saveRulesSoon(); } })),
      el("td", { className: "pattern" }, el("input", { type: "text", value: r.pattern, oninput: (e) => { r.pattern = e.target.value.trim(); saveRulesSoon(); } })),
      el("td", {}, onMatchSelect(r.onMatch || "navigate", (v) => { r.onMatch = v; saveRulesSoon(); })),
      el("td", { className: "ctl" },
        el("button", { textContent: "↑", title: "Move up", onclick: () => move(-1) }),
        el("button", { textContent: "↓", title: "Move down", onclick: () => move(1) }),
        el("button", { textContent: "✕", title: "Delete", onclick: () => { settings.rules.splice(i, 1); saveRulesSoon(); renderRules(); } })),
    ));
  });
}

async function renderRulesets() {
  const rulesets = await getRulesets();
  const box = $("rulesets");
  box.replaceChildren();
  for (const url of settings.rulesetUrls) {
    const rs = rulesets[url] || { name: url, rules: [] };
    const fetched = rs.fetchedAt ? `updated ${new Date(rs.fetchedAt).toLocaleString()}` : "not downloaded yet";
    const list = el("table", {});
    for (const r of rs.rules) {
      list.append(el("tr", {},
        el("td", {}, el("input", { type: "checkbox", checked: !settings.disabledRemote.includes(r.id), onchange: async (e) => {
          const off = new Set(settings.disabledRemote);
          e.target.checked ? off.delete(r.id) : off.add(r.id);
          settings = await saveSettings({ disabledRemote: [...off] });
          updateCount();
        } })),
        el("td", { textContent: r.name }),
        el("td", {}, el("code", { textContent: r.pattern })),
        el("td", { className: "muted", textContent: r.onMatch === "switch" ? "just switch" : "open new URL there" }),
      ));
    }
    box.append(el("div", { className: "ruleset" },
      el("header", {},
        el("div", {}, el("strong", { textContent: rs.name }), " ", el("span", { className: "muted", textContent: `${rs.rules.length} rules, ${fetched}` }),
          el("div", { className: "muted", textContent: url }),
          rs.error ? el("div", { className: "err", textContent: `Last refresh failed: ${rs.error}` }) : ""),
        el("button", { textContent: "Remove", onclick: async () => {
          settings = await saveSettings({ rulesetUrls: settings.rulesetUrls.filter((u) => u !== url) });
          renderRulesets();
        } })),
      list));
  }
}

async function updateCount() {
  const { count } = await chrome.runtime.sendMessage({ type: "count" });
  $("count").textContent = count ? `${count} duplicate tab${count === 1 ? "" : "s"} open` : "No duplicate tabs open";
  $("close").disabled = !count;
}

async function runTest() {
  const url = $("testUrl").value.trim();
  if (!url) return ($("testOut").textContent = "");
  const k = keyFor(url, await getAllRules(await getSettings()));
  $("testOut").textContent = !k ? "Not a web page, ignored."
    : k.rule ? `Matches "${k.rule.name || k.rule.pattern}", group ${k.key.split(":").slice(2).join(":") || "(one tab)"}`
    : "No rule matches; exact URL is used.";
}

$("addRule").onclick = () => {
  settings.rules.push({ id: `local-${crypto.randomUUID()}`, name: "", pattern: "", onMatch: "navigate", enabled: true });
  renderRules();
  saveRulesSoon();
};
$("testUrl").oninput = runTest;
$("close").onclick = async () => {
  const { closed } = await chrome.runtime.sendMessage({ type: "closeDuplicates" });
  $("count").textContent = `Closed ${closed} tab${closed === 1 ? "" : "s"}`;
  $("close").disabled = true;
};
$("openerSelf").onchange = (e) => saveSettings({ openerSelf: e.target.value });
$("paused").onchange = (e) => saveSettings({ paused: e.target.checked });
$("markers").onchange = async (e) => {
  if (e.target.checked && !(await chrome.permissions.request(ALL_SITES))) {
    e.target.checked = false;
    return;
  }
  settings = await saveSettings({ markers: e.target.checked });
};
$("refreshHours").onchange = (e) => saveSettings({ refreshHours: Math.max(1, Number(e.target.value) || 24) });

$("addRs").onclick = async () => {
  const url = $("rsUrl").value.trim();
  try { new URL(url); } catch { $("rsStatus").textContent = "Not a valid URL"; return; }
  if (settings.rulesetUrls.includes(url)) return;
  // Hosts without open CORS headers need host permission; ask for that origin only (fine to decline for GitHub raw/gists).
  await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] }).catch(() => false);
  settings = await saveSettings({ rulesetUrls: [...settings.rulesetUrls, url] });
  $("rsUrl").value = "";
  await refreshNow();
};

async function refreshNow() {
  $("rsStatus").textContent = "Refreshing...";
  await chrome.runtime.sendMessage({ type: "refreshRulesets" });
  $("rsStatus").textContent = "";
  await renderRulesets();
  updateCount();
}
$("refreshNow").onclick = refreshNow;

(async () => {
  settings = await getSettings();
  $("openerSelf").value = settings.openerSelf;
  $("paused").checked = settings.paused;
  $("markers").checked = settings.markers && (await chrome.permissions.contains(ALL_SITES));
  $("refreshHours").value = settings.refreshHours;
  renderRules();
  renderRulesets();
  updateCount();
})();
