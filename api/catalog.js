// GET /api/catalog -> the products the shop sells right now (built-in list + admin edits, hidden ones removed).
// Pages load lib/catalog.js first for an instant render, then swap in this list (see lib/live-catalog.js).
import { liveProducts } from "../lib/catalog-live.js";

export async function GET() {
  const products = (await liveProducts()).map(({ _row, hidden, ...p }) => p);
  return new Response(JSON.stringify({ products }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300" }
  });
}
