// End-to-end test in a throwaway Edge profile. Run: node test/e2e.mjs
// Uses a test copy of the extension with <all_urls> granted up front (the 🔁 permission can't be clicked through in automation).
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EXTENSION_FILES } from "../scripts/files.mjs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = process.env.TMPDIR ? path.resolve(process.env.TMPDIR.replace(/^\/c\//, "C:/")) : os.tmpdir();
const WORK = path.join(TMP, "tab-dedupe-e2e");
const EXT = path.join(WORK, "ext");
const PORT = 8765, DBG = 9556;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- test copy of the extension + local web server ----
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(EXT, { recursive: true });
for (const f of EXTENSION_FILES) {
  fs.cpSync(path.join(ROOT, f), path.join(EXT, f), { recursive: true });
}
const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
mf.host_permissions = ["<all_urls>"];
fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify(mf));

const server = http.createServer((req, res) => {
  if (req.url === "/rules.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ name: "E2E online", rules: [{ name: "one rs tab", pattern: `127.0.0.1:${PORT}/rs/*`, onMatch: "navigate" }] }));
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>page ${req.url}</title><a id=l href="/pr/3" style="display:block;width:300px;height:100px">next</a>`);
}).listen(PORT);

const edge = spawn(EDGE, [`--user-data-dir=${path.join(WORK, "profile")}`, `--load-extension=${EXT}`, `--remote-debugging-port=${DBG}`,
  "--no-first-run", "--no-default-browser-check", "--headless=new", "about:blank"], { stdio: "ignore" });

// ---- minimal CDP client ----
let ws, nextId = 1;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json();
      ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.method === "Runtime.consoleAPICalled" && process.env.E2E_DEBUG) console.log("  [sw]", d.params.args.map((a) => a.value ?? a.description).join(" "));
        if (d.id && pending.has(d.id)) {
          const p = pending.get(d.id);
          pending.delete(d.id);
          d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result);
        }
      };
      return;
    } catch { await sleep(500); }
  }
  throw new Error("Edge did not start");
}

let sw, extId;
async function findWorker() {
  for (let i = 0; i < 30; i++) {
    const { targetInfos } = await send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.endsWith("/background.js"))) {
      const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      const name = await evalIn(sessionId, "globalThis.chrome?.runtime?.getManifest?.().name").catch(() => null);
      if (name === "Tab Dedupe") { extId = new URL(t.url).host; return sessionId; }
    }
    await sleep(500);
  }
  throw new Error("extension worker not found");
}
async function evalIn(sessionId, expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const bg = (expr) => evalIn(sw, expr);
const tabs = () => bg(`chrome.tabs.query({}).then(ts => ts.map(t => ({id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId})))`);
const webTabs = async (prefix = BASE) => (await tabs()).filter((t) => t.url.startsWith(prefix));
// chrome.tabs.create carries no openerTabId (like a link from Teams/Outlook); CDP createTarget sets the active tab as opener.
const open = (url) => bg(`chrome.tabs.create({url: ${JSON.stringify(url)}}).then(() => 0)`);
async function setSettings(patch) {
  await bg(`(async () => { const {settings} = await chrome.storage.sync.get("settings");
    await chrome.storage.sync.set({settings: {...settings, ...${JSON.stringify(patch)}}}); })()`);
  await sleep(300);
}
async function attachPage(targetId) {
  return (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
}
async function ctrlClick(targetId) {
  // Waits for the link to be laid out, then ctrl+clicks it; retries if no new tab appeared (headless input can drop).
  const s = await attachPage(targetId);
  await send("Page.bringToFront", {}, s);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = (await tabs()).length;
    const r = await evalIn(s, `new Promise((ok) => { const go = () => { const b = document.getElementById("l").getBoundingClientRect();
      ok({x: b.x + 20, y: b.y + 20}); }; document.readyState === "complete" ? go() : addEventListener("load", go); })`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1, modifiers: 2 }, s);
    }
    await sleep(1500);
    if ((await tabs()).length !== before || !(await send("Target.getTargets")).targetInfos.some((t) => t.targetId === targetId)) return;
    if (attempt === 2) return;
  }
}
const targetFor = async (url) => (await send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url === url)?.targetId;
async function closeAllWeb() {
  for (const t of await webTabs()) await bg(`chrome.tabs.remove(${t.id})`);
  await sleep(300);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

try {
  await connect();
  sw = await findWorker();
  await send("Runtime.enable", {}, sw);
  await sleep(1500);
  const PR = { id: "e2e-pr", name: "one PR tab", pattern: `127.0.0.1:${PORT}/pr/*`, onMatch: "navigate", enabled: true };
  const SW = { id: "e2e-sw", name: "switch", pattern: `127.0.0.1:${PORT}/sw/*`, onMatch: "switch", enabled: true };
  const REPO = { id: "e2e-repo", name: "per repo", pattern: `127.0.0.1:${PORT}/repo/{r}/pr/*`, onMatch: "navigate", enabled: true };
  await setSettings({ rules: [PR, SW, REPO] });
  await sleep(11000); // let the start-up restore guard expire

  // 1. exact duplicate (ignoring #fragment) switches back to the existing tab
  await open(`${BASE}/a`); await sleep(1200);
  await open(`${BASE}/a#frag`); await sleep(1500);
  let t = await webTabs();
  check("exact duplicate: new tab closed, existing tab active", t.length === 1 && t[0].active, JSON.stringify(t));

  // 2. different page is left alone
  await open(`${BASE}/b`); await sleep(1500);
  t = await webTabs();
  check("different URL opens normally", t.length === 2, JSON.stringify(t));
  await closeAllWeb();

  // 3. navigate rule: one PR tab, shows the newly opened PR
  await open(`${BASE}/pr/1`); await sleep(1200);
  await open(`${BASE}/pr/2`); await sleep(2000);
  t = await webTabs(`${BASE}/pr/`);
  check("navigate rule: one PR tab now showing /pr/2", t.length === 1 && t[0].url === `${BASE}/pr/2` && t[0].active, JSON.stringify(t));

  // 4. switch rule keeps the old page
  await open(`${BASE}/sw/1`); await sleep(1200);
  await open(`${BASE}/sw/2`); await sleep(1500);
  t = await webTabs(`${BASE}/sw/`);
  check("switch rule: one tab, still /sw/1", t.length === 1 && t[0].url === `${BASE}/sw/1`, JSON.stringify(t));

  // 5. {name} group: one PR tab per repo
  await open(`${BASE}/repo/x/pr/1`); await sleep(1000);
  await open(`${BASE}/repo/y/pr/1`); await sleep(1000);
  await open(`${BASE}/repo/x/pr/2`); await sleep(1800);
  t = await webTabs(`${BASE}/repo/`);
  check("{repo} rule: one tab per repo", t.length === 2 && t.some((x) => x.url.endsWith("/repo/x/pr/2")) && t.some((x) => x.url.endsWith("/repo/y/pr/1")), JSON.stringify(t));

  // 6. blank new tab, then typing a URL that's already open
  const blank = (await send("Target.createTarget", { url: "about:blank" })).targetId;
  await sleep(800);
  const bs = await attachPage(blank);
  await send("Page.navigate", { url: `${BASE}/sw/1` }, bs); await sleep(1800);
  t = await webTabs(`${BASE}/sw/`);
  const blankGone = !(await send("Target.getTargets")).targetInfos.some((x) => x.targetId === blank);
  check("URL typed into a blank new tab switches to the open one", t.length === 1 && blankGone, JSON.stringify(t));

  // 7. ctrl+click from the only matching tab keeps both (default)
  await ctrlClick(await targetFor(`${BASE}/pr/2`)); await sleep(2000);
  t = await webTabs(`${BASE}/pr/`);
  check("ctrl+click from the matching tab keeps both (keepBoth)", t.length === 2, JSON.stringify(t));

  // 8. markers: both PR tabs get the 🔁 prefix, and it goes when one closes
  await setSettings({ markers: true }); await sleep(2000);
  t = await webTabs(`${BASE}/pr/`);
  check("🔁 marker on duplicate tabs", t.length === 2 && t.every((x) => x.title.startsWith("\u{1F501} ")), JSON.stringify(t.map((x) => x.title)));
  const notDup = (await webTabs()).find((x) => x.url.includes("/sw/1"));
  check("no marker on non-duplicates", notDup && !notDup.title.startsWith("\u{1F501}"), notDup?.title);

  // 9. close duplicates now via the options page (also checks the page loads cleanly)
  const opt = (await send("Target.createTarget", { url: `chrome-extension://${extId}/options.html` })).targetId;
  await sleep(1500);
  const os_ = await attachPage(opt);
  const optRows = await evalIn(os_, "document.querySelectorAll('#rules .rule').length");
  check("options page renders the rules", optRows === 3, String(optRows));
  const count = await evalIn(os_, "chrome.runtime.sendMessage({type: 'count'})");
  check("count reports 1 duplicate", count.count === 1, JSON.stringify(count));
  const closed = await evalIn(os_, "chrome.runtime.sendMessage({type: 'closeDuplicates'})");
  await sleep(1500);
  t = await webTabs(`${BASE}/pr/`);
  check("close duplicates now closes 1 and keeps 1", closed.closed === 1 && t.length === 1, JSON.stringify({ closed, t }));
  check("marker removed once no longer a duplicate", t[0] && !t[0].title.startsWith("\u{1F501}"), t[0]?.title);

  // 10. ctrl+click with applyRule navigates the current tab instead
  await setSettings({ openerSelf: "applyRule" });
  await ctrlClick(await targetFor(t[0].url)); await sleep(2000);
  t = await webTabs(`${BASE}/pr/`);
  check("ctrl+click with applyRule: still one PR tab, now /pr/3", t.length === 1 && t[0].url === `${BASE}/pr/3`, JSON.stringify(t));

  // 11. pause lets duplicates through
  await setSettings({ paused: true });
  await open(`${BASE}/sw/1`); await sleep(1500);
  check("paused: duplicate allowed", (await webTabs(`${BASE}/sw/`)).length === 2);
  await setSettings({ paused: false });
  await closeAllWeb();

  // 12. online ruleset
  await setSettings({ rulesetUrls: [`${BASE}/rules.json`] });
  await evalIn(os_, "chrome.runtime.sendMessage({type: 'refreshRulesets'})");
  const rs = await bg("chrome.storage.local.get('rulesets').then(r => r.rulesets)");
  check("online ruleset downloaded", rs[`${BASE}/rules.json`]?.rules?.length === 1, JSON.stringify(rs));
  await open(`${BASE}/rs/1`); await sleep(1200);
  await open(`${BASE}/rs/2`); await sleep(1800);
  t = await webTabs(`${BASE}/rs/`);
  check("online rule applies", t.length === 1 && t[0].url.endsWith("/rs/2"), JSON.stringify(t));
  const alarm = await bg("chrome.alarms.get('rulesets')");
  check("refresh alarm scheduled every 24h", alarm?.periodInMinutes === 1440, JSON.stringify(alarm));
  const rid = rs[`${BASE}/rules.json`].rules[0].id;
  await setSettings({ disabledRemote: [rid] });
  await open(`${BASE}/rs/3`); await sleep(1500);
  t = await webTabs(`${BASE}/rs/`);
  check("disabled online rule no longer applies", t.length === 2, JSON.stringify(t));

  // 13. pinned tabs: default switches without changing; "redirect" lets the rule change it
  await setSettings({ disabledRemote: [], rulesetUrls: [], openerSelf: "applyRule" });
  await closeAllWeb();
  await open(`${BASE}/pr/1`); await sleep(1200);
  let pinId = (await webTabs(`${BASE}/pr/`))[0].id;
  await bg(`chrome.tabs.update(${pinId}, {pinned: true})`); await sleep(500);
  await open(`${BASE}/pr/2`); await sleep(1800);
  t = await webTabs(`${BASE}/pr/`);
  check("pinned (default): switches to the pinned tab, URL unchanged", t.length === 1 && t[0].id === pinId && t[0].url.endsWith("/pr/1") && t[0].active, JSON.stringify(t));
  await setSettings({ pinned: "redirect" });
  await open(`${BASE}/pr/2`); await sleep(1800);
  t = await webTabs(`${BASE}/pr/`);
  check("pinned redirect: pinned tab now shows /pr/2", t.length === 1 && t[0].id === pinId && t[0].url.endsWith("/pr/2"), JSON.stringify(t));
  await setSettings({ pinned: "switch" });
  await closeAllWeb();

  // 14. groups (default preferSame): a grouped match is only switched to
  await open(`${BASE}/pr/1`); await sleep(1200);
  const grouped = (await webTabs(`${BASE}/pr/`))[0].id;
  await bg(`chrome.tabs.group({tabIds: [${grouped}]}).then(() => 0)`); await sleep(500);
  await open(`${BASE}/pr/2`); await sleep(1800);
  t = await webTabs(`${BASE}/pr/`);
  check("groups preferSame: ungrouped open switches to the grouped tab without changing it", t.length === 1 && t[0].url.endsWith("/pr/1") && t[0].active, JSON.stringify(t));

  // 15. groups separate: ungrouped copy allowed; ctrl+click inside the group stays inside the group
  await setSettings({ groups: "separate" });
  await open(`${BASE}/pr/2`); await sleep(1800);
  t = await webTabs(`${BASE}/pr/`);
  check("groups separate: same page outside the group opens", t.length === 2, JSON.stringify(t));
  await ctrlClick(await targetFor(`${BASE}/pr/1`)); await sleep(1500);
  const info = await bg(`chrome.tabs.query({}).then(ts => ts.filter(x => x.url.includes("/pr/")).map(x => ({id: x.id, url: x.url, groupId: x.groupId})))`);
  const inGroup = info.filter((x) => x.groupId !== -1), outside = info.filter((x) => x.groupId === -1);
  check("groups separate: ctrl+click in the group navigates the grouped tab, not the ungrouped one",
    info.length === 2 && inGroup.length === 1 && inGroup[0].url.endsWith("/pr/3") && outside[0]?.url.endsWith("/pr/2"), JSON.stringify(info));
  const cnt = await evalIn(os_, "chrome.runtime.sendMessage({type: 'count'})");
  check("groups separate: no duplicates counted across groups", cnt.count === 0, JSON.stringify(cnt));
  await setSettings({ groups: "preferSame" });

  // 16. popup renders
  const pop = (await send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` })).targetId;
  await sleep(1200);
  const ps = await attachPage(pop);
  const popText = await evalIn(ps, "document.getElementById('close').textContent + ' | ' + document.getElementById('count').textContent");
  check("popup renders", popText.startsWith("Close duplicates now |") && !popText.includes("Counting"), popText);
} catch (e) {
  check("run", false, e.stack);
} finally {
  try { await send("Browser.close"); } catch {}
  server.close();
  setTimeout(() => edge.kill(), 1000);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 1500);
}
