/* YOLO Australia — site behaviour (ES module, no build step, no dependencies).
   Loaded after /lib/catalog.js and /lib/shop-config.js, which set window.YOLO_PRODUCTS / YOLO_SHOP. */
const CFG = window.YOLO_CONFIG || {};
const PRODUCTS = window.YOLO_PRODUCTS || [];
const SHOP = window.YOLO_SHOP || { shipping: { flatRate: 0, freeOver: 0 }, maxQtyPerLine: 5, maxCartLines: 20 };
const shippingFor = window.YOLO_SHIPPING_FOR || (() => 0);

const CATEGORIES = {
  loafers: { label: "Loafers", blurb: "Penny, horsebit and monk-strap loafers." },
  formals: { label: "Formals", blurb: "Oxfords and derbies for the office and big days." },
  sneakers: { label: "Sneakers", blurb: "Everyday and dress sneakers." },
  boots: { label: "Boots", blurb: "Chelsea, zip-up and work boots." }
};
const SIZES = [39, 40, 41, 42, 43];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const canHover = window.matchMedia("(hover: hover)").matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const aud = (n) => "A$" + (Number(n) % 1 ? Number(n).toFixed(2) : Number(n).toFixed(0));
const bySlug = (s) => PRODUCTS.find((p) => p.slug === s);
const mainImg = (p) => p.cutout || p.images[0];
const isCut = (src) => /^\/assets\/img\/products\//.test(src || "");
const imgClass = (src) => (isCut(src) ? "cut" : "photo");
const gallery = (p) => (p.cutout ? [p.cutout, ...p.images.slice(1)] : p.images.slice());

/* ---------- Pricing & offer ---------- */
const offer = CFG.offer || {};
const priceNow = window.YOLO_PRICE_OF || ((p) => p.price); // same rule the checkout server uses
const onSale = (p) => priceNow(p) < p.price;
const priceHTML = (p) => (onSale(p) ? `${aud(priceNow(p))}<s>${aud(p.price)}</s>` : aud(p.price));

/* =========================================================
   Cart (stored in this browser; checkout re-prices on the server)
   ========================================================= */
const CART_KEY = "yolo-cart-v1";
const Cart = {
  items: [],
  load() { try { this.items = JSON.parse(localStorage.getItem(CART_KEY) || "[]").filter((i) => bySlug(i.slug)); } catch { this.items = []; } },
  save() { try { localStorage.setItem(CART_KEY, JSON.stringify(this.items)); } catch {} renderCart(); },
  count() { return this.items.reduce((n, i) => n + i.qty, 0); },
  add(item) {
    const same = this.items.find((i) => i.slug === item.slug && i.colour === item.colour && i.size === item.size && (i.note || "") === (item.note || ""));
    if (same) same.qty = Math.min(SHOP.maxQtyPerLine, same.qty + item.qty);
    else if (this.items.length < SHOP.maxCartLines) this.items.push(item);
    this.save();
  },
  setQty(idx, qty) { if (qty <= 0) this.items.splice(idx, 1); else this.items[idx].qty = Math.min(SHOP.maxQtyPerLine, qty); this.save(); },
  clear() { this.items = []; this.save(); },
  lines() {
    return this.items.map((i) => {
      const p = bySlug(i.slug); const c = p.colourways.find((x) => x.slug === i.colour);
      return { ...i, p, colourName: c ? c.name : i.note || "", amount: priceNow(p) * i.qty };
    });
  }
};

function openCart(open = true) {
  $("#cart-drawer")?.classList.toggle("open", open);
  $("#cart-overlay")?.classList.toggle("open", open);
  $("#cart-drawer")?.setAttribute("aria-hidden", String(!open));
  if (open) setTimeout(() => $("#cart-close")?.focus(), 50);
}

