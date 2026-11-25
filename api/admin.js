// /api/admin?a=...  The store admin. Google sign-in only, for emails in ADMIN_EMAILS.
// Every action except config/login checks the admin cookie AND that the email is still on the list.
//   GET  config | me | dashboard?days=30 | orders | inventory | products | customers | log
//   POST login {credential} | logout | inventory {changes:[{rowNumber,size,value}]} | product {product, hidden}
import { ADMIN_COOKIE, authConfigured, makeSession, adminFrom, cookie, clearCookie, sameOrigin, verifyGoogleIdToken, isAdminEmail,
  adminEmails, tooManyTries, noteTry } from "../lib/auth.js";
import { sheetsConfigured, readInventory, readOrders, setInventoryCells, readTab, appendRows, ensureTab } from "../lib/sheets.js";
import { allProducts, cleanProduct, saveProduct } from "../lib/catalog-live.js";
import { listCustomers, findCustomer, saveCustomer } from "../lib/customers.js";
import { hashPassword } from "../lib/auth.js";
import crypto from "node:crypto";
import { SHOP } from "../lib/shop-config.js";

const LOG_TAB = "Admin Log";
const LOG_H = ["Time (Sydney)", "Admin", "Action", "Details"];
const SIZES = [39, 40, 41, 42, 43];
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", ...headers }
});
const sydney = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney", hour12: false });
async function audit(admin, action, details) {
  try { await ensureTab(LOG_TAB, LOG_H); await appendRows(LOG_TAB, [[sydney(), admin.email, action, String(details).slice(0, 45000)]]); }
  catch (e) { console.error("admin log failed", e); }
}

// "25/11/2026, 14:03:11" (en-AU, Sydney) -> Date
function parseSydney(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})/);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5])) : null;
}
const dayKey = (d) => d.toISOString().slice(0, 10);

function cleanOrders(rows) {
  return rows.filter((o) => o["Stripe session"] && !String(o["Stripe session"]).includes("(stock)")).map((o) => {
    const when = parseSydney(o["Date (Sydney)"]);
    const items = String(o.Items || "").split(/;\s*/).filter(Boolean).map((t) => {
      const m = t.match(/^(\d+)×\s*(.+?)\s+EU(\d+)$/);
      return m ? { qty: +m[1], label: m[2], size: +m[3] } : { qty: 1, label: t, size: null };
    });
    return { when: when ? when.toISOString() : null, date: String(o["Date (Sydney)"] || ""), session: String(o["Stripe session"]), name: String(o.Name || ""),
      email: String(o.Email || ""), phone: String(o.Phone || ""), shipTo: String(o["Ship to"] || ""), items, itemsText: String(o.Items || ""),
      total: Number(o["Total (AUD)"]) || 0, stock: String(o["Stock updated"] || ""), notes: String(o.Notes || "") };
  });
}

