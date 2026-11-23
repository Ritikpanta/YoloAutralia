// Read and update stock in the Yolo_StockRecord Google Sheet through a service account.
// No SDK: signs the OAuth JWT with node:crypto and calls the Sheets REST API with fetch.
import crypto from "node:crypto";
import { SHOP } from "./shop-config.js";

const SIZES = [39, 40, 41, 42, 43];
let cachedToken = null;

export function sheetsConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  const sa = JSON.parse(raw);
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  return sa;
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function accessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
  }));
  const sig = crypto.createSign("RSA-SHA256").update(`${header}.${claim}`).sign(sa.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${header}.${claim}.${b64url(sig)}`
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google auth failed: ${data.error_description || data.error || res.status}`);
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function gapi(path, options = {}) {
  const sheetId = process.env.STOCK_SHEET_ID || SHOP.stockSheet.id;
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets ${path}: ${data?.error?.message || res.status}`);
  return data;
}

const norm = (s) => String(s || "").trim().toLowerCase();
const colLetter = (i) => { let s = ""; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// Returns { rows: [{rowNumber, model, colourway, sizes:{39:n..}, bulk}], cols }
export async function readInventory() {
  const tab = SHOP.stockSheet.tab;
  const data = await gapi(`/values/${encodeURIComponent(`'${tab}'!A1:Z400`)}?valueRenderOption=UNFORMATTED_VALUE`);
  const values = data.values || [];
  const head = (values[0] || []).map((h) => norm(h));
  const idx = (name) => head.indexOf(norm(name));
  const cols = { model: idx("Model"), colourway: idx("Colourway"), bulk: idx("Bulk") };
  SIZES.forEach((s) => { cols[s] = idx(String(s)); });
  if (cols.model < 0 || cols.colourway < 0 || SIZES.some((s) => cols[s] < 0)) throw new Error(`Stock sheet headers not found in '${tab}'`);
  const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
  const rows = [];
  values.slice(1).forEach((r, i) => {
    const model = r[cols.model];
    if (!model || norm(model) === "total") return;
    const sizes = {};
    SIZES.forEach((s) => { sizes[s] = num(r[cols[s]]); });
    rows.push({ rowNumber: i + 2, model: String(model).trim(), colourway: String(r[cols.colourway] || "").trim(), sizes, bulk: cols.bulk >= 0 ? num(r[cols.bulk]) : 0 });
  });
  return { rows, cols };
}

export function findRow(inv, ref) {
  return inv.rows.find((r) => norm(r.model) === norm(ref.model) && norm(r.colourway) === norm(ref.colourway));
}

// How many pairs can be sold for this row/size. Rows with no per-size counts use the Bulk column.
export function available(row, size) {
  if (!row) return 0;
  const sized = Object.values(row.sizes).some((n) => n > 0);
  return sized ? row.sizes[size] || 0 : row.bulk;
}

// Decrement stock for paid items. items: [{ref:{model,colourway}, size, qty}]
// Returns notes for anything that couldn't be fully deducted (oversold).
export async function decrementStock(items) {
  const inv = await readInventory();
  const tab = SHOP.stockSheet.tab;
  const pending = new Map(); // "row:col" -> {range, value}
  const notes = [];
  for (const it of items) {
    const row = findRow(inv, it.ref);
    if (!row) { notes.push(`No stock row for ${it.ref.model} / ${it.ref.colourway}`); continue; }
    const sized = Object.values(row.sizes).some((n) => n > 0);
    const col = sized ? inv.cols[it.size] : inv.cols.bulk;
    if (col < 0) { notes.push(`No Bulk column for ${row.model}`); continue; }
    const current = sized ? row.sizes[it.size] : row.bulk;
    const next = Math.max(0, current - it.qty);
    if (current < it.qty) notes.push(`OVERSOLD ${row.model} ${row.colourway} EU${it.size}: had ${current}, sold ${it.qty}`);
    if (sized) row.sizes[it.size] = next; else row.bulk = next;
    pending.set(`${row.rowNumber}:${col}`, { range: `'${tab}'!${colLetter(col)}${row.rowNumber}`, values: [[next]] });
  }
  if (pending.size) {
    await gapi(`/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: [...pending.values()] }) });
  }
  return notes;
}

// ---- Order log tab (also used to make webhook processing idempotent) ----
const ORDER_HEADERS = ["Date (Sydney)", "Stripe session", "Name", "Email", "Phone", "Ship to", "Items", "Total (AUD)", "Stock updated", "Notes"];

async function ensureOrdersTab() {
  const tab = SHOP.stockSheet.ordersTab;
  const meta = await gapi(`?fields=sheets.properties.title`);
  if ((meta.sheets || []).some((s) => s.properties.title === tab)) return;
  await gapi(`:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) });
  await gapi(`/values/${encodeURIComponent(`'${tab}'!A1`)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [ORDER_HEADERS] }) });
}

export async function orderAlreadyLogged(sessionId) {
  await ensureOrdersTab();
  const tab = SHOP.stockSheet.ordersTab;
  const data = await gapi(`/values/${encodeURIComponent(`'${tab}'!B:B`)}`);
  return (data.values || []).some((r) => r[0] === sessionId);
}

export async function logOrder(row) {
  await ensureOrdersTab();
  const tab = SHOP.stockSheet.ordersTab;
  await gapi(`/values/${encodeURIComponent(`'${tab}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST", body: JSON.stringify({ values: [row] })
  });
}