function renderCart() {
  const count = Cart.count();
  $$(".cart-btn .count").forEach((el) => { el.textContent = count; });
  const list = $("#cart-items"), foot = $("#cart-foot");
  if (!list) return;
  const lines = Cart.lines();
  if (!lines.length) {
    list.innerHTML = `<div class="cart-empty"><p>Your cart is empty.</p><a class="btn" href="/shop">Shop the range</a></div>`;
    foot.hidden = true; return;
  }
  foot.hidden = false;
  list.innerHTML = lines.map((l, i) => `
    <div class="cart-line">
      <a class="thumb" href="/product?m=${encodeURIComponent(l.slug)}"><img class="${imgClass(mainImg(l.p))}" src="${esc(mainImg(l.p))}" alt=""></a>
      <div>
        <h3>${esc(l.p.name)}</h3>
        <div class="meta">${[l.colourName, "EU " + l.size].filter(Boolean).map(esc).join(" · ")}</div>
        <div class="qty" role="group" aria-label="Quantity for ${esc(l.p.name)}">
          <button type="button" data-i="${i}" data-d="-1" aria-label="One less">−</button><span>${l.qty}</span><button type="button" data-i="${i}" data-d="1" aria-label="One more" ${l.qty >= SHOP.maxQtyPerLine ? "disabled" : ""}>+</button>
        </div>
      </div>
      <div style="text-align:right"><div class="price">${aud(l.amount)}</div><button type="button" class="remove" data-rm="${i}">Remove</button></div>
    </div>`).join("");
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const ship = shippingFor(subtotal);
  const toFree = Math.max(0, SHOP.shipping.freeOver - subtotal);
  $("#cart-subtotal").textContent = aud(subtotal);
  $("#cart-shipping").textContent = ship ? aud(ship) : "Free";
  $("#cart-total").textContent = aud(subtotal + ship);
  $("#cart-ship-note").textContent = toFree > 0 ? `Add ${aud(toFree)} more for free shipping.` : "You've got free shipping.";
  $("#cart-meter").style.width = `${Math.min(100, (subtotal / SHOP.shipping.freeOver) * 100)}%`;
  $("#cart-error").textContent = "";
}

function mountCart() {
  document.body.insertAdjacentHTML("beforeend", `
    <div class="cart-overlay" id="cart-overlay"></div>
    <aside class="cart-drawer" id="cart-drawer" aria-label="Shopping cart" aria-hidden="true">
      <div class="cart-head"><h2>Your cart</h2><button class="icon-btn" id="cart-close" type="button" aria-label="Close cart">×</button></div>
      <div class="cart-items" id="cart-items"></div>
      <div class="cart-foot" id="cart-foot">
        <div class="ship-meter" aria-hidden="true"><i id="cart-meter"></i></div>
        <p class="cart-note" id="cart-ship-note"></p>
        <div class="cart-row"><span>Subtotal</span><span id="cart-subtotal"></span></div>
        <div class="cart-row"><span>Shipping</span><span id="cart-shipping"></span></div>
        <div class="cart-row total"><span>Total</span><span id="cart-total"></span></div>
        <p class="cart-note">Prices in AUD, including GST.</p>
        <p class="cart-error" id="cart-error" role="alert"></p>
        <button class="btn btn-primary btn-block" id="checkout-btn" type="button">Checkout securely</button>
        <p class="cart-note" style="text-align:center">Pay by card, Apple Pay or Google Pay via Stripe.</p>
      </div>
    </aside>`);
  $("#cart-overlay").addEventListener("click", () => openCart(false));
  $("#cart-close").addEventListener("click", () => openCart(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") openCart(false); });
  $("#cart-items").addEventListener("click", (e) => {
    const q = e.target.closest("[data-d]"), r = e.target.closest("[data-rm]");
    if (q) { const i = Number(q.dataset.i); Cart.setQty(i, Cart.items[i].qty + Number(q.dataset.d)); }
    if (r) Cart.setQty(Number(r.dataset.rm), 0);
  });
  $("#checkout-btn").addEventListener("click", checkout);
  Cart.load(); renderCart();
  if (new URLSearchParams(location.search).get("cart") === "open") openCart(true);
}

async function checkout() {
  const btn = $("#checkout-btn"), err = $("#cart-error");
  btn.disabled = true; btn.textContent = "Opening secure checkout…"; err.textContent = "";
  try {
    const res = await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: Cart.items }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) { location.href = data.url; return; }
    err.textContent = data.error || "Checkout isn't available right now. Please try again.";
  } catch {
    err.textContent = "Couldn't reach checkout. Check your connection and try again.";
  }
  btn.disabled = false; btn.textContent = "Checkout securely";
}

