// POST /api/stripe-webhook — Stripe calls this after a payment.
// On checkout.session.completed (paid) it logs the order in the "Web Orders" tab and
// takes the sold pairs off the Master Inventory stock. Logging first makes retries safe:
// a session that's already in the log is never deducted twice.
import { verifyStripeSignature } from "../lib/stripe.js";
import { decodeLine } from "../lib/cart-logic.js";
import { sheetsConfigured, orderAlreadyLogged, logOrder, decrementStock } from "../lib/sheets.js";

const ok = (msg = "ok", status = 200) => new Response(msg, { status });

function sydneyTime(unix) {
  return new Date(unix * 1000).toLocaleString("en-AU", { timeZone: "Australia/Sydney", hour12: false });
}

export async function POST(request) {
  const raw = await request.text();
  const sig = request.headers.get("stripe-signature");
  if (!verifyStripeSignature(raw, sig, process.env.STRIPE_WEBHOOK_SECRET)) return ok("bad signature", 400);

  const event = JSON.parse(raw);
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return ok("ignored");
  const s = event.data.object;
  if (s.payment_status !== "paid") return ok("not paid yet");
  if (s.metadata?.source !== "yolo-au-web") return ok("not ours");
  if (!sheetsConfigured()) { console.warn("Paid order but Google Sheets is not configured:", s.id); return ok("no sheet"); }

  try {
    if (await orderAlreadyLogged(s.id)) return ok("already processed");
    const n = Number(s.metadata.lines || 0);
    const lines = Array.from({ length: n }, (_, i) => decodeLine(s.metadata[`l${i}`])).filter(Boolean);
    const ship = s.shipping_details || s.collected_information?.shipping_details || {};
    const a = ship.address || {};
    const address = [ship.name, a.line1, a.line2, `${a.city || ""} ${a.state || ""} ${a.postal_code || ""}`.trim(), a.country].filter(Boolean).join(", ");
    const items = lines.map((l) => `${l.qty}× ${l.name}${l.colour ? " " + l.colour : ""} EU${l.size}`).join("; ");

    await logOrder([
      sydneyTime(s.created), s.id, s.customer_details?.name || ship.name || "", s.customer_details?.email || "",
      s.customer_details?.phone || "", address, items, (s.amount_total || 0) / 100, "yes", ""
    ]);

    let notes = [];
    try {
      notes = await decrementStock(lines.filter((l) => l.ref).map((l) => ({ ref: l.ref, size: l.size, qty: l.qty })));
    } catch (e) {
      console.error("stock update failed", s.id, e);
      await logOrder(["", s.id + " (stock)", "", "", "", "", items, "", "FAILED — update stock by hand", String(e.message || e)]);
      return ok("logged; stock update failed");
    }
    if (notes.length) await logOrder(["", s.id + " (stock)", "", "", "", "", "", "", "done with warnings", notes.join(" | ")]);
    return ok("processed");
  } catch (e) {
    console.error("webhook failed", s.id, e);
    return ok("retry", 500); // Stripe will retry
  }
}
