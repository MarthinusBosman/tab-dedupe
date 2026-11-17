import { getSettings, saveSettings } from "./lib/store.js";

const $ = (id) => document.getElementById(id);

async function showCount() {
  const { count } = await chrome.runtime.sendMessage({ type: "count" });
  $("count").textContent = count === 0 ? "No duplicate tabs." : `${count} duplicate tab${count === 1 ? "" : "s"} can be closed.`;
  $("close").disabled = count === 0;
}

$("close").onclick = async () => {
  const { closed } = await chrome.runtime.sendMessage({ type: "closeDuplicates" });
  $("count").textContent = `Closed ${closed} tab${closed === 1 ? "" : "s"}.`;
  $("close").disabled = true;
};

$("paused").onchange = (e) => saveSettings({ paused: e.target.checked });
$("settings").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

getSettings().then((s) => ($("paused").checked = s.paused));
showCount();
