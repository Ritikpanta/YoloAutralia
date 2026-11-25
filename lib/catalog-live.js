// The live catalogue: lib/catalog.js (the built-in list) plus the edits admins save in the
// "Website Products" tab of the stock sheet. One row per product: the full product as JSON, so an
// edit can change anything (name, description, prices, photos, colourways, which stock row it sells).
// New products are rows whose slug isn't in catalog.js. Hidden products stay in the admin but
// disappear from the shop and can't be bought.
import { PRODUCTS } from "./catalog.js";
import { sheetsConfigured, readTab, writeRow, appendRows, ensureTab } from "./sheets.js";

export const PRODUCTS_TAB = "Website Products";
const HEADERS = ["Slug", "Name", "Hidden", "Updated (Sydney)", "Updated by", "Product JSON"];
let cache = { at: 0, list: null };
const clone = (x) => JSON.parse(JSON.stringify(x));
const sydney = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney", hour12: false });

export function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// Every product, hidden ones included (admin view). Falls back to the built-in list if the sheet is unreachable.
export async function allProducts({ fresh = false } = {}) {
  if (!fresh && cache.list && Date.now() - cache.at < 30_000) return cache.list;
  const list = clone(PRODUCTS);
  if (sheetsConfigured()) {
    try {
      const rows = await readTab(PRODUCTS_TAB);
      for (const r of rows) {
        let p; try { p = JSON.parse(r["Product JSON"]); } catch { continue; }
        if (!p || !p.slug) continue;
        p.hidden = String(r.Hidden).toLowerCase() === "yes" || r.Hidden === true;
        p._row = r._row;
        const i = list.findIndex((x) => x.slug === p.slug);
        if (i >= 0) list[i] = { ...list[i], ...p }; else list.push(p);
      }
    } catch (e) { console.error("Website Products read failed; using built-in catalogue", e); }
  }
  cache = { at: Date.now(), list };
  return list;
}

// What the shop sells
export async function liveProducts() {
  return (await allProducts()).filter((p) => !p.hidden);
}

// Validate and normalise a product sent by the admin page. Returns { product } or { error }.
export function cleanProduct(input, existing) {
  const p = { ...(existing ? clone(existing) : {}), ...input };
  const str = (v, max = 4000) => String(v ?? "").trim().slice(0, max);
  const money = (v) => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) && n > 0 ? n : null; };
  p.name = str(p.name, 120);
  if (!p.name) return { error: "Give the product a name." };
  p.slug = existing ? existing.slug : slugify(p.slug || p.name);
  if (!p.slug) return { error: "The product needs a web address (slug)." };
  if (!["loafers", "formals", "sneakers", "boots"].includes(p.category)) return { error: "Choose a category." };
  p.price = money(p.price);
  if (!p.price) return { error: "Enter a price in AUD." };
  p.sale = p.sale === "" || p.sale == null ? null : money(p.sale);
  if (p.sale && p.sale >= p.price) return { error: "A sale price must be lower than the normal price." };
  p.description = str(p.description, 4000);
  p.images = (Array.isArray(p.images) ? p.images : String(p.images || "").split(/\s*\n\s*/)).map((u) => str(u, 500)).filter((u) => /^(https:\/\/|\/assets\/)/.test(u)).slice(0, 12);
  if (!p.images.length && !p.cutout) return { error: "Add at least one photo (https:// link)." };
  p.colourways = (Array.isArray(p.colourways) ? p.colourways : []).map((c) => ({
    ...c,
    name: str(c.name, 60),
    slug: c.slug || slugify(c.name),
    hex: /^#[0-9a-f]{6}$/i.test(c.hex || "") ? c.hex : "#1e1e20",
    base: str(c.base || c.name, 40),
    sheet: c.sheet && c.sheet.model ? { model: str(c.sheet.model, 80), colourway: str(c.sheet.colourway, 80) } : null
  })).filter((c) => c.name).slice(0, 20);
  if (!p.colourways.length && !(p.sheetRow && p.sheetRow.model)) return { error: "Link at least one colourway to a Master Inventory row (Model + Colourway)." };
  if (!Array.isArray(p.images)) p.images = [];
  delete p._row; delete p.hidden;
  return { product: p };
}

// Save one product (create or update). by = admin email.
export async function saveProduct(product, { hidden = false, by }) {
  await ensureTab(PRODUCTS_TAB, HEADERS);
  const rows = await readTab(PRODUCTS_TAB);
  const row = rows.find((r) => r.Slug === product.slug);
  const values = [product.slug, product.name, hidden ? "yes" : "no", sydney(), by, JSON.stringify(product)];
  if (row) await writeRow(PRODUCTS_TAB, row._row, values); else await appendRows(PRODUCTS_TAB, [values]);
  cache = { at: 0, list: null };
}
