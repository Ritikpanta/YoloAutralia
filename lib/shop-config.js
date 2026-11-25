// Shop rules shared by the website and the checkout server. Edit here, commit, Vercel redeploys.
// The server always re-calculates prices and shipping from this file and the catalogue,
// so nothing a customer changes in their browser can alter what they pay.
export const SHOP = {
  currency: "aud",
  // All prices include GST.
  gstInclusive: true,

  shipping: {
    flatRate: 12,          // A$ per order. TODO: confirm with Ritik.
    freeOver: 150,         // A$ cart subtotal at or above which shipping is free. TODO: confirm.
    label: "Standard shipping (Australia)",
    freeLabel: "Free shipping (Australia)",
    countries: ["AU"]
  },

  // Sale prices (AUD incl. GST) by product slug. null = no sale. Checkout charges these.
  // e.g. "atlas-chelseaboots": 79
  sales: {
    "atlas-chelseaboots": null
  },

  maxQtyPerLine: 5,
  maxCartLines: 20,

  // Google Sheet that holds stock. Tab and header names must match the sheet.
  stockSheet: {
    id: "1srQaCTyp6SH-5zlWQ-MymbaqFsboR3LnzePDO7RnlfI",
    tab: "Master Inventory",
    ordersTab: "Web Orders"
  }
};

export function shippingFor(subtotal) {
  const s = SHOP.shipping;
  return subtotal >= s.freeOver ? 0 : s.flatRate;
}

// Price a customer pays for a product (sale price if one is set and lower). A sale price saved in the
// admin (product.sale) wins over the one in this file.
export function priceOf(product) {
  const sale = Number(product.sale ?? SHOP.sales?.[product.slug]);
  return sale > 0 && sale < product.price ? sale : product.price;
}

if (typeof window !== "undefined") { window.YOLO_SHOP = SHOP; window.YOLO_SHIPPING_FOR = shippingFor; window.YOLO_PRICE_OF = priceOf; }
export default SHOP;
