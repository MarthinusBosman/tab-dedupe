import { getSettings, saveSettings, getRulesets, getAllRules } from "./lib/store.js";
import { keyFor } from "./lib/rules.js";

const $ = (id) => document.getElementById(id);
const ALL_SITES = { origins: ["<all_urls>"] };
let settings;

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

const ICONS = {
  up: "M8 13V3M4 7l4-4 4 4",
  down: "M8 3v10M4 9l4 4 4-4",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "i");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}
const iconButton = (name, title, onclick, extra = "") =>
  el("button", { className: `icon ${extra}`, title, ariaLabel: title, onclick }, icon(name));

function onMatchSelect(value, onchange) {
  const s = el("select", { onchange: () => onchange(s.value), title: "When a matching tab is already open" },
    el("option", { value: "navigate", textContent: "Switch and open the new URL" }),
    el("option", { value: "switch", textContent: "Just switch to the tab" }));
  s.value = value;
  return s;
}

let saveTimer;
const saveRulesSoon = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings({ rules: settings.rules }).then(updateCount).then(runTest), 300);
};

function renderRules(focusIndex) {
  const box = $("rules");
  box.replaceChildren();
  if (!settings.rules.length) {
    box.append(el("div", { className: "empty", textContent: "No rules yet. Without rules, only identical URLs count as duplicates." }));
  }
  settings.rules.forEach((r, i) => {
    const move = (d) => {
      const j = i + d;
      [settings.rules[i], settings.rules[j]] = [settings.rules[j], settings.rules[i]];
      saveRulesSoon();
      renderRules();
    };
    const row = el("div", { className: `rule${r.enabled === false ? " off" : ""}` });
    const nameInput = el("input", { type: "text", className: "name", value: r.name || "", placeholder: "Rule name", ariaLabel: "Rule name",
      oninput: (e) => { r.name = e.target.value; saveRulesSoon(); } });
    row.append(
      el("input", { type: "checkbox", className: "switch", checked: r.enabled !== false, title: "Rule on/off",
        onchange: (e) => { r.enabled = e.target.checked; row.classList.toggle("off", !r.enabled); saveRulesSoon(); } }),
      el("div", { className: "fields" },
        nameInput,
        el("input", { type: "text", className: "pattern", value: r.pattern, placeholder: "example.com/docs/*", ariaLabel: "URL pattern",
          spellcheck: false, oninput: (e) => { r.pattern = e.target.value.trim(); saveRulesSoon(); } })),
      onMatchSelect(r.onMatch || "navigate", (v) => { r.onMatch = v; saveRulesSoon(); }),
      el("div", { className: "tools" },
        Object.assign(iconButton("up", "Move up", () => move(-1)), { disabled: i === 0 }),
        Object.assign(iconButton("down", "Move down", () => move(1)), { disabled: i === settings.rules.length - 1 }),
        iconButton("trash", "Delete rule", () => { settings.rules.splice(i, 1); saveRulesSoon(); renderRules(); }, "danger")),
    );
    box.append(row);
    if (i === focusIndex) setTimeout(() => nameInput.focus());
  });
}

async function renderRulesets() {
  const rulesets = await getRulesets();
  const box = $("rulesets");
  box.replaceChildren();
  for (const url of settings.rulesetUrls) {
    const rs = rulesets[url] || { name: url, rules: [] };
    const n = rs.rules.length;
    const meta = `${n} rule${n === 1 ? "" : "s"} · ${rs.fetchedAt ? `updated ${new Date(rs.fetchedAt).toLocaleString()}` : "not downloaded yet"}`;
    const block = el("div", { className: "ruleset" },
      el("div", { className: "rs-head" },
        el("div", { className: "text" },
          el("div", { className: "name", textContent: rs.name }),
          el("div", { className: "desc", textContent: meta }),
          el("div", { className: "url", textContent: url }),
          rs.error && el("div", { className: "desc err", textContent: `Last refresh failed: ${rs.error}` })),
        el("button", { className: "subtle", textContent: "Remove", onclick: async () => {
          settings = await saveSettings({ rulesetUrls: settings.rulesetUrls.filter((u) => u !== url) });
          renderRulesets();
          updateCount();
        } })));
    for (const r of rs.rules) {
      const on = !settings.disabledRemote.includes(r.id);
      const row = el("div", { className: `rs-rule${on ? "" : " off"}` });
      row.append(
        el("input", { type: "checkbox", className: "switch small", checked: on, title: "Rule on/off", onchange: async (e) => {
          const off = new Set(settings.disabledRemote);
          e.target.checked ? off.delete(r.id) : off.add(r.id);
          row.classList.toggle("off", !e.target.checked);
          settings = await saveSettings({ disabledRemote: [...off] });
          updateCount();
        } }),
        el("div", {}, el("div", { textContent: r.name }), el("code", { textContent: r.pattern })),
        el("div", { className: "act", textContent: r.onMatch === "switch" ? "Just switch" : "Switch and open new URL" }));
      block.append(row);
    }
    box.append(block);
  }
}

