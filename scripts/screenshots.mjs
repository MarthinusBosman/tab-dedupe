// Screenshots of the options page and popup (light + dark) in headless Edge, with realistic sample state.
// Run: node scripts/screenshots.mjs [outDir]   (default: store/screenshots)
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EXTENSION_FILES } from "./files.mjs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "store", "screenshots"));
const WORK = path.join(os.tmpdir(), "tab-dedupe-shots");
const EXT = path.join(WORK, "ext");
const PORT = 8766, DBG = 9557;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(EXT, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of EXTENSION_FILES) fs.cpSync(path.join(ROOT, f), path.join(EXT, f), { recursive: true });

const server = http.createServer((req, res) => {
  if (req.url === "/rules.json") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    return res.end(fs.readFileSync(path.join(ROOT, "rulesets", "azure-devops.json")));
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<title>${req.url}</title>`);
}).listen(PORT);

const edge = spawn(EDGE, [`--user-data-dir=${path.join(WORK, "profile")}`, `--load-extension=${EXT}`, `--remote-debugging-port=${DBG}`,
  "--no-first-run", "--no-default-browser-check", "--headless=new", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

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

let sw, extId;
for (let i = 0; i < 30 && !sw; i++) {
  const { targetInfos } = await send("Target.getTargets");
  for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.endsWith("/background.js"))) {
    const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    if ((await evalIn(sessionId, "globalThis.chrome?.runtime?.getManifest?.().name").catch(() => null)) === "Tab Dedupe") {
      sw = sessionId; extId = new URL(t.url).host;
    }
  }
  if (!sw) await sleep(500);
}
await sleep(1500);

// Sample state: a couple of rules, the ADO ruleset, and some duplicate tabs.
const rulesUrl = `http://127.0.0.1:${PORT}/rules.json`;
await evalIn(sw, `(async () => {
  const {settings} = await chrome.storage.sync.get("settings");
  settings.rules = [settings.rules[0],
    {id: "s2", name: "GitHub: one tab per repo's PRs", pattern: "github.com/{owner}/{repo}/pull/*", onMatch: "navigate", enabled: true},
    {id: "s3", name: "Databricks notebooks", pattern: "adb-*.azuredatabricks.net/editor/notebooks/*", onMatch: "switch", enabled: false}];
  settings.rulesetUrls = [${JSON.stringify(rulesUrl)}];
  settings.paused = true;
  await chrome.storage.sync.set({settings});
})()`);
await sleep(800);
await evalIn(sw, `(async () => {
  const {settings} = await chrome.storage.sync.get("settings");
  for (const p of ["/a", "/a", "/b", "/b", "/c"]) await chrome.tabs.create({url: "http://127.0.0.1:${PORT}" + p, active: false});
  settings.paused = false;
  await chrome.storage.sync.set({settings});
})()`);
await sleep(1500);
await evalIn(sw, "chrome.storage.local.get('rulesets')"); // wait for the ruleset download triggered by the settings change
await sleep(1500);

async function shot(url, name, { width, height, full }) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const s = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  for (const scheme of ["light", "dark"]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, s);
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, s);
    await send("Page.navigate", { url }, s);
    await sleep(1800);
    if (name === "options") await evalIn(s, `(async () => { const i = document.getElementById("testUrl");
      i.value = "https://dev.azure.com/m-kopa/Data%20Services/_git/dbt/pullrequest/4821?_a=files"; i.dispatchEvent(new Event("input")); })()`);
    await sleep(500);
    let clip;
    if (full) {
      const h = await evalIn(s, "Math.ceil(document.documentElement.scrollHeight)");
      await send("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: false }, s);
      await sleep(300);
    } else if (name === "popup") {
      const b = await evalIn(s, "(() => { const r = document.body.getBoundingClientRect(); return {w: Math.ceil(r.width), h: Math.ceil(r.height)}; })()");
      clip = { x: 0, y: 0, width: b.w, height: b.h, scale: 1 };
    }
    const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) }, s);
    const file = path.join(OUT, `${name}-${scheme}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(file);
  }
}

try {
  await shot(`chrome-extension://${extId}/options.html`, "options", { width: 1280, height: 800, full: true });
  await shot(`chrome-extension://${extId}/popup.html`, "popup", { width: 400, height: 400 });
} finally {
  try { await send("Browser.close"); } catch {}
  server.close();
  setTimeout(() => { edge.kill(); process.exit(0); }, 800);
}
