// Turns a cart sent by the browser into trusted, priced order lines.
// Used by the checkout API; never trusts prices or names from the browser.
import { PRODUCTS } from "./catalog.js";
import { SHOP, shippingFor, priceOf } from "./shop-config.js";

const SIZES = [39, 40, 41, 42, 43];

export function stockRef(product, colour) {
  if (colour && colour.sheet) return colour.sheet;
  return product.sheetRow || null;
}

// items: [{slug, colour, size, qty, note}] -> { lines, subtotal, shipping, total, errors }
export function priceCart(items) {
  const errors = [];
  if (!Array.isArray(items) || !items.length) return { lines: [], errors: ["Your cart is empty."] };
  if (items.length > SHOP.maxCartLines) return { lines: [], errors: [`Please keep it to ${SHOP.maxCartLines} items per order.`] };
  const lines = [];
  for (const raw of items) {
    const p = PRODUCTS.find((x) => x.slug === raw?.slug);
    if (!p) { errors.push("A shoe in your cart is no longer available."); continue; }
    const size = Number(raw.size);
    if (!SIZES.includes(size)) { errors.push(`Please choose a size for ${p.name}.`); continue; }
    const qty = Math.floor(Number(raw.qty));
    if (!(qty >= 1 && qty <= SHOP.maxQtyPerLine)) { errors.push(`Quantity for ${p.name} must be 1–${SHOP.maxQtyPerLine}.`); continue; }
    let colour = null;
    if (p.colourways.length) {
      colour = p.colourways.find((c) => c.slug === raw.colour);
      if (!colour) { errors.push(`Please choose a colour for ${p.name}.`); continue; }
    }
    // Colour preference for styles without tracked colourways (free text from a fixed list)
    const pref = !colour && p.variants && p.variants.includes(raw.note) ? raw.note : null;
    const ref = stockRef(p, colour);
    lines.push({
      slug: p.slug, name: p.name, colour: colour ? colour.name : pref, colourSlug: colour ? colour.slug : null,
      size, qty, unit: priceOf(p), amount: priceOf(p) * qty, ref,
      image: p.cutout || p.images[0]
    });
  }
  // merge duplicates of the same shoe/colour/size
  const merged = [];
  for (const l of lines) {
    const m = merged.find((x) => x.slug === l.slug && x.colourSlug === l.colourSlug && x.colour === l.colour && x.size === l.size);
    if (m) { m.qty += l.qty; m.amount += l.amount; } else merged.push({ ...l });
  }
  merged.forEach((l) => { if (l.qty > SHOP.maxQtyPerLine) errors.push(`Max ${SHOP.maxQtyPerLine} pairs of ${l.name} in one size.`); });
  const subtotal = merged.reduce((s, l) => s + l.amount, 0);
  const shipping = merged.length ? shippingFor(subtotal) : 0;
  return { lines: merged, subtotal, shipping, total: subtotal + shipping, errors };
}

// Compact line codes stored in Stripe metadata so the webhook can update stock.
export function encodeLine(l) {
  return [l.slug, l.colourSlug || "", l.size, l.qty, (l.colour && !l.colourSlug) ? l.colour : ""].join("|");
}
export function decodeLine(code) {
  const [slug, colourSlug, size, qty, pref] = String(code).split("|");
  const p = PRODUCTS.find((x) => x.slug === slug);
  if (!p) return null;
  const colour = colourSlug ? p.colourways.find((c) => c.slug === colourSlug) : null;
  return { slug, name: p.name, colour: colour ? colour.name : pref || null, size: Number(size), qty: Number(qty), ref: stockRef(p, colour) };
}
