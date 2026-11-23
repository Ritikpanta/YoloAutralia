// Offline tests for the checkout, stock and webhook functions (Stripe + Google mocked).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "bot@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
process.env.STRIPE_SECRET_KEY = "sk_test_x";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.SITE_URL = "https://yolo.example";

// --- fake Google Sheet + Stripe ---
let sheet, orders, stripeCalls, tabs;
function resetSheet() {
  sheet = [
    ["Model", "Colourway", "Base Colour", "Category", "39", "40", "41", "42", "43", "Bulk", "Total Pairs"],
    ["Odin", "Patent Tan", "Tan", "Loafers & Dress", 1, 1, 1, 1, "", "", 4],
    ["Odin", "Black", "Black", "Loafers & Dress", "", "", 1, "", 1, "", 2],
    ["Chelsea Boot", "All Colours", "Assorted", "Boots", "", "", "", "", "", 2, 2],
    ["TOTAL", "", "", "", 99, 99, 99, 99, 99, 99, 99]
  ];
  orders = []; stripeCalls = []; tabs = ["Master Inventory"];
}
const colIdx = (L) => L.charCodeAt(0) - 65;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
  if (u.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "tok", expires_in: 3600 });
  if (u.startsWith("https://api.stripe.com/v1/checkout/sessions")) { stripeCalls.push(decodeURIComponent(opts.body)); return ok({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }); }
  if (u.includes("sheets.googleapis.com")) {
    const path = decodeURIComponent(u.split("/spreadsheets/")[1].replace(/^[^/?:]+/, ""));
    if (path.startsWith("?fields")) return ok({ sheets: tabs.map((t) => ({ properties: { title: t } })) });
    if (path.startsWith(":batchUpdate")) { tabs.push(JSON.parse(opts.body).requests[0].addSheet.properties.title); return ok({}); }
    if (path.includes("'Master Inventory'!A1:Z400")) return ok({ values: sheet });
    if (path.startsWith("/values:batchUpdate")) {
      for (const d of JSON.parse(opts.body).data) { const m = d.range.match(/!([A-Z])(\d+)$/); sheet[Number(m[2]) - 1][colIdx(m[1])] = d.values[0][0]; }
      return ok({});
    }
    if (path.includes("'Web Orders'!B:B")) return ok({ values: orders.map((r) => [r[1]]) });
    if (path.includes("'Web Orders'!A1:append")) { orders.push(...JSON.parse(opts.body).values); return ok({}); }
    if (path.includes("'Web Orders'!A1?")) return ok({});
  }
  throw new Error("unexpected fetch " + u);
};

const { POST: checkout } = await import("../api/checkout.js");
const { GET: stock } = await import("../api/stock.js");
const { POST: webhook } = await import("../api/stripe-webhook.js");
const { formEncode } = await import("../lib/stripe.js");
const req = (items) => new Request("https://yolo.example/api/checkout", { method: "POST", body: JSON.stringify({ items }) });

beforeEach(resetSheet);

test("checkout prices from the catalogue, adds flat shipping under the threshold", async () => {
  const res = await checkout(req([{ slug: "odin", colour: "patent-tan", size: 41, qty: 1, unit: 1 }]));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, "https://checkout.stripe.com/c/cs_1");
  const body = stripeCalls[0];
  assert.match(body, /line_items\[0\]\[price_data\]\[unit_amount\]=9000/);   // A$90, browser "unit" ignored
  assert.match(body, /fixed_amount\]\[amount\]=1200/);                       // A$12 shipping
  assert.match(body, /metadata\[l0\]=odin\|patent-tan\|41\|1\|/);
  assert.match(body, /allowed_countries\]\[0\]=AU/);
});

test("free shipping at or over A$150", async () => {
  const res = await checkout(req([{ slug: "odin", colour: "patent-tan", size: 40, qty: 1 }, { slug: "odin", colour: "patent-tan", size: 41, qty: 1 }]));
  assert.equal(res.status, 200);
  assert.match(stripeCalls[0], /fixed_amount\]\[amount\]=0&/);
});