/* ---------- Header & footer ---------- */
function renderChrome() {
  const page = document.body.dataset.page || "";
  const cat = new URLSearchParams(location.search).get("c");
  const link = (href, label, current) => `<a href="${href}"${current ? ' aria-current="page"' : ""}>${label}</a>`;
  const logo = `<a class="brand" href="/" aria-label="YOLO Australia home"><span class="logo" aria-hidden="true"><span>Y</span><span>O</span><span>L</span><span>O</span></span><span class="wordmark">Australia</span></a>`;
  const header = $("#site-header");
  if (header) {
    header.innerHTML = `
      <div class="wrap">
        ${logo}
        <nav class="nav" id="nav" aria-label="Main">
          ${link("/shop", "Shop all", page === "shop" && !cat)}
          ${Object.entries(CATEGORIES).map(([k, v]) => link(`/shop?c=${k}`, v.label, page === "shop" && cat === k)).join("")}
          ${link("/try-on", "Try on", page === "try-on")}
          ${link("/contact", "Contact", page === "contact")}
        </nav>
        <div class="header-actions">
          <button class="cart-btn" type="button" aria-label="Open cart"><span class="label">Cart</span> <span class="count">0</span></button>
          <button class="nav-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="nav"><span></span><span></span><span></span></button>
        </div>
      </div>`;
    const toggle = $(".nav-toggle", header), nav = $(".nav", header);
    toggle.addEventListener("click", () => { const open = nav.classList.toggle("open"); toggle.setAttribute("aria-expanded", String(open)); });
    $(".cart-btn", header).addEventListener("click", () => openCart(true));
    const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 30);
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  }
  const footer = $("#site-footer");
  if (footer) {
    const s = CFG.social || {};
    footer.innerHTML = `
      <div class="wrap">
        <div class="footer-grid">
          <div>${logo}<p class="lede">${esc(CFG.tagline || "")}. Shipped across Australia.</p></div>
          <div><h4>Shop</h4>${Object.entries(CATEGORIES).map(([k, v]) => `<a href="/shop?c=${k}">${v.label}</a>`).join("")}</div>
          <div><h4>Help</h4><a href="/contact">Contact us</a><a href="/contact#faq">Sizing &amp; delivery</a></div>
          <div><h4>Follow</h4>
            ${s.instagram ? `<a href="${esc(s.instagram)}" target="_blank" rel="noopener">Instagram</a>` : ""}
            ${s.facebook ? `<a href="${esc(s.facebook)}" target="_blank" rel="noopener">Facebook</a>` : ""}
            ${s.youtube ? `<a href="${esc(s.youtube)}" target="_blank" rel="noopener">YouTube</a>` : ""}
          </div>
        </div>
        <div class="footer-bottom"><span>© ${new Date().getFullYear()} ${esc(CFG.brand || "YOLO")}. All rights reserved.</span><span>Prices in AUD, including GST.</span></div>
      </div>`;
  }
}

/* ---------- Product card ---------- */
function productCard(p) {
  const img = mainImg(p);
  const swatches = p.colourways.slice(0, 8).map((c) => `<span class="swatch" style="background:${c.hex}" title="${esc(c.name)}"></span>`).join("");
  const tag = onSale(p) ? `<span class="badge card-tag"><i></i>Sale</span>` : offer.slug === p.slug ? `<span class="badge card-tag"><i></i>Best seller</span>` : "";
  return `<a class="card tilt reveal" href="/product?m=${encodeURIComponent(p.slug)}">
      <div class="card-media">${tag}${img ? `<img class="${imgClass(img)}" src="${esc(img)}" alt="${esc(p.name)}" loading="lazy" decoding="async">` : ""}</div>
      <div class="card-body depth-1">
        <div><h3>${esc(p.name)}</h3><div class="cat">${esc(CATEGORIES[p.category].label)}${p.colourways.length ? ` · ${p.colourways.length} colour${p.colourways.length > 1 ? "s" : ""}` : ""}</div></div>
        <div class="price">${priceHTML(p)}</div>
      </div>
      <div class="swatches">${swatches}</div>
    </a>`;
}

/* ---------- 3D tilt + reveal ---------- */
function bindTilt(root = document) {
  if (reduceMotion || !canHover) return;
  $$(".tilt", root).forEach((el) => {
    if (el.dataset.tiltBound) return;
    el.dataset.tiltBound = "1";
    const max = Number(el.dataset.tiltMax || 10);
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transition = "transform .1s linear";
      el.style.transform = `perspective(900px) rotateY(${x * max}deg) rotateX(${-y * max}deg)`;
    });
    el.addEventListener("pointerleave", () => { el.style.transition = ""; el.style.transform = ""; });
  });
}
let revealObserver;
function bindReveal(root = document) {
  const items = $$(".reveal:not(.in)", root);
  if (!("IntersectionObserver" in window) || reduceMotion) { items.forEach((el) => el.classList.add("in")); return; }
  revealObserver = revealObserver || new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); revealObserver.unobserve(e.target); } });
  }, { rootMargin: "0px 0px -8% 0px" });
  items.forEach((el, i) => { el.style.transitionDelay = `${(i % 4) * 70}ms`; revealObserver.observe(el); });
}