async function dashboard(days) {
  const [orders, inv, products] = await Promise.all([readOrders().then(cleanOrders), readInventory(), allProducts({ fresh: true })]);
  const now = new Date(); const from = new Date(now.getTime() - days * 86400_000);
  const prevFrom = new Date(from.getTime() - days * 86400_000);
  const inRange = orders.filter((o) => o.when && new Date(o.when) >= from);
  const prev = orders.filter((o) => o.when && new Date(o.when) >= prevFrom && new Date(o.when) < from);
  const sum = (a) => a.reduce((s, o) => s + o.total, 0);
  const units = (a) => a.reduce((s, o) => s + o.items.reduce((n, i) => n + i.qty, 0), 0);
  const byDay = new Map();
  for (let d = new Date(from); d <= now; d = new Date(d.getTime() + 86400_000)) byDay.set(dayKey(d), { day: dayKey(d), revenue: 0, orders: 0 });
  for (const o of inRange) { const k = dayKey(new Date(o.when)); const b = byDay.get(k); if (b) { b.revenue += o.total; b.orders += 1; } }
  const top = new Map();
  for (const o of inRange) for (const i of o.items) { const t = top.get(i.label) || { label: i.label, units: 0 }; t.units += i.qty; top.set(i.label, t); }
  const sizeMix = Object.fromEntries(SIZES.map((s) => [s, 0]));
  for (const o of inRange) for (const i of o.items) if (sizeMix[i.size] != null) sizeMix[i.size] += i.qty;
  // stock health from Master Inventory
  const priceFor = (row) => {
    const p = products.find((x) => x.colourways?.some((c) => c.sheet && c.sheet.model === row.model && c.sheet.colourway === row.colourway) || (x.sheetRow && x.sheetRow.model === row.model));
    return p ? (Number(p.sale) > 0 ? Number(p.sale) : p.price) : 0;
  };
  let pairs = 0, retail = 0; const low = [], out = [];
  for (const r of inv.rows) {
    const sized = Object.values(r.sizes).some((n) => n > 0);
    const n = sized ? Object.values(r.sizes).reduce((a, b) => a + b, 0) : r.bulk;
    pairs += n; retail += n * priceFor(r);
    if (n === 0) out.push({ model: r.model, colourway: r.colourway });
    else if (sized) { const thin = SIZES.filter((s) => r.sizes[s] === 0); if (thin.length) low.push({ model: r.model, colourway: r.colourway, missing: thin, left: n }); }
    else if (n <= 2) low.push({ model: r.model, colourway: r.colourway, missing: [], left: n });
  }
  return {
    days, kpis: {
      revenue: sum(inRange), revenuePrev: sum(prev), orders: inRange.length, ordersPrev: prev.length,
      aov: inRange.length ? sum(inRange) / inRange.length : 0, units: units(inRange), unitsPrev: units(prev),
      stockPairs: pairs, stockRetail: Math.round(retail), products: products.filter((p) => !p.hidden).length, hidden: products.filter((p) => p.hidden).length
    },
    series: [...byDay.values()], top: [...top.values()].sort((a, b) => b.units - a.units).slice(0, 8), sizeMix,
    low: low.slice(0, 40), out: out.slice(0, 40), recent: orders.slice(-8).reverse(), currency: "AUD"
  };
}

export async function GET(request) {
  const a = new URL(request.url).searchParams.get("a");
  if (a === "config") return json({ google: process.env.GOOGLE_CLIENT_ID || null, ready: authConfigured() && sheetsConfigured() && adminEmails().length > 0 });
  const admin = adminFrom(request);
  if (a === "me") return json({ admin: admin ? { email: admin.email, name: admin.name } : null });
  if (!admin) return json({ error: "Please sign in." }, 401);
  try {
    if (a === "dashboard") {
      const days = [7, 30, 90, 365].includes(+new URL(request.url).searchParams.get("days")) ? +new URL(request.url).searchParams.get("days") : 30;
      return json(await dashboard(days));
    }
    if (a === "orders") return json({ orders: cleanOrders(await readOrders()).reverse() });
    if (a === "inventory") {
      const inv = await readInventory();
      return json({ rows: inv.rows.map((r) => ({ rowNumber: r.rowNumber, model: r.model, colourway: r.colourway, sizes: r.sizes, bulk: r.bulk, sized: Object.values(r.sizes).some((n) => n > 0) || r.bulk === 0 })), tab: SHOP.stockSheet.tab });
    }
    if (a === "products") return json({ products: (await allProducts({ fresh: true })).map(({ _row, ...p }) => p) });
    if (a === "customers") return json({ customers: (await listCustomers()).map(({ hash, google, row, ...c }) => ({ ...c, signIn: [hash && "password", google && "Google"].filter(Boolean).join(" + ") })) });
    if (a === "log") return json({ log: (await readTab(LOG_TAB, LOG_H)).slice(-200).reverse().map((r) => ({ time: r["Time (Sydney)"], admin: r.Admin, action: r.Action, details: r.Details })) });
  } catch (e) {
    console.error("admin GET", a, e);
    return json({ error: "Couldn't reach the stock sheet just now. Try again in a minute." }, 503);
  }
  return json({ error: "Not found" }, 404);
}

