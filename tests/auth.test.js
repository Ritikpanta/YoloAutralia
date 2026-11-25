// Offline tests for customer accounts, the admin API and admin product edits (Google + Sheets mocked).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const google = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...google.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "bot@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
process.env.SESSION_SECRET = "x".repeat(48);
process.env.GOOGLE_CLIENT_ID = "client-123.apps.googleusercontent.com";
process.env.ADMIN_EMAILS = "boss@yolo.example, ritik@yolo.example";
process.env.STRIPE_SECRET_KEY = "sk_test_x";

// --- fake spreadsheet: tabs of rows ---
let tabs, stripeCalls;
function reset() {
  tabs = {
    "Master Inventory": [["Model", "Colourway", "39", "40", "41", "42", "43", "Bulk"], ["Odin", "Patent Tan", 1, 1, 1, 1, 0, ""], ["Odin", "Black", 0, 0, 1, 0, 1, ""]],
    "Web Orders": [["Date (Sydney)", "Stripe session", "Name", "Email", "Phone", "Ship to", "Items", "Total (AUD)", "Stock updated", "Notes"],
      ["20/11/2026, 10:00:00", "cs_a", "Sam", "sam@x.com", "", "Sydney", "1× Odin Patent Tan EU41", 102, "yes", ""]]
  };
  stripeCalls = [];
}
const col = (L) => L.charCodeAt(0) - 65;
const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "tok", expires_in: 3600 });
  if (u.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return ok({ keys: [jwk] });
  if (u.startsWith("https://api.stripe.com/v1/checkout/sessions")) { stripeCalls.push(decodeURIComponent(opts.body)); return ok({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }); }
  if (u.includes("sheets.googleapis.com")) {
    const path = decodeURIComponent(u.split("/spreadsheets/")[1].replace(/^[^/?:]+/, ""));
    if (path.startsWith("?fields")) return ok({ sheets: Object.keys(tabs).map((t) => ({ properties: { title: t } })) });
    if (path.startsWith(":batchUpdate")) { tabs[JSON.parse(opts.body).requests[0].addSheet.properties.title] = []; return ok({}); }
    if (path.startsWith("/values:batchUpdate")) {
      for (const d of JSON.parse(opts.body).data) { const m = d.range.match(/^'(.+)'!([A-Z])(\d+)$/); tabs[m[1]][+m[3] - 1][col(m[2])] = d.values[0][0]; }
      return ok({});
    }
    let m = path.match(/^\/values\/'(.+?)'!A1:append/);
    if (m) { tabs[m[1]].push(...JSON.parse(opts.body).values); return ok({}); }
    m = path.match(/^\/values\/'(.+?)'!A(\d+)\?valueInputOption/);
    if (m && opts.method === "PUT") { tabs[m[1]][+m[2] - 1] = JSON.parse(opts.body).values[0]; return ok({}); }
    m = path.match(/^\/values\/'(.+?)'!/);
    if (m) return ok({ values: tabs[m[1]] || [] });
  }
  throw new Error("unexpected fetch " + u);
};

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(email, extra = {}) {
  const h = b64u({ alg: "RS256", kid: "k1", typ: "JWT" });
  const p = b64u({ iss: "https://accounts.google.com", aud: process.env.GOOGLE_CLIENT_ID, sub: "g-" + email, email, email_verified: true, name: "Test Person", exp: Math.floor(Date.now() / 1000) + 600, ...extra });
  return `${h}.${p}.${crypto.createSign("RSA-SHA256").update(`${h}.${p}`).sign(google.privateKey).toString("base64url")}`;
}
const ORIGIN = "https://yolo.example";
const post = (path, body, cookie) => new Request(ORIGIN + path, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const get = (path, cookie) => new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} });
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

const auth = await import("../lib/auth.js");
const account = await import("../api/account.js");
const admin = await import("../api/admin.js");
const { POST: checkout } = await import("../api/checkout.js");
const { forgetTabs } = await import("../lib/sheets.js");
beforeEach(() => { reset(); forgetTabs(); });

test("passwords are hashed and verified; sessions can't be forged", () => {
  const h = auth.hashPassword("correct horse battery");
  assert.ok(h.startsWith("scrypt$") && !h.includes("correct"));
  assert.ok(auth.verifyPassword("correct horse battery", h));
  assert.ok(!auth.verifyPassword("wrong horse battery", h));
  const s = auth.makeSession({ email: "a@b.co" }, "customer");
  assert.equal(auth.readSession(get("/", `yolo_s=${s.value}`), "yolo_s").email, "a@b.co");
  const [body, sig] = s.value.split(".");
  const forged = Buffer.from(JSON.stringify({ email: "a@b.co", role: "admin", exp: 9e9 })).toString("base64url");
  assert.equal(auth.readSession(get("/", `yolo_admin=${forged}.${sig}`), "yolo_admin"), null);
});

