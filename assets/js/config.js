// Site-wide settings. Edit these, commit, and Vercel redeploys automatically.
window.YOLO_CONFIG = {
  brand: "YOLO Australia",
  tagline: "Your Own Limitless Originality",

  // Landing-page hero: the best-selling shoe that walks onto the screen.
  // To put it on sale, set its price in lib/shop-config.js -> sales (checkout uses that too).
  offer: {
    slug: "atlas-chelseaboots",
    offerNote: ""   // optional short line under the price, e.g. "Offer ends Sunday"
  },

  // Orders and enquiries. Leave whatsappNumber empty to hide WhatsApp buttons.
  // Use international format with no + or spaces, e.g. "61412345678".
  whatsappNumber: "",
  // TODO: confirm this is the inbox you want customer enquiries sent to.
  email: "yoloaustralia25@gmail.com",

  social: {
    instagram: "https://www.instagram.com/yolobrand_/",
    facebook: "https://www.facebook.com/theyolobrand",
    youtube: "https://www.youtube.com/@yolobrandnepal"
  }
};
