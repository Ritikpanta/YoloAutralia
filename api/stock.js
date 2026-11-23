// GET /api/stock?slug=odin  ->  live sizes per colourway from the Google Sheet
// { live: true, colours: { "patent-tan": {39:1,40:1,...} }, any: {39:n,...} }
import { PRODUCTS } from "../lib/catalog.js";
import { sheetsConfigured, readInventory, findRow, available } from "../lib/sheets.js";

const SIZES = [39, 40, 41, 42, 43];
const json = (body, status = 200, cache = "public, s-maxage=30, stale-while-revalidate=120") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": cache } });

export async function GET(request) {
  const slug = new URL(request.url).searchParams.get("slug");
  const p = PRODUCTS.find((x) => x.slug === slug);
  if (!p) return json({ error: "Unknown product" }, 404, "no-store");
  if (!sheetsConfigured()) return json({ live: false }, 200, "no-store");
  try {
    const inv = await readInventory();
    const sizesFor = (ref) => { const row = findRow(inv, ref || {}); return Object.fromEntries(SIZES.map((s) => [s, available(row, s)])); };
    if (p.colourways.length) {
      const colours = Object.fromEntries(p.colourways.map((c) => [c.slug, sizesFor(c.sheet)]));
      return json({ live: true, colours });
    }
    return json({ live: true, any: sizesFor(p.sheetRow) });
  } catch (e) {
    console.error("stock read failed", e);
    return json({ live: false }, 200, "no-store");
  }
}