async function updateCount() {
  const { count } = await chrome.runtime.sendMessage({ type: "count" });
  $("count").textContent = count ? `${count} duplicate tab${count === 1 ? "" : "s"} open` : "No duplicate tabs open";
  $("close").disabled = !count;
}

async function runTest() {
  const out = $("testOut");
  const url = $("testUrl").value.trim();
  if (!url) return out.replaceChildren();
  const k = keyFor(url, await getAllRules(await getSettings()));
  if (!k) return out.replaceChildren("Not a web page, so it's ignored.");
  if (!k.rule) return out.replaceChildren("No rule matches, so only this exact URL counts as the same page.");
  const group = k.key.slice(`rule:${k.rule.id}:`.length);
  out.replaceChildren(
    el("span", { className: "pill", textContent: "Matches" }),
    el("b", { textContent: k.rule.name || k.rule.pattern }),
    el("span", { textContent: group ? `· one tab for ${group}` : "· one tab for all matching pages" }),
    el("span", { textContent: k.rule.onMatch === "switch" ? "· just switches" : "· switches and opens the new URL" }),
  );
}

$("addRule").onclick = () => {
  settings.rules.push({ id: `local-${crypto.randomUUID()}`, name: "", pattern: "", onMatch: "navigate", enabled: true });
  renderRules(settings.rules.length - 1);
  saveRulesSoon();
};
$("testUrl").oninput = runTest;
$("close").onclick = async () => {
  const { closed } = await chrome.runtime.sendMessage({ type: "closeDuplicates" });
  $("count").textContent = `Closed ${closed} tab${closed === 1 ? "" : "s"}`;
  $("close").disabled = true;
};
$("openerSelf").onchange = (e) => saveSettings({ openerSelf: e.target.value });
$("enabled").onchange = (e) => saveSettings({ paused: !e.target.checked });
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
  try { new URL(url); } catch { $("rsStatus").textContent = "That isn't a valid URL."; return; }
  if (settings.rulesetUrls.includes(url)) return;
  // Hosts without open CORS headers need host permission; ask for that origin only (fine to decline for GitHub raw/gists).
  await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] }).catch(() => false);
  settings = await saveSettings({ rulesetUrls: [...settings.rulesetUrls, url] });
  $("rsUrl").value = "";
  await refreshNow();
};
$("rsUrl").onkeydown = (e) => e.key === "Enter" && $("addRs").click();

async function refreshNow() {
  const status = $("rsStatus");
  status.textContent = "Refreshing…";
  $("refreshNow").disabled = true;
  await chrome.runtime.sendMessage({ type: "refreshRulesets" });
  $("refreshNow").disabled = false;
  status.textContent = "If a download fails, the last good copy is kept.";
  await renderRulesets();
  updateCount();
}
$("refreshNow").onclick = refreshNow;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings?.newValue) $("enabled").checked = !changes.settings.newValue.paused;
});

(async () => {
  settings = await getSettings();
  $("version").textContent = `Version ${chrome.runtime.getManifest().version}`;
  $("openerSelf").value = settings.openerSelf;
  $("enabled").checked = !settings.paused;
  $("markers").checked = settings.markers && (await chrome.permissions.contains(ALL_SITES));
  $("refreshHours").value = settings.refreshHours;
  renderRules();
  renderRulesets();
  updateCount();
})();