test("rejects sizes that are out of stock in the sheet", async () => {
  const res = await checkout(req([{ slug: "odin", colour: "black", size: 40, qty: 1 }]));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /sold out/);
});

test("rejects more than available, summed across duplicate lines", async () => {
  const res = await checkout(req([{ slug: "odin", colour: "patent-tan", size: 39, qty: 1 }, { slug: "odin", colour: "patent-tan", size: 39, qty: 1 }]));
  assert.equal(res.status, 409);
});

test("bulk rows (no size counts) use the Bulk column", async () => {
  assert.equal((await checkout(req([{ slug: "atlas-chelseaboots", size: 42, qty: 2, note: "Matte black" }]))).status, 200);
  assert.equal((await checkout(req([{ slug: "atlas-chelseaboots", size: 42, qty: 3 }]))).status, 409);
});

test("validation errors", async () => {
  assert.equal((await checkout(req([]))).status, 400);
  assert.equal((await checkout(req([{ slug: "odin", colour: "nope", size: 41, qty: 1 }]))).status, 400);
  assert.equal((await checkout(req([{ slug: "odin", colour: "black", size: 44, qty: 1 }]))).status, 400);
  assert.equal((await checkout(req([{ slug: "odin", colour: "black", size: 41, qty: 9 }]))).status, 400);
  assert.equal((await checkout(req([{ slug: "fake", size: 41, qty: 1 }]))).status, 400);
});

test("stock endpoint returns live sizes", async () => {
  const r = await (await stock(new Request("https://yolo.example/api/stock?slug=odin"))).json();
  assert.equal(r.live, true);
  assert.deepEqual(r.colours.black, { 39: 0, 40: 0, 41: 1, 42: 0, 43: 1 });
});

function signed(event, secret = "whsec_test") {
  const body = JSON.stringify(event); const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return new Request("https://yolo.example/api/stripe-webhook", { method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${v1}` } });
}
const paidEvent = (id = "cs_paid") => ({ type: "checkout.session.completed", data: { object: {
  id, created: 1764000000, payment_status: "paid", amount_total: 9000 + 1200,
  metadata: { source: "yolo-au-web", lines: "2", l0: "odin|patent-tan|41|1|", l1: "atlas-chelseaboots||42|1|Matte black" },
  customer_details: { name: "Sam Test", email: "sam@example.com", phone: "+61400000000" },
  shipping_details: { name: "Sam Test", address: { line1: "1 George St", city: "Sydney", state: "NSW", postal_code: "2000", country: "AU" } }
} } });

test("webhook rejects bad signatures", async () => {
  assert.equal((await webhook(signed(paidEvent(), "whsec_wrong"))).status, 400);
});

test("webhook logs the order, decrements stock once, and is idempotent", async () => {
  assert.equal((await webhook(signed(paidEvent()))).status, 200);
  assert.equal(sheet[1][6], 0);           // Odin Patent Tan EU41: 1 -> 0
  assert.equal(sheet[3][9], 1);           // Chelsea Boot bulk: 2 -> 1
  assert.ok(tabs.includes("Web Orders"));
  assert.equal(orders.length, 1);
  assert.match(orders[0][6], /1× Odin Patent Tan EU41; 1× Atlas Chelsea Boot Matte black EU42/);
  // Stripe retries the same event
  assert.equal((await webhook(signed(paidEvent()))).status, 200);
  assert.equal(sheet[1][6], 0); assert.equal(sheet[3][9], 1); assert.equal(orders.length, 1);
});

test("webhook notes oversells instead of going negative", async () => {
  sheet[1][6] = 0;
  await webhook(signed(paidEvent("cs_over")));
  assert.equal(sheet[1][6], 0);
  assert.ok(orders.some((r) => /OVERSOLD/.test(r[9])));
});

test("form encoding for Stripe", () => {
  assert.equal(decodeURIComponent(formEncode({ a: { b: [{ c: 1 }, 2] }, d: "x y" })), "a[b][0][c]=1&a[b][1]=2&d=x y");
});
