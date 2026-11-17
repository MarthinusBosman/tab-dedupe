import { getSettings, saveSettings } from "./lib/store.js";

const $ = (id) => document.getElementById(id);

async function showCount() {
  const { count } = await chrome.runtime.sendMessage({ type: "count" });
  $("count").textContent = count === 0 ? "No duplicate tabs" : `${count} duplicate tab${count === 1 ? "" : "s"} open`;
  $("close").disabled = count === 0;
}

function showEnabled(on) {
  $("enabled").checked = on;
  document.body.classList.toggle("paused", !on);
}

$("close").onclick = async () => {
  const { closed } = await chrome.runtime.sendMessage({ type: "closeDuplicates" });
  $("count").textContent = `Closed ${closed} tab${closed === 1 ? "" : "s"}`;
  $("close").disabled = true;
};

$("enabled").onchange = (e) => {
  showEnabled(e.target.checked);
  saveSettings({ paused: !e.target.checked });
};
$("settings").onclick = () => chrome.runtime.openOptionsPage();

getSettings().then((s) => showEnabled(!s.paused));
showCount();
