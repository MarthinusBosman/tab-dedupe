// Uploads a zip to the existing Edge Add-ons product and submits it for certification (Edge Add-ons Update API v1.1).
// Env: EDGE_CLIENT_ID, EDGE_API_KEY, EDGE_PRODUCT_ID.  Usage: node scripts/publish-edge.mjs dist/tab-dedupe-1.0.1.zip
// The first version must be submitted by hand in Partner Center; the API can only update an existing product.
// API keys expire every 72 days: create a new one under Partner Center > Microsoft Edge > Publish API.
import fs from "node:fs";

const API = "https://api.addons.microsoftedge.microsoft.com/v1";
const { EDGE_CLIENT_ID: clientId, EDGE_API_KEY: apiKey, EDGE_PRODUCT_ID: productId } = process.env;
const zipPath = process.argv[2];
if (!clientId || !apiKey || !productId || !zipPath) {
  console.error("Need EDGE_CLIENT_ID, EDGE_API_KEY, EDGE_PRODUCT_ID and a zip path");
  process.exit(2);
}
const headers = { Authorization: `ApiKey ${apiKey}`, "X-ClientID": clientId };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body, contentType) {
  const res = await fetch(`${API}${url}`, { method, body, headers: { ...headers, ...(contentType ? { "Content-Type": contentType } : {}) } });
  if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}: API key or client ID rejected (keys expire every 72 days)`);
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

async function waitFor(url, what) {
  for (let i = 0; i < 60; i++) {
    const op = await (await call("GET", url)).json();
    if (op.status === "Succeeded") return op;
    if (op.status === "Failed") {
      throw new Error(`${what} failed: ${op.errorCode} ${op.message} ${JSON.stringify(op.errors || [])}`);
    }
    await sleep(5000);
  }
  throw new Error(`${what}: still in progress after 5 minutes`);
}

const upload = await call("POST", `/products/${productId}/submissions/draft/package`, fs.readFileSync(zipPath), "application/zip");
const uploadOp = upload.headers.get("Location");
console.log(`Uploaded ${zipPath}, operation ${uploadOp}`);
await waitFor(`/products/${productId}/submissions/draft/package/operations/${uploadOp}`, "Package upload");
console.log("Package accepted into the draft.");

const notes = process.env.EDGE_CERT_NOTES || "Update from the GitHub release workflow. No remote code; online rulesets are JSON data only.";
const submit = await call("POST", `/products/${productId}/submissions`, notes, "text/plain");
const submitOp = submit.headers.get("Location");
await waitFor(`/products/${productId}/submissions/operations/${submitOp}`, "Submission");
console.log("Submitted for certification (can take up to 7 business days).");