/* ---------- Motion helpers ---------- */
function splitTitle(el, text) {
  if (!el) return;
  el.setAttribute("aria-label", text);
  let i = 0;
  el.innerHTML = text.split(" ").map((w) => `<span class="word" aria-hidden="true">${[...w].map((c) => `<span class="ch" style="animation-delay:${0.2 + 0.035 * i++}s">${esc(c)}</span>`).join("")}</span>`).join(" ");
}
function bindMagnetic() {
  if (reduceMotion || !canHover) return;
  $$(".magnetic").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.25}px, ${(e.clientY - r.top - r.height / 2) * 0.35}px)`;
    });
    el.addEventListener("pointerleave", () => { el.style.transform = ""; });
  });
}
function bindProgress() {
  const bar = document.createElement("div"); bar.className = "progress"; document.body.appendChild(bar);
  const upd = () => { const h = document.documentElement.scrollHeight - innerHeight; bar.style.width = `${h > 0 ? (scrollY / h) * 100 : 0}%`; };
  addEventListener("scroll", upd, { passive: true }); upd();
}

/* ---------- Landing hero ---------- */
function initHero() {
  const hero = $("#hero");
  const p = bySlug(offer.slug) || PRODUCTS[0];
  if (!hero || !p) return;
  splitTitle($("#hero-name"), p.name.replace(/\s+boot$/i, ""));
  const tryBtn = $("#hero-try"); if (tryBtn) tryBtn.href = `/try-on?m=${encodeURIComponent(p.slug)}`;
  $("#hero-sub").textContent = /boot$/i.test(p.name) ? "Boot" : CATEGORIES[p.category].label;
  $("#hero-desc").textContent = p.description || "";
  $("#hero-badge").innerHTML = `<i></i>${onSale(p) ? "On sale" : "Best seller"}`;
  $("#hero-offer").innerHTML = `<span class="now">${aud(priceNow(p))}</span>${onSale(p) ? `<span class="was">${aud(p.price)}</span>` : ""}${offer.offerNote ? `<span class="note">${esc(offer.offerNote)}</span>` : ""}`;
  $("#hero-cta").href = `/product?m=${encodeURIComponent(p.slug)}`;

  // CSS fallback animation (used when three.js / WebGL isn't available)
  const stage = $("#run-stage"), runner = $("#runner"), hopEl = $(".hop", runner), img = $("img", hopEl);
  const shot = p.cutoutSide || mainImg(p);
  img.src = shot; img.className = imgClass(shot); img.alt = p.name;
  let running = false;
  async function run() {
    if (running || stage.classList.contains("three")) return;
    running = true; runner.classList.remove("settled");
    if (reduceMotion || !runner.animate) { runner.classList.add("settled"); running = false; return; }
    runner.animate([{ transform: "translateX(-120vw)" }, { transform: "translateX(0)" }], { duration: 1600, easing: "cubic-bezier(.16,.8,.24,1)", fill: "both" });
    for (const [dur, h, rot] of [[340, 60, -8], [320, 44, -6], [300, 26, -4], [280, 12, -2]]) {
      await hopEl.animate([{ transform: "translateY(0) rotate(0)" }, { transform: `translateY(${-h}px) rotate(${rot}deg)`, offset: 0.45 }, { transform: "translateY(0) rotate(0)" }], { duration: dur, easing: "ease-in-out" }).finished;
    }
    runner.classList.add("settled"); running = false;
  }
  $("#replay").addEventListener("click", () => {
    if (stage.classList.contains("three")) window.dispatchEvent(new Event("hero:replay")); else run();
  });
  const startFallback = () => { if (!stage.classList.contains("three")) run(); };
  // hero3d.js sets YOLO_HERO3D = "loading" | "ready" | "failed"
  if (window.YOLO_HERO3D === "failed" || !window.YOLO_HERO3D) startFallback();
  window.addEventListener("hero3d:failed", startFallback);
}

/* ---------- Home sections ---------- */
function initHome() {
  const cats = $("#categories");
  if (cats) {
    const coverFor = { loafers: "polo-horsebit-loafers", formals: "odin", sneakers: "series-001", boots: "zane-zipper-boot" };
    cats.innerHTML = Object.entries(CATEGORIES).map(([key, c]) => {
      const n = PRODUCTS.filter((p) => p.category === key).length;
      const cover = bySlug(coverFor[key]) || PRODUCTS.find((p) => p.category === key);
      const src = cover && mainImg(cover);
      return `<a class="cat-tile tilt reveal" data-tilt-max="8" href="/shop?c=${key}">
          <span class="count">${n} styles</span>
          <div class="art depth-2${src && !isCut(src) ? " blend" : ""}">${src ? `<img class="${imgClass(src)}" src="${esc(src)}" alt="" loading="lazy">` : ""}</div>
          <h3 class="depth-1">${c.label}</h3><p class="depth-1">${c.blurb}</p>
        </a>`;
    }).join("");
  }
  const featured = $("#featured");
  if (featured) {
    const picks = ["atlas-chelseaboots", "odin", "polo-horsebit-loafers", "series-001", "capri", "zane-zipper-boot", "monks", "builder-boots"];
    featured.innerHTML = picks.map(bySlug).filter(Boolean).map(productCard).join("");
  }
}

/* ---------- Shop ---------- */
function initCarousel(list) {
  // CSS 3D fallback; shop3d.js replaces it with a three.js turntable when WebGL is available.
  const wrap = $("#carousel-wrap"), ring = $("#carousel");
  if (!wrap || !ring) return;
  const items = list.slice(0, 10); const n = items.length;
  if (n < 3) { wrap.hidden = true; return; }
  const radius = Math.round(((ring.offsetWidth || 230) + 40) / (2 * Math.tan(Math.PI / n)));
  ring.innerHTML = items.map((p, i) => `
    <a class="c-item" href="/product?m=${encodeURIComponent(p.slug)}" style="transform: rotateY(${(360 / n) * i}deg) translateZ(${radius}px)" draggable="false">
      <img class="${imgClass(mainImg(p))}" src="${esc(mainImg(p))}" alt="${esc(p.name)}" loading="lazy" draggable="false">
      <div><h3>${esc(p.name)}</h3><div class="price">${priceHTML(p)}</div></div>
    </a>`).join("");
  let angle = 0, velocity = reduceMotion ? 0 : -0.12, dragging = false, moved = 0, lastX = 0;
  const apply = () => { ring.style.transform = `translateZ(${-radius}px) rotateY(${angle}deg)`; };
  const tick = () => { if (!dragging) { angle += velocity; velocity += (-0.12 - velocity) * 0.02; apply(); } if (!$("#shop3d")?.classList.contains("three")) requestAnimationFrame(tick); };
  apply(); if (!reduceMotion) requestAnimationFrame(tick);
  wrap.addEventListener("pointerdown", (e) => { dragging = true; moved = 0; lastX = e.clientX; });
  window.addEventListener("pointermove", (e) => { if (!dragging) return; const dx = e.clientX - lastX; lastX = e.clientX; moved += Math.abs(dx); angle += dx * 0.3; velocity = dx * 0.3; apply(); });
  window.addEventListener("pointerup", () => { dragging = false; });
  wrap.addEventListener("click", (e) => { if (moved > 6) { e.preventDefault(); e.stopPropagation(); } }, true);
}

function initShop() {
  const grid = $("#shop-grid");
  if (!grid) return;
  const params = new URLSearchParams(location.search);
  const state = { cat: CATEGORIES[params.get("c")] ? params.get("c") : "all", colour: "all", sort: "featured" };
  const colours = Array.from(new Set(PRODUCTS.flatMap((p) => p.colourways.map((c) => c.base)))).filter((c) => c !== "Assorted").sort();
  const catChips = $("#cat-filters");
  catChips.innerHTML = [["all", "All"], ...Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])]
    .map(([k, l]) => `<button type="button" class="chip" data-cat="${k}" aria-pressed="${state.cat === k}">${l}</button>`).join("");
  const colourSel = $("#colour-filter");
  colourSel.innerHTML = `<option value="all">All colours</option>` + colours.map((c) => `<option value="${c}">${c}</option>`).join("");
  const showcase = (state.cat === "all" ? PRODUCTS : PRODUCTS.filter((p) => p.category === state.cat)).filter((p) => p.cutout);
  window.YOLO_SHOWCASE = showcase.slice(0, 12);
  window.dispatchEvent(new Event("shop:showcase"));
  initCarousel(showcase);

  function render() {
    let list = PRODUCTS.filter((p) => (state.cat === "all" || p.category === state.cat) && (state.colour === "all" || p.colourways.some((c) => c.base === state.colour)));
    if (state.sort === "price-asc") list = list.slice().sort((a, b) => a.price - b.price);
    if (state.sort === "price-desc") list = list.slice().sort((a, b) => b.price - a.price);
    if (state.sort === "name") list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
    grid.innerHTML = list.length ? list.map(productCard).join("") : `<p class="empty">No styles match those filters.</p>`;
    $("#result-count").textContent = `${list.length} style${list.length === 1 ? "" : "s"}`;
    $("#shop-title").textContent = state.cat === "all" ? "Shop all" : CATEGORIES[state.cat].label;
    $$(".chip", catChips).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cat === state.cat)));
    bindTilt(grid); bindReveal(grid);
  }
  catChips.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    state.cat = b.dataset.cat;
    const url = new URL(location.href);
    if (state.cat === "all") url.searchParams.delete("c"); else url.searchParams.set("c", state.cat);
    history.replaceState(null, "", url);
    render();
  });
  colourSel.addEventListener("change", () => { state.colour = colourSel.value; render(); });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
  render();
}

/* ---------- Product page ---------- */
function initProduct() {
  const root = $("#pdp");
  if (!root) return;
  const params = new URLSearchParams(location.search);
  const p = bySlug(params.get("m"));
  if (!p) { root.innerHTML = `<div><h1>Style not found</h1><p class="lede">That shoe isn't in the range any more. <a href="/shop">Browse all styles</a>.</p></div>`; return; }
  document.title = `${p.name} — ${CFG.brand}`;
  $('meta[name="description"]')?.setAttribute("content", `${p.name} by YOLO. ${aud(priceNow(p))}. ${p.description || CATEGORIES[p.category].blurb} Shipped across Australia.`);

  let colour = p.colourways.find((c) => c.slug === params.get("c")) || p.colourways[0] || null;
  let fitPanel = null;
  let size = SIZES.includes(Number(params.get("s"))) ? Number(params.get("s")) : null, live = null; // live: from /api/stock

  root.innerHTML = `
    <div class="gallery">
      <div class="stage" id="stage">
        <div class="grid-bg"></div><div class="plinth"></div>
        <div class="turntable" id="turntable"><img class="cut" id="main-img" alt="" draggable="false"></div>
        <div class="stage-hint">Drag to turn</div>
      </div>
      <div class="thumbs" id="thumbs"></div>
    </div>
    <div>
      <div class="breadcrumb"><a href="/shop">Shop</a> / <a href="/shop?c=${p.category}">${CATEGORIES[p.category].label}</a></div>
      ${onSale(p) ? `<span class="badge"><i></i>On sale</span>` : offer.slug === p.slug ? `<span class="badge"><i></i>Best seller</span>` : ""}
      <h1>${esc(p.name)}</h1>
      <div class="price-lg">${aud(priceNow(p))}${onSale(p) ? `<s>${aud(p.price)}</s>` : ""}</div>
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ""}
      <div id="colour-block">
        <div class="opt-label">Colour <b id="colour-name"></b></div>
        <div class="colour-opts" id="colour-opts"></div>
      </div>
      <div class="opt-label">Size (EU) <b id="size-name"></b><span class="live-dot" id="live-dot" hidden>Live stock</span></div>
      <div class="size-opts" id="size-opts"></div>
      <p class="size-note" id="size-note"></p>
      <div class="enquire">
        <button class="btn btn-primary" id="add-btn" type="button">Add to cart</button>
        <a class="btn" id="try-btn" href="#try-on">Try it on in 3D</a>
      </div>
      <p class="size-note" id="add-msg" role="status"></p>
      <ul class="pdp-points">
        <li><strong>Category</strong> ${CATEGORIES[p.category].label}</li>
        <li><strong>Delivery</strong> Australia-wide. ${aud(SHOP.shipping.flatRate)} flat, free over ${aud(SHOP.shipping.freeOver)}.</li>
        <li><strong>Payment</strong> Card, Apple Pay or Google Pay, secured by Stripe.</li>
      </ul>
    </div>`;

  const pics = gallery(p);
  const mainEl = $("#main-img"), table = $("#turntable");
  function showImage(i) {
    mainEl.src = pics[i]; mainEl.className = imgClass(pics[i]);
    table.classList.toggle("blend", !isCut(pics[i]));
    mainEl.alt = `${p.name}, photo ${i + 1} of ${pics.length}`;
    $$("#thumbs button").forEach((b, k) => b.setAttribute("aria-pressed", String(k === i)));
  }
  $("#thumbs").innerHTML = pics.length > 1 ? pics.map((src, i) => `<button type="button" aria-label="Photo ${i + 1}" aria-pressed="false"><img class="${imgClass(src)}" src="${esc(src)}" alt="" loading="lazy"></button>`).join("") : "";
  $$("#thumbs button").forEach((b, i) => b.addEventListener("click", () => showImage(i)));
  showImage(0);
  bindTurntable($("#stage"), table);

  const colourOpts = $("#colour-opts");
  if (!p.colourways.length) {
    $("#colour-block").innerHTML = p.variants && p.variants.length
      ? `<div class="opt-label"><label for="pref">Preferred colour</label></div><select class="pref-select" id="pref">${p.variants.map((v) => `<option>${esc(v)}</option>`).join("")}</select><p class="size-note">We'll confirm your colour after you order. If it's unavailable, we'll offer a swap or a full refund.</p>`
      : "";
  } else {
    colourOpts.innerHTML = p.colourways.map((c) => `<button type="button" class="colour-opt" data-c="${c.slug}" aria-pressed="false"><span class="swatch" style="background:${c.hex}"></span>${esc(c.name)}</button>`).join("");
    colourOpts.addEventListener("click", (e) => {
      const b = e.target.closest(".colour-opt"); if (!b) return;
      colour = p.colourways.find((c) => c.slug === b.dataset.c);
      if (size && stockFor(size) <= 0) size = null;
      const url = new URL(location.href); url.searchParams.set("c", colour.slug); history.replaceState(null, "", url);
      update();
      fitPanel?.refresh();
    });
  }
  const sizeOpts = $("#size-opts");
  sizeOpts.addEventListener("click", (e) => {
    const b = e.target.closest(".size-opt"); if (!b || b.disabled) return;
    size = Number(b.dataset.s); update();
  });

  // Stock for a size: live sheet data when available, otherwise the catalogue's snapshot
  function stockFor(s) {
    if (live) {
      const m = colour ? live.colours?.[colour.slug] : live.any;
      return m ? m[s] || 0 : 0;
    }
    const sizes = colour && colour.sizes;
    return !sizes || sizes.includes(s) ? 1 : 0;
  }

  function update() {
    if (colour) {
      $("#colour-name").textContent = colour.name;
      $$(".colour-opt", colourOpts).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.c === colour.slug)));
    }
    const anyStock = SIZES.some((s) => stockFor(s) > 0);
    sizeOpts.innerHTML = SIZES.map((s) => {
      const n = stockFor(s);
      return `<button type="button" class="size-opt" data-s="${s}" ${n > 0 ? "" : "disabled"} aria-pressed="${size === s}" ${live && n > 0 && n <= 2 ? `title="Only ${n} left"` : ""}>${s}</button>`;
    }).join("");
    $("#live-dot").hidden = !live;
    $("#size-name").textContent = size ? `EU ${size}` : "";
    const low = live && size ? stockFor(size) : 0;
    $("#size-note").textContent = !anyStock ? "Sold out in this colour. Message us to ask about restocks."
      : size && live && low <= 2 ? `Only ${low} left in EU ${size}.`
      : "Crossed-out sizes are sold out in this colour.";
    const addBtn = $("#add-btn");
    addBtn.disabled = !anyStock;
    addBtn.textContent = !anyStock ? "Sold out" : size ? `Add to cart — EU ${size}` : "Add to cart";
  }

  $("#add-btn").addEventListener("click", () => {
    const msg = $("#add-msg");
    if (!size) { msg.textContent = "Choose your size first."; sizeOpts.querySelector(".size-opt:not([disabled])")?.focus(); return; }
    Cart.add({ slug: p.slug, colour: colour ? colour.slug : null, size, qty: 1, note: $("#pref")?.value || "" });
    msg.textContent = `Added ${p.name}${colour ? " (" + colour.name + ")" : ""}, EU ${size}.`;
    $$(".cart-btn").forEach((b) => { b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump"); });
    openCart(true);
  });

  update();

  // Try it on in 3D, right on the product page
  root.insertAdjacentHTML("afterend", `
    <section class="fit-section wrap" id="try-on">
      <div class="section-head"><div><p class="eyebrow">Try it on</p><h2>See ${esc(p.name)} on you</h2></div></div>
      <div id="pdp-fit"></div>
    </section>`);
  import("/assets/js/tryon.js?v=10").then(({ mountFitPanel }) => {
    fitPanel = mountFitPanel(document.getElementById("pdp-fit"), {
      products: PRODUCTS, slug: p.slug,
      getColour: () => (colour ? { hex: colour.hex, name: colour.name } : null),
      onPickSize: (eu) => {
        if (stockFor(eu) > 0) { size = eu; update(); $("#add-msg").textContent = `EU ${eu} selected. Add it to your cart when you're ready.`; }
        else $("#add-msg").textContent = `EU ${eu} is sold out in this colour. Try another colour or message us about restocks.`;
        document.getElementById("add-btn").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      }
    });
  }).catch((e) => console.info("Fit panel unavailable", e));
  fetch(`/api/stock?slug=${encodeURIComponent(p.slug)}`).then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && d.live) { live = d; if (size && stockFor(size) <= 0) size = null; update(); }
  }).catch(() => {});
}

