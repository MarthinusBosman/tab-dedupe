// Probe: which events/fields distinguish ctrl+click, "Duplicate tab", and a link sent in from another app?
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EXTENSION_FILES } from "../scripts/files.mjs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = path.resolve(import.meta.dirname, "..");
const WORK = path.join(os.tmpdir(), "tab-dedupe-probe");
const EXT = path.join(WORK, "ext");
const PROFILE = path.join(WORK, "profile");
const PORT = 8770, DBG = 9560, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(EXT, { recursive: true });
for (const f of EXTENSION_FILES) fs.cpSync(path.join(ROOT, f), path.join(EXT, f), { recursive: true });
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>${req.url}</title><a id=l href="/clicked" style="display:block;width:300px;height:100px">link</a>`);
}).listen(PORT);
const headless = process.argv.includes("--visible") ? [] : ["--headless=new"];
const edge = spawn(EDGE, [`--user-data-dir=${PROFILE}`, `--load-extension=${EXT}`, `--remote-debugging-port=${DBG}`,
  "--no-first-run", "--no-default-browser-check", ...headless, `${BASE}/start`], { stdio: "ignore" });

let ws, nextId = 1;
const pending = new Map();
const send = (method, params = {}, sessionId) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
for (let i = 0; i < 40 && !ws; i++) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json();
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
  } catch { ws = null; await sleep(500); }
}
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  const p = d.id && pending.get(d.id);
  if (p) { pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
};
const evalIn = async (s, expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
let sw;
for (let i = 0; i < 30 && !sw; i++) {
  const { targetInfos } = await send("Target.getTargets");
  for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.endsWith("/background.js"))) {
    const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    if ((await evalIn(sessionId, "globalThis.chrome?.runtime?.getManifest?.().name").catch(() => null)) === "Tab Dedupe") sw = sessionId;
  }
  if (!sw) await sleep(500);
}
// Pause the extension itself so it doesn't close anything; just log events.
await evalIn(sw, `chrome.storage.sync.get("settings").then(({settings}) => chrome.storage.sync.set({settings: {...settings, paused: true}}))`);
await evalIn(sw, `(() => {
  const t0 = Date.now(); globalThis.__log = [];
  const L = (...a) => __log.push([Date.now() - t0, ...a]);
  chrome.tabs.onCreated.addListener((t) => L("tabs.onCreated", t.id, { opener: t.openerTabId, index: t.index, url: t.pendingUrl || t.url, active: t.active }));
  chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => L("onCreatedNavigationTarget", d.tabId, { source: d.sourceTabId, url: d.url }));
  chrome.webNavigation.onBeforeNavigate.addListener((d) => d.frameId === 0 && L("onBeforeNavigate", d.tabId, { url: d.url }));
  chrome.webNavigation.onCommitted.addListener((d) => d.frameId === 0 && L("onCommitted", d.tabId, { type: d.transitionType, q: d.transitionQualifiers, url: d.url }));
  chrome.windows.onFocusChanged.addListener((w) => L("windows.onFocusChanged", w));
  return true;
})()`);
await sleep(1500);
const startTab = (await evalIn(sw, `chrome.tabs.query({}).then(ts => ts.find(t => t.url.endsWith("/start")).id)`));
const mark = (label) => evalIn(sw, `__log.push(["----", ${JSON.stringify(label)}]) && 0`);

await mark("ctrl+click in /start");
const { targetInfos } = await send("Target.getTargets");
const startTarget = targetInfos.find((t) => t.type === "page" && t.url.endsWith("/start")).targetId;
const ps = (await send("Target.attachToTarget", { targetId: startTarget, flatten: true })).sessionId;
await send("Page.bringToFront", {}, ps);
await sleep(300);
for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: 40, y: 30, button: "left", clickCount: 1, modifiers: 2 }, ps);
await sleep(2000);

await mark("chrome.tabs.duplicate(/start)");
await evalIn(sw, `chrome.tabs.duplicate(${startTab}).then(() => 0)`);
await sleep(2000);

await mark("external: second msedge.exe with URL");
spawn(EDGE, [`--user-data-dir=${PROFILE}`, ...headless, `${BASE}/external`], { stdio: "ignore" });
await sleep(4000);

await mark("CDP Target.createTarget");
await send("Target.createTarget", { url: `${BASE}/cdp` });
await sleep(2000);

await mark("chrome.tabs.create");
await evalIn(sw, `chrome.tabs.create({url: "${BASE}/api"}).then(() => 0)`);
await sleep(2000);

for (const row of await evalIn(sw, "__log")) console.log(JSON.stringify(row));
try { await send("Browser.close"); } catch {}
server.close();
setTimeout(() => { edge.kill(); process.exit(0); }, 800);
