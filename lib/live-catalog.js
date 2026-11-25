// Browser: swap the built-in catalogue (lib/catalog.js) for the live one from /api/catalog, which includes
// what admins changed (names, prices, sale prices, photos, new or hidden products). Loaded right after
// catalog.js and shop-config.js; app.js waits for window.YOLO_CATALOG_READY (at most ~1.5 s, then it
// carries on with the built-in list so the shop never hangs).
if (typeof window !== "undefined") {
  window.YOLO_CATALOG_READY = (async () => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch("/api/catalog", { signal: ctl.signal }); clearTimeout(t);
      if (!res.ok) return;
      const { products } = await res.json();
      if (!Array.isArray(products) || !products.length) return;
      const list = window.YOLO_PRODUCTS || (window.YOLO_PRODUCTS = []);
      list.splice(0, list.length, ...products);          // same array object, so every module sees the update
    } catch { /* offline or slow: keep the built-in list */ }
  })();
}
