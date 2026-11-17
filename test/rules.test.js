import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl, compilePattern, keyFor, decideNewTab, planDuplicates, validateRuleset,
} from "../lib/rules.js";

const PR_ONE = { id: "pr", pattern: "dev.azure.com/*/*/_git/*/pullrequest/*", onMatch: "navigate", enabled: true };
const PR_PER_REPO = { id: "repo", pattern: "dev.azure.com/*/*/_git/{repo}/pullrequest/*", onMatch: "navigate", enabled: true };
const PR_SWITCH = { ...PR_ONE, id: "prs", onMatch: "switch" };
const DEFAULTS = { paused: false, openerSelf: "keepBoth" };
const ADO = "https://dev.azure.com/m-kopa/Data%20Services/_git";

const tab = (id, url, extra = {}) => ({ id, url, windowId: 1, pinned: false, incognito: false, lastAccessed: id, ...extra });

test("normalizeUrl ignores fragment, trailing slash, scheme; keeps query", () => {
  assert.equal(normalizeUrl("https://Example.com/a/b/#x"), "example.com/a/b");
  assert.equal(normalizeUrl("http://example.com/a/b"), "example.com/a/b");
  assert.equal(normalizeUrl("https://example.com/"), "example.com");
  assert.equal(normalizeUrl("https://example.com/a?q=1#y"), "example.com/a?q=1");
  assert.notEqual(normalizeUrl("https://example.com/a?q=1"), normalizeUrl("https://example.com/a?q=2"));
  assert.equal(normalizeUrl("edge://settings"), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("pattern: * ignores a segment, trailing part and query are ignored", () => {
  const p = compilePattern(PR_ONE.pattern);
  assert.ok(p.match(`${ADO}/dbt/pullrequest/123`));
  assert.ok(p.match(`${ADO}/dbt/pullrequest/123/files?_a=files#c`));
  assert.ok(!p.match(`${ADO}/dbt/pullrequests`));
  assert.ok(!p.match(`${ADO}/dbt/pullrequest`));
  assert.ok(!p.match("https://example.com/dev.azure.com/a/b/_git/c/pullrequest/1"));
});

test("pattern accepts an explicit scheme and is case-insensitive", () => {
  const p = compilePattern("https://DEV.azure.com/m-kopa/*");
  assert.ok(p.match("https://dev.azure.com/M-KOPA/x"));
});

test("pattern with ? matches against the query", () => {
  const p = compilePattern("example.com/view?id={id}");
  assert.deepEqual(p.match("https://example.com/view?id=7&x=1"), ["7"]);
  assert.equal(p.match("https://example.com/view"), null);
});

test("keyFor: one PR tab vs one per repo vs default exact key", () => {
  const rules = [PR_ONE];
  assert.equal(keyFor(`${ADO}/dbt/pullrequest/1`, rules).key, keyFor(`${ADO}/other/pullrequest/2`, rules).key);
  const per = [PR_PER_REPO];
  assert.equal(keyFor(`${ADO}/dbt/pullrequest/1`, per).key, keyFor(`${ADO}/DBT/pullrequest/2`, per).key);
  assert.notEqual(keyFor(`${ADO}/dbt/pullrequest/1`, per).key, keyFor(`${ADO}/other/pullrequest/1`, per).key);
  const d = keyFor("https://example.com/a#x", rules);
  assert.equal(d.rule, null);
  assert.equal(d.key, keyFor("http://example.com/a/", rules).key);
});

test("keyFor: first enabled rule wins, disabled rules skipped", () => {
  const off = { ...PR_ONE, enabled: false };
  assert.equal(keyFor(`${ADO}/dbt/pullrequest/1`, [off, PR_PER_REPO]).rule.id, "repo");
});

test("decideNewTab: exact duplicate switches and closes the new tab", () => {
  const tabs = [tab(1, "https://example.com/a"), tab(2, "https://example.com/a#top")];
  assert.deepEqual(decideNewTab(tabs[1], tabs, [], DEFAULTS), { action: "switch", targetId: 1 });
});

test("decideNewTab: no match -> none", () => {
  const tabs = [tab(1, "https://example.com/a"), tab(2, "https://example.com/b")];
  assert.equal(decideNewTab(tabs[1], tabs, [], DEFAULTS).action, "none");
});

test("decideNewTab: rule navigate loads the new URL in the existing tab", () => {
  const tabs = [tab(1, `${ADO}/dbt/pullrequest/1`), tab(2, `${ADO}/x/pullrequest/2`)];
  assert.deepEqual(decideNewTab(tabs[1], tabs, [PR_ONE], DEFAULTS),
    { action: "navigate", targetId: 1, url: `${ADO}/x/pullrequest/2` });
});

test("decideNewTab: navigate rule but identical page just switches", () => {
  const tabs = [tab(1, `${ADO}/dbt/pullrequest/1`), tab(2, `${ADO}/dbt/pullrequest/1#c`)];
  assert.equal(decideNewTab(tabs[1], tabs, [PR_ONE], DEFAULTS).action, "switch");
});

test("decideNewTab: rule switch keeps the existing tab's page", () => {
  const tabs = [tab(1, `${ADO}/dbt/pullrequest/1`), tab(2, `${ADO}/x/pullrequest/2`)];
  assert.deepEqual(decideNewTab(tabs[1], tabs, [PR_SWITCH], DEFAULTS), { action: "switch", targetId: 1 });
});

test("decideNewTab: picks the most recently used match", () => {
  const tabs = [tab(1, "https://e.com/a", { lastAccessed: 50 }), tab(3, "https://e.com/a", { lastAccessed: 90 }), tab(4, "https://e.com/a")];
  assert.equal(decideNewTab(tabs[2], tabs, [], DEFAULTS).targetId, 3);
});

test("decideNewTab: ctrl+click from the only matching tab keeps both by default", () => {
  const tabs = [tab(1, `${ADO}/dbt/pullrequest/1`), tab(2, `${ADO}/x/pullrequest/2`, { openerTabId: 1 })];
  assert.equal(decideNewTab(tabs[1], tabs, [PR_ONE], DEFAULTS).action, "keep");
  assert.equal(decideNewTab(tabs[1], tabs, [PR_ONE], { ...DEFAULTS, openerSelf: "applyRule" }).action, "navigate");
});

test("decideNewTab: ctrl+click from opener but another matching tab exists -> use the other", () => {
  const tabs = [tab(1, `${ADO}/dbt/pullrequest/1`), tab(5, `${ADO}/y/pullrequest/9`, { lastAccessed: 0 }),
    tab(2, `${ADO}/x/pullrequest/2`, { openerTabId: 1 })];
  assert.deepEqual(decideNewTab(tabs[2], tabs, [PR_ONE], DEFAULTS),
    { action: "navigate", targetId: 5, url: `${ADO}/x/pullrequest/2` });
});

test("decideNewTab: paused, pinned, incognito are ignored", () => {
  const a = tab(1, "https://e.com/a"), b = tab(2, "https://e.com/a");
  assert.equal(decideNewTab(b, [a, b], [], { ...DEFAULTS, paused: true }).action, "none");
  assert.equal(decideNewTab(b, [{ ...a, pinned: true }, b], [], DEFAULTS).action, "none");
  assert.equal(decideNewTab({ ...b, incognito: true }, [a, b], [], DEFAULTS).action, "none");
  assert.equal(decideNewTab(b, [{ ...a, incognito: true }, b], [], DEFAULTS).action, "none");
});

test("planDuplicates: keeps the most recently used tab per group", () => {
  const tabs = [
    tab(1, "https://e.com/a", { lastAccessed: 10 }), tab(2, "https://e.com/a/", { lastAccessed: 30 }),
    tab(3, "https://e.com/a#z", { lastAccessed: 20 }), tab(4, "https://e.com/b"),
    tab(5, `${ADO}/dbt/pullrequest/1`, { lastAccessed: 5 }), tab(6, `${ADO}/x/pullrequest/2`, { lastAccessed: 6 }),
    tab(7, "https://e.com/a", { pinned: true }), tab(8, "edge://settings"),
  ];
  const p = planDuplicates(tabs, [PR_ONE]);
  assert.deepEqual(p.closeIds.sort(), [1, 3, 5]);
  assert.deepEqual([...p.duplicateIds].sort(), [1, 2, 3, 5, 6]);
});

test("shipped rulesets/azure-devops.json is valid and matches real ADO URLs", async () => {
  const fs = await import("node:fs");
  const src = "https://raw.githubusercontent.com/x/y/main/rulesets/azure-devops.json";
  const { rules } = validateRuleset(JSON.parse(fs.readFileSync(new URL("../rulesets/azure-devops.json", import.meta.url))), src);
  assert.equal(rules.length, 3);
  const k = (u) => keyFor(u, rules)?.key;
  assert.equal(k(`${ADO}/dbt/pullrequest/1?_a=files`), k(`${ADO}/other/pullrequest/2`));
  assert.equal(k("https://dev.azure.com/m-kopa/Proj/_workitems/edit/1"), k("https://dev.azure.com/m-kopa/Proj/_workitems/edit/2"));
  assert.equal(k("https://dev.azure.com/m-kopa/Proj/_build/results?buildId=1&view=logs"), k("https://dev.azure.com/m-kopa/Proj/_build/results?buildId=2"));
  assert.notEqual(k(`${ADO}/dbt/pullrequest/1`), k("https://dev.azure.com/m-kopa/Proj/_workitems/edit/1"));
  assert.equal(keyFor(`${ADO}/dbt/pullrequests`, rules).rule, null);
});

test("validateRuleset: accepts good rules, rejects junk, fills defaults", () => {
  const r = validateRuleset({ name: "ADO", rules: [{ name: "PR", pattern: "dev.azure.com/*" }, { pattern: 5 }, { pattern: "a", onMatch: "bogus" }] }, "https://x/r.json");
  assert.equal(r.name, "ADO");
  assert.equal(r.rules.length, 2);
  assert.equal(r.rules[0].onMatch, "navigate");
  assert.equal(r.rules[1].onMatch, "navigate");
  assert.equal(r.rules[0].id, "https://x/r.json#dev.azure.com/*");
  assert.throws(() => validateRuleset({ rules: "nope" }, "u"));
});
