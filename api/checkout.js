// POST /api/checkout  { items: [{slug, colour, size, qty, note}] }  ->  { url } (Stripe Checkout)
import { priceCart, encodeLine } from "../lib/cart-logic.js";
import { SHOP } from "../lib/shop-config.js";
import { stripe } from "../lib/stripe.js";
import { sheetsConfigured, readInventory, findRow, available } from "../lib/sheets.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function siteOrigin(request) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const cart = priceCart(body?.items);
  if (cart.errors.length) return json({ error: cart.errors[0], errors: cart.errors }, 400);

  // Live stock check against the Google Sheet
  if (sheetsConfigured()) {
    let inv;
    try { inv = await readInventory(); }
    catch (e) { console.error("stock read failed", e); return json({ error: "We couldn't check stock just now. Please try again in a minute." }, 503); }
    // add up demand per stock row/size
    const demand = new Map();
    for (const l of cart.lines) {
      const row = findRow(inv, l.ref || {});
      const key = `${row?.rowNumber}:${row && Object.values(row.sizes).some((n) => n > 0) ? l.size : "bulk"}`;
      const d = demand.get(key) || { row, size: l.size, qty: 0, name: `${l.name}${l.colour ? " (" + l.colour + ")" : ""} EU ${l.size}` };
      d.qty += l.qty; demand.set(key, d);
    }
    for (const d of demand.values()) {
      const have = available(d.row, d.size);
      if (have < d.qty) {
        return json({ error: have ? `Only ${have} left of ${d.name}. Please update your cart.` : `${d.name} has just sold out.`, soldOut: true }, 409);
      }
    }
  }

  const origin = siteOrigin(request);
  const absolute = (src) => (/^https?:/.test(src) ? src : `${origin}${src}`);
  const gst = process.env.STRIPE_GST_RATE_ID;
  const metadata = { source: "yolo-au-web", lines: String(cart.lines.length) };
  cart.lines.forEach((l, i) => { metadata[`l${i}`] = encodeLine(l); });

  const params = {
    mode: "payment",
    success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/shop?cart=open`,
    currency: SHOP.currency,
    line_items: cart.lines.map((l) => ({
      quantity: l.qty,
      price_data: {
        currency: SHOP.currency,
        unit_amount: Math.round(l.unit * 100),
        tax_behavior: "inclusive",
        product_data: {
          name: l.name,
          description: [l.colour, `EU ${l.size}`].filter(Boolean).join(" · "),
          images: [absolute(l.image)]
        }
      },
      ...(gst ? { tax_rates: [gst] } : {})
    })),
    shipping_address_collection: { allowed_countries: SHOP.shipping.countries },
    shipping_options: [{
      shipping_rate_data: {
        type: "fixed_amount",
        display_name: cart.shipping ? SHOP.shipping.label : SHOP.shipping.freeLabel,
        fixed_amount: { amount: Math.round(cart.shipping * 100), currency: SHOP.currency },
        tax_behavior: "inclusive"
      }
    }],
    phone_number_collection: { enabled: true },
    billing_address_collection: "auto",
    invoice_creation: { enabled: true },
    allow_promotion_codes: true,
    metadata,
    payment_intent_data: { metadata }
  };

  try {
    const session = await stripe("checkout/sessions", params);
    return json({ url: session.url });
  } catch (e) {
    console.error("stripe session failed", e);
    return json({ error: "Checkout is unavailable right now. Please try again shortly." }, 502);
  }
}

export function GET() { return json({ error: "Use POST" }, 405); }
