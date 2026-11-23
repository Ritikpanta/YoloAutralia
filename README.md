# YOLO Australia — online store

A static storefront with three serverless functions, built for Vercel. It has no dependencies and no build step.

- **Pages:** `index.html`, `shop.html`, `product.html`, `contact.html`, `success.html`
- **3D:** `assets/js/hero3d.js` (boots walking continuously on a moving floor) and `assets/js/shop3d.js` (turntable).
- **Try on:** `try-on.html` + `assets/js/tryon.js`: size from height/weight/foot length, a figure scaled to the customer, a to-scale foot close-up, and a camera mode (needs HTTPS, which Vercel provides). Nothing is uploaded. Both use three.js 0.160 from jsDelivr. If WebGL isn't available, the pages fall back to CSS animations.
- **Cart:** stored in the shopper's browser. The checkout server re-prices everything, so prices can't be tampered with.
- **API (`/api`):**
  - `checkout`: checks live stock in the Google Sheet, then opens a Stripe Checkout session.
  - `stock`: returns live sizes for the product page.
  - `stripe-webhook`: after payment, logs the order to a **Web Orders** tab and deducts the sold pairs from **Master Inventory**. Stripe retries the webhook, so it checks the log first and never deducts an order twice.
- **Data:** `lib/catalog.js` (generated) and `lib/shop-config.js`. Shipping, sale prices and limits live in `lib/shop-config.js`.

## Go-live checklist

### 1. Deploy
Import the GitHub repo into Vercel. Choose Framework **Other** and leave the build command empty.

### 2. Stripe (payments)
1. In the Stripe Dashboard, go to **Developers → API keys** and copy the **Secret key**. Use the test key (`sk_test_…`) first.
2. In Vercel, go to **Settings → Environment Variables** and add `STRIPE_SECRET_KEY`.
3. In Stripe, go to **Developers → Webhooks → Add endpoint**.
   - URL: `https://<your-domain>/api/stripe-webhook`
   - Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`
   - Copy the **Signing secret** into Vercel as `STRIPE_WEBHOOK_SECRET`.
4. GST on receipts: in Stripe, go to **Product catalog → Tax rates** and create **GST 10%, Australia, Inclusive**. Copy its ID (`txr_…`) into Vercel as `STRIPE_GST_RATE_ID`. Also add your ABN under **Settings → Business → Public details** so invoices count as tax invoices.
5. Payment methods: check that Cards, Apple Pay and Google Pay are on under **Settings → Payment methods**.
6. Optional: set `SITE_URL` (e.g. `https://yolo.com.au`) so Stripe returns customers to your main domain.

### 3. Google Sheet (live stock)
1. In Google Cloud Console, create a project, enable **Google Sheets API**, and create a **Service account**. Go to **Keys → Add key → JSON**.
2. Paste the whole JSON file into Vercel as `GOOGLE_SERVICE_ACCOUNT_JSON`.
3. Share **Yolo_StockRecord** with the service account's email (`…@….iam.gserviceaccount.com`) as **Editor**.
4. Keep the **Master Inventory** headers as they are: `Model`, `Colourway`, `39`…`43`, `Bulk`. The site matches rows by Model + Colourway, so a renamed row stops being sold. The Total and Stock Value formulas keep working.
5. The first paid order creates a **Web Orders** tab with each order's customer, address, items and total.

Without these variables, the site still works for browsing, and checkout uses the stock snapshot in `lib/catalog.js`.

### 4. Test, then go live
Redeploy after adding the variables. Buy with Stripe's test card `4242 4242 4242 4242` (any future date, any CVC). Check the Web Orders tab, the stock deduction and the Stripe receipt. Then swap in the live keys and a live webhook.

## Everyday edits
- **Shipping:** change `shipping.flatRate` and `shipping.freeOver` in `lib/shop-config.js`.
- **Sale price:** set it in `lib/shop-config.js` → `sales`, e.g. `"atlas-chelseaboots": 79`. The site and checkout both use it.
- **Homepage best seller:** `assets/js/config.js` → `offer.slug`.
- **Products:** regenerate `lib/catalog.js` with `scripts/build_data.py` (ask Claude), or edit it carefully. Each colourway's `sheet` must match a Master Inventory row.

## Known limits
- Stock is checked when checkout opens and deducted after payment. Two people buying the last pair within the same minute can still oversell; the Web Orders tab marks it `OVERSOLD` so you can refund one.
- Product gallery photos (after the first) load from theyolobrand.com. Main photos are hosted here with backgrounds removed.

Tests: `npm test` runs offline tests of checkout, stock and the webhook with Stripe and Google mocked.