test("customer can sign up, sign in, update details and see their orders", async () => {
  let res = await account.POST(post("/api/account?a=signup", { name: "Sam Lee", email: "Sam@X.com", password: "a fine long passphrase" }));
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(tabs.Customers).includes("a fine long passphrase"));
  res = await account.POST(post("/api/account?a=login", { email: "sam@x.com", password: "nope nope nope" }));
  assert.equal(res.status, 401);
  res = await account.POST(post("/api/account?a=login", { email: "sam@x.com", password: "a fine long passphrase" }));
  assert.equal(res.status, 200);
  const c = cookieOf(res);
  assert.match(res.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  res = await account.POST(post("/api/account?a=profile", { phone: "0400 000 000", address: "1 George St, Sydney NSW 2000" }, c));
  assert.equal((await res.json()).user.phone, "0400 000 000");
  const orders = await (await account.GET(get("/api/account?a=orders", c))).json();
  assert.equal(orders.orders.length, 1);
  assert.equal(orders.orders[0].total, 102);
});

test("signup rejects weak passwords and duplicate emails; cross-site posts are refused", async () => {
  assert.equal((await account.POST(post("/api/account?a=signup", { email: "a@b.co", password: "short" }))).status, 400);
  await account.POST(post("/api/account?a=signup", { email: "a@b.co", password: "long enough password" }));
  assert.equal((await account.POST(post("/api/account?a=signup", { email: "A@b.co", password: "long enough password" }))).status, 409);
  const evil = new Request(ORIGIN + "/api/account?a=login", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
  assert.equal((await account.POST(evil)).status, 403);
});

test("admin: only listed Google accounts get in, and only admins reach admin data", async () => {
  assert.equal((await admin.GET(get("/api/admin?a=dashboard"))).status, 401);
  assert.equal((await admin.POST(post("/api/admin?a=login", { credential: idToken("someone@gmail.com") }))).status, 403);
  assert.equal((await admin.POST(post("/api/admin?a=login", { credential: idToken("boss@yolo.example", { aud: "other" }) }))).status, 403);
  // a customer session is not an admin session
  const cust = auth.makeSession({ email: "boss@yolo.example" }, "customer");
  assert.equal((await admin.GET(get("/api/admin?a=orders", `yolo_admin=${cust.value}`))).status, 401);
  const res = await admin.POST(post("/api/admin?a=login", { credential: idToken("Boss@yolo.example") }));
  assert.equal(res.status, 200);
  const c = cookieOf(res);
  const d = await (await admin.GET(get("/api/admin?a=dashboard&days=30", c))).json();
  assert.equal(d.kpis.stockPairs, 6);
  assert.ok(d.out.length === 0 && d.low.length === 2);
  // removed from ADMIN_EMAILS -> locked out immediately
  const keep = process.env.ADMIN_EMAILS; process.env.ADMIN_EMAILS = "ritik@yolo.example";
  assert.equal((await admin.GET(get("/api/admin?a=orders", c))).status, 401);
  process.env.ADMIN_EMAILS = keep;
});

test("admin stock edits write the sheet and are logged", async () => {
  const c = cookieOf(await admin.POST(post("/api/admin?a=login", { credential: idToken("boss@yolo.example") })));
  const res = await admin.POST(post("/api/admin?a=inventory", { changes: [{ rowNumber: 3, size: 39, value: 4 }, { rowNumber: 2, size: 43, value: 2 }] }, c));
  assert.equal((await res.json()).changed, 2);
  assert.equal(tabs["Master Inventory"][2][2], 4);
  assert.equal(tabs["Master Inventory"][1][6], 2);
  assert.match(JSON.stringify(tabs["Admin Log"]), /Odin \/ Black EU39: 0 → 4/);
  assert.equal((await admin.POST(post("/api/admin?a=inventory", { changes: [{ rowNumber: 2, size: 40, value: -1 }] }, c))).status, 400);
});

test("admin product edits (sale price, hide) reach checkout", async () => {
  const c = cookieOf(await admin.POST(post("/api/admin?a=login", { credential: idToken("boss@yolo.example") })));
  const { products } = await (await admin.GET(get("/api/admin?a=products", c))).json();
  const odin = products.find((p) => p.slug === "odin");
  let res = await admin.POST(post("/api/admin?a=product", { product: { ...odin, sale: 75 } }, c));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  res = await checkout(new Request(ORIGIN + "/api/checkout", { method: "POST", body: JSON.stringify({ items: [{ slug: "odin", colour: "patent-tan", size: 41, qty: 1 }] }) }));
  assert.equal(res.status, 200);
  assert.match(stripeCalls[0], /unit_amount\]=7500/);
  // a stock row that isn't in the sheet is refused
  res = await admin.POST(post("/api/admin?a=product", { product: { ...odin, colourways: [{ name: "Red", hex: "#aa0000", sheet: { model: "Odin", colourway: "Red" } }] } }, c));
  assert.equal(res.status, 400);
  // hidden -> can't be bought
  await admin.POST(post("/api/admin?a=product", { product: { ...odin, sale: 75 }, hidden: true }, c));
  res = await checkout(new Request(ORIGIN + "/api/checkout", { method: "POST", body: JSON.stringify({ items: [{ slug: "odin", colour: "patent-tan", size: 41, qty: 1 }] }) }));
  assert.equal(res.status, 400);
});