export async function POST(request) {
  const a = new URL(request.url).searchParams.get("a");
  if (!sameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (a === "logout") return json({ ok: true }, 200, { "Set-Cookie": clearCookie(ADMIN_COOKIE) });
  let b = {}; try { b = await request.json(); } catch {}
  if (a === "login") {
    if (!authConfigured() || !adminEmails().length) return json({ error: "Admin sign-in isn't set up yet (SESSION_SECRET, GOOGLE_CLIENT_ID and ADMIN_EMAILS on Vercel)." }, 503);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";
    if (tooManyTries("adm:" + ip, 10)) return json({ error: "Too many attempts. Please wait 15 minutes." }, 429);
    noteTry("adm:" + ip);
    let g = null; try { g = await verifyGoogleIdToken(b.credential); } catch (e) { console.error(e); }
    if (!g || !isAdminEmail(g.email)) return json({ error: "This Google account doesn't have admin access." }, 403);
    const s = makeSession({ email: g.email, name: g.name }, "admin");
    await audit({ email: g.email }, "Signed in", ip);
    return json({ admin: { email: g.email, name: g.name } }, 200, { "Set-Cookie": cookie(ADMIN_COOKIE, s.value, s.age) });
  }
  const admin = adminFrom(request);
  if (!admin) return json({ error: "Please sign in again." }, 401);
  try {
    if (a === "inventory") {
      const changes = Array.isArray(b.changes) ? b.changes.slice(0, 500) : [];
      const inv = await readInventory(); const cells = []; const lines = [];
      for (const c of changes) {
        const row = inv.rows.find((r) => r.rowNumber === Number(c.rowNumber));
        const value = Math.floor(Number(c.value));
        if (!row || !(value >= 0 && value <= 9999)) return json({ error: "One of the stock numbers isn't valid." }, 400);
        const col = c.size === "bulk" ? inv.cols.bulk : inv.cols[Number(c.size)];
        if (col == null || col < 0) return json({ error: `No ${c.size} column in the sheet.` }, 400);
        const before = c.size === "bulk" ? row.bulk : row.sizes[Number(c.size)];
        if (before !== value) { cells.push({ rowNumber: row.rowNumber, col, value }); lines.push(`${row.model} / ${row.colourway} ${c.size === "bulk" ? "Bulk" : "EU" + c.size}: ${before} → ${value}`); }
      }
      await setInventoryCells(cells);
      if (lines.length) await audit(admin, "Stock updated", lines.join("; "));
      return json({ ok: true, changed: lines.length });
    }
    if (a === "customer-reset") {
      // a customer forgot their password: set a one-off temporary one for the admin to pass on
      const c = await findCustomer(b.email);
      if (!c) return json({ error: "No account with that email." }, 404);
      const temp = crypto.randomBytes(9).toString("base64url");
      c.hash = hashPassword(temp); await saveCustomer(c);
      await audit(admin, "Reset a customer password", c.email);
      return json({ ok: true, temp });
    }
    if (a === "product") {
      const all = await allProducts({ fresh: true });
      const existing = b.product?.slug ? all.find((p) => p.slug === b.product.slug) : null;
      if (!existing && b.product?.slug && b.isNew === false) return json({ error: "That product no longer exists." }, 404);
      const { product, error } = cleanProduct(b.product || {}, existing);
      if (error) return json({ error }, 400);
      if (!existing && all.some((p) => p.slug === product.slug)) return json({ error: "Another product already uses that name/web address." }, 409);
      // every linked stock row must exist in Master Inventory, or the product could never be sold
      const inv = await readInventory();
      // (only links that are new or changed: an untouched colour keeps working as before)
      const same = (x, y) => x && y && String(x.model).toLowerCase() === String(y.model).toLowerCase() && String(x.colourway).toLowerCase() === String(y.colourway).toLowerCase();
      const refs = (product.colourways.length ? product.colourways.map((c) => c.sheet).filter(Boolean) : [product.sheetRow].filter(Boolean))
        .filter((r) => !(existing && (existing.colourways || []).some((c) => same(c.sheet, r)) || same(existing?.sheetRow, r)));
      const missing = refs.filter((r) => !inv.rows.some((x) => x.model.toLowerCase() === String(r.model).toLowerCase() && x.colourway.toLowerCase() === String(r.colourway).toLowerCase()));
      if (missing.length) return json({ error: `Not in Master Inventory: ${missing.map((r) => `${r.model} / ${r.colourway}`).join(", ")}. Add the row in the sheet first, or fix the spelling.` }, 400);
      const hidden = Boolean(b.hidden);
      await saveProduct(product, { hidden, by: admin.email });
      const what = existing ? Object.keys(product).filter((k) => JSON.stringify(product[k]) !== JSON.stringify(existing[k])).join(", ") || "no changes" : "new product";
      await audit(admin, existing ? `Edited ${product.name}` : `Added ${product.name}`, `${what}${hidden !== Boolean(existing?.hidden) ? (hidden ? " · hidden from shop" : " · shown in shop") : ""}`);
      return json({ ok: true, product: { ...product, hidden } });
    }
  } catch (e) {
    console.error("admin POST", a, e);
    return json({ error: "Couldn't save to the stock sheet. Nothing was changed; try again in a minute." }, 503);
  }
  return json({ error: "Not found" }, 404);
}