function bindTurntable(stage, table) {
  if (!stage || !table) return;
  let rotY = 0, rotX = 0, dragging = false, lastX = 0, lastY = 0, idle = !reduceMotion; const t0 = performance.now();
  const apply = () => { table.style.transform = `rotateX(${rotX}deg) rotateY(${rotY}deg)`; };
  const tick = (t) => { if (idle && !dragging) { rotY = Math.sin((t - t0) / 1800) * 16; rotX = 4; apply(); } if (idle) requestAnimationFrame(tick); };
  if (!reduceMotion) requestAnimationFrame(tick);
  stage.addEventListener("pointerdown", (e) => { dragging = true; idle = false; lastX = e.clientX; lastY = e.clientY; stage.setPointerCapture(e.pointerId); stage.style.cursor = "grabbing"; });
  stage.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    rotY = Math.max(-45, Math.min(45, rotY + (e.clientX - lastX) * 0.45));
    rotX = Math.max(-12, Math.min(22, rotX - (e.clientY - lastY) * 0.3));
    lastX = e.clientX; lastY = e.clientY; apply();
  });
  const end = () => { dragging = false; stage.style.cursor = ""; };
  stage.addEventListener("pointerup", end); stage.addEventListener("pointercancel", end);
}

/* ---------- Contact page ---------- */
function initContact() {
  const form = $("#enquiry-form");
  if (!form) return;
  const productSel = $("#f-product");
  productSel.innerHTML = `<option value="">General enquiry</option>` + PRODUCTS.map((p) => `<option value="${p.slug}">${esc(p.name)} — ${aud(priceNow(p))}</option>`).join("");
  const params = new URLSearchParams(location.search);
  const p = bySlug(params.get("m"));
  if (p) {
    productSel.value = p.slug;
    const c = p.colourways.find((x) => x.slug === params.get("c"));
    $("#f-message").value = `I'm interested in ${p.name}${c ? " in " + c.name : ""}${params.get("s") ? ", size EU " + params.get("s") : ""}.\n\n`;
  }
  const mail = (subject, body) => (CFG.email ? `mailto:${CFG.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : "");
  $("#contact-details").innerHTML =
    (CFG.email ? `<p>Email: <a href="mailto:${esc(CFG.email)}">${esc(CFG.email)}</a></p>` : "") +
    (CFG.whatsappNumber ? `<p>WhatsApp: <a href="https://wa.me/${esc(CFG.whatsappNumber)}" target="_blank" rel="noopener">Message us</a></p>` : "");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form); const prod = bySlug(data.get("product"));
    const body = [`Name: ${data.get("name")}`, `Email: ${data.get("email")}`, data.get("phone") ? `Phone: ${data.get("phone")}` : null,
      data.get("postcode") ? `Postcode: ${data.get("postcode")}` : null, prod ? `Product: ${prod.name}` : null, "", String(data.get("message") || "")].filter((l) => l !== null).join("\n");
    const href = mail(prod ? `Enquiry: ${prod.name}` : "Website enquiry", body);
    if (href) window.location.href = href;
    $("#form-status").textContent = `Your email app should open with your message ready to send. If it doesn't, email us at ${CFG.email || ""}.`;
  });
}

/* ---------- Order success ---------- */
function initSuccess() {
  if (document.body.dataset.page !== "success") return;
  Cart.clear();
}

function boot() {
  renderChrome();
  mountCart();
  initHero(); initHome(); initShop(); initProduct(); initContact(); initSuccess();
  bindTilt(); bindReveal(); bindMagnetic(); bindProgress();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();

export { Cart, openCart };
