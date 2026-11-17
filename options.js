import { getSettings, saveSettings, getRulesets, getAllRules, DEFAULT_RULESETS } from "./lib/store.js";
import { keyFor, patternWarning, exportRules, importRules } from "./lib/rules.js";

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
    const warn = el("div", { className: "warn", textContent: patternWarning(r) || "", hidden: !patternWarning(r) });
    const pattern = el("textarea", { className: "pattern", value: r.pattern, placeholder: "example.com/docs/*  (one pattern per line)",
      ariaLabel: "URL patterns, one per line", spellcheck: false, rows: 1, wrap: "off" });
    const fit = () => { pattern.style.height = "auto"; pattern.style.height = `${pattern.scrollHeight + 2}px`; };
    pattern.oninput = () => {
      r.pattern = pattern.value.split("\n").map((l) => l.trim()).join("\n");
      const w = patternWarning(r);
      warn.textContent = w || "";
      warn.hidden = !w;
      fit();
      saveRulesSoon();
    };
    requestAnimationFrame(fit);
    const nameInput = el("input", { type: "text", className: "name", value: r.name || "", placeholder: "Rule name", ariaLabel: "Rule name",
      oninput: (e) => { r.name = e.target.value; saveRulesSoon(); } });
    row.append(
      el("input", { type: "checkbox", className: "switch", checked: r.enabled !== false, title: "Rule on/off",
        onchange: (e) => { r.enabled = e.target.checked; row.classList.toggle("off", !r.enabled); saveRulesSoon(); } }),
      el("div", { className: "fields" },
        nameInput, pattern, warn),
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

let saveWrappersTimer;
const saveWrappersSoon = () => {
  clearTimeout(saveWrappersTimer);
  saveWrappersTimer = setTimeout(() => saveSettings({ wrappers: settings.wrappers }).then(updateCount).then(runTest), 300);
};

function renderWrappers(focusIndex) {
  const box = $("wrappers");
  box.replaceChildren();
  if (!settings.wrappers.length) {
    box.append(el("div", { className: "empty", textContent: "No link wrappers of your own. The defaults are listed under Online rulesets." }));
  }
  settings.wrappers.forEach((w, i) => {
    const row = el("div", { className: `wrapper${w.enabled === false ? " off" : ""}` });
    const name = el("input", { type: "text", className: "name", value: w.name || "", placeholder: "Wrapper name", ariaLabel: "Wrapper name",
      oninput: (e) => { w.name = e.target.value; saveWrappersSoon(); } });
    row.append(
      el("input", { type: "checkbox", className: "switch", checked: w.enabled !== false, title: "Wrapper on/off",
        onchange: (e) => { w.enabled = e.target.checked; row.classList.toggle("off", !w.enabled); saveWrappersSoon(); } }),
      el("div", { className: "fields" }, name,
        el("input", { type: "text", className: "pat", value: w.pattern || "", placeholder: "redirect.example.com/go", ariaLabel: "Pattern of the redirect page",
          spellcheck: false, oninput: (e) => { w.pattern = e.target.value.trim(); saveWrappersSoon(); } })),
      el("label", { className: "param", title: "Query parameter that holds the real link" }, "?",
        el("input", { type: "text", value: w.param || "", placeholder: "url", ariaLabel: "Query parameter with the real link",
          spellcheck: false, oninput: (e) => { w.param = e.target.value.trim(); saveWrappersSoon(); } }), "="),
      el("div", { className: "tools" },
        iconButton("trash", "Delete link wrapper", () => { settings.wrappers.splice(i, 1); saveWrappersSoon(); renderWrappers(); }, "danger")),
    );
    box.append(row);
    if (i === focusIndex) setTimeout(() => name.focus());
  });
}

$("addWrapper").onclick = () => {
  settings.wrappers.push({ kind: "unwrap", id: `local-${crypto.randomUUID()}`, name: "", pattern: "", param: "url", enabled: true });
  renderWrappers(settings.wrappers.length - 1);
  saveWrappersSoon();
};

async function renderRulesets() {
  const rulesets = await getRulesets();
  const box = $("rulesets");
  box.replaceChildren();
  for (const url of settings.rulesetUrls) {
    const rs = rulesets[url] || { name: url, rules: [] };
    const nw = rs.rules.filter((r) => r.kind === "unwrap").length, nr = rs.rules.length - nw;
    const parts = [];
    if (nr || !nw) parts.push(`${nr} rule${nr === 1 ? "" : "s"}`);
    if (nw) parts.push(`${nw} link wrapper${nw === 1 ? "" : "s"}`);
    parts.push(rs.fetchedAt ? `updated ${new Date(rs.fetchedAt).toLocaleString()}` : rs.bundled ? "built-in copy, not downloaded yet" : "not downloaded yet");
    const meta = parts.join(" · ");
    const block = el("div", { className: "ruleset" },
      el("div", { className: "rs-head" },
        el("div", { className: "text" },
          el("div", { className: "name" }, rs.name, url in DEFAULT_RULESETS ? el("span", { className: "tag", textContent: "Default" }) : null),
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
        el("div", { className: "act", textContent: r.kind === "unwrap" ? `Link wrapper · real link in ?${r.param}=`
          : r.onMatch === "switch" ? "Just switch" : "Switch and open new URL" }));
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
  const via = k.unwrappedBy ? [el("span", { className: "pill", textContent: "Unwrapped" }),
    el("span", { textContent: `by ${k.unwrappedBy.name || k.unwrappedBy.pattern} to ${k.realUrl}` }), el("br")] : [];
  if (!k.rule) return out.replaceChildren(...via, "No rule matches, so only this exact URL counts as the same page.");
  const group = Object.entries(k.vars || {}).map(([n, v]) => `${n} ${decodeURIComponent(v)}`).join(", ");
  out.replaceChildren(...via,
    el("span", { className: "pill", textContent: "Matches" }),
    el("b", { textContent: k.rule.name || k.rule.pattern }),
    el("span", { textContent: group ? `· one tab per ${group}` : "· one tab for all matching pages" }),
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

const PINNED_DESC = {
  switch: "Opening a page that's pinned takes you to the pinned tab, without changing its page. Pinned tabs are never closed.",
  redirect: "Pinned tabs follow your rules like any other tab, so they can be switched to a newly opened URL. They're never closed.",
  ignore: "Pinned tabs don't count: the same page can open next to them, and they're never switched to or closed.",
};
const GROUPS_DESC = {
  preferSame: "A match in the same group is used first. A match in another group is only switched to, never changed, and Close duplicates keeps one tab per group.",
  separate: "Each group, and tabs outside any group, is deduplicated on its own. The same page can be open once per group.",
  ignore: "Groups make no difference: the most recently used match is used, wherever it is.",
};
function showModes() {
  $("pinnedDesc").textContent = PINNED_DESC[$("pinned").value];
  $("groupsDesc").textContent = GROUPS_DESC[$("groups").value];
}
for (const id of ["pinned", "groups"]) {
  $(id).onchange = async (e) => {
    showModes();
    settings = await saveSettings({ [id]: e.target.value });
    updateCount();
  };
}
$("enabled").onchange = (e) => saveSettings({ paused: !e.target.checked });
$("markers").onchange = async (e) => {
  if (e.target.checked && !(await chrome.permissions.request(ALL_SITES))) {
    e.target.checked = false;
    return;
  }
  settings = await saveSettings({ markers: e.target.checked });
};
$("followRedirects").onchange = (e) => saveSettings({ followRedirects: e.target.checked });
$("burstSeconds").onchange = (e) => {
  const v = Math.min(120, Math.max(0, Math.round(Number(e.target.value) || 0)));
  e.target.value = v;
  saveSettings({ burstSeconds: v });
};
$("aggressive").onchange = async (e) => {
  $("excludeRow").hidden = !e.target.checked;
  settings = await saveSettings({ aggressive: e.target.checked });
  updateCount();
  runTest();
};
$("aggressiveExclude").onchange = async (e) => {
  const hosts = e.target.value.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
  e.target.value = hosts.join(", ");
  settings = await saveSettings({ aggressiveExclude: hosts });
  updateCount();
  runTest();
};

$("exportRules").onclick = () => {
  const json = JSON.stringify(exportRules(settings.rules, settings.wrappers), null, 2);
  const a = el("a", { href: URL.createObjectURL(new Blob([json + "\n"], { type: "application/json" })), download: "tab-dedupe-rules.json" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  const n = settings.rules.length + settings.wrappers.length;
  $("ioStatus").textContent = `Exported ${n} entr${n === 1 ? "y" : "ies"}`;
};
$("importRules").onclick = () => $("importFile").click();
$("importFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const { rules, wrappers, added, skipped } = importRules(settings.rules, settings.wrappers, JSON.parse(await file.text()));
    settings = await saveSettings({ rules, wrappers });
    renderRules();
    renderWrappers();
    updateCount();
    $("ioStatus").textContent = `Imported ${added} entr${added === 1 ? "y" : "ies"}` + (skipped ? `, skipped ${skipped} you already have` : "");
  } catch (err) {
    $("ioStatus").textContent = `Couldn't import: ${err.message}`;
  }
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
  $("pinned").value = settings.pinned;
  $("groups").value = settings.groups;
  showModes();
  $("enabled").checked = !settings.paused;
  $("markers").checked = settings.markers && (await chrome.permissions.contains(ALL_SITES));
  $("refreshHours").value = settings.refreshHours;
  $("followRedirects").checked = settings.followRedirects !== false;
  $("burstSeconds").value = settings.burstSeconds ?? 10;
  $("aggressive").checked = settings.aggressive;
  $("excludeRow").hidden = !settings.aggressive;
  $("aggressiveExclude").value = settings.aggressiveExclude.join(", ");
  renderRules();
  renderWrappers();
  renderRulesets();
  updateCount();
})();
