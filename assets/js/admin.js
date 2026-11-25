/* YOLO store admin (/yolo-admin). Google sign-in for listed admin emails only; every request is checked on the
   server (api/admin.js). Reads and writes the Yolo_StockRecord Google Sheet: Master Inventory (stock), Web Orders
   (sales), Website Products (product edits), Customers, Admin Log. */
const root = document.getElementById("admin-root");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const aud = (n, dp = 0) => "A$" + Number(n || 0).toLocaleString("en-AU", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const SIZES = [39, 40, 41, 42, 43];
const CATS = { loafers: "Loafers", formals: "Formals", sneakers: "Sneakers", boots: "Boots" };
const api = async (a, body, qs = "") => {
  const res = await fetch(`/api/admin?a=${a}${qs}`, body === undefined ? { credentials: "same-origin" } :
    { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && a !== "login") { signInScreen("Your session ended. Please sign in again."); throw new Error("signed out"); }
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
};
let me = null, cfg = {}, view = "overview", inventoryRows = [];

// ---------------- sign in ----------------
function signInScreen(msg = "") {
  root.className = "adm-login";
  root.innerHTML = `
    <div class="adm-login-card">
      <div class="adm-logo" aria-hidden="true"><span>Y</span><span>O</span><span>L</span><span>O</span></div>
      <h1>Store admin</h1>
      <p>Sign in with the Google account you were given admin access with.</p>
      <div data-o="g" class="adm-g"></div>
      <p class="adm-err" role="alert">${esc(msg)}</p>
      ${cfg.ready ? "" : `<p class="adm-note">Admin sign-in isn't switched on yet. It needs SESSION_SECRET, GOOGLE_CLIENT_ID and ADMIN_EMAILS set on Vercel.</p>`}
    </div>`;
  if (!cfg.google) return;
  const draw = () => {
    google.accounts.id.initialize({ client_id: cfg.google, ux_mode: "popup", callback: async ({ credential }) => {
      try { me = (await api("login", { credential })).admin; shell(); } catch (e) { root.querySelector(".adm-err").textContent = e.message; }
    } });
    google.accounts.id.renderButton(root.querySelector('[data-o="g"]'), { theme: "filled_black", size: "large", shape: "pill", text: "signin_with", width: 300 });
  };
  if (window.google?.accounts?.id) draw();
  else { const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = draw; document.head.append(s); }
}

// ---------------- layout ----------------
const NAV = [["overview", "Overview"], ["orders", "Orders"], ["inventory", "Inventory"], ["products", "Products"], ["customers", "Customers"], ["log", "Activity"]];
function shell() {
  root.className = "adm";
  root.innerHTML = `
    <aside class="adm-side">
      <a class="adm-brand" href="/" title="View the shop"><span class="adm-logo" aria-hidden="true"><span>Y</span><span>O</span><span>L</span><span>O</span></span><b>Admin</b></a>
      <nav>${NAV.map(([k, l]) => `<button type="button" data-v="${k}" aria-current="${k === view}">${l}</button>`).join("")}</nav>
      <div class="adm-me"><span>${esc(me.name || me.email)}</span><small>${esc(me.email)}</small><button type="button" data-a="out">Sign out</button></div>
    </aside>
    <main class="adm-main" id="adm-main"></main>
    <div class="adm-toast" role="status" aria-live="polite"></div>`;
  root.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => go(b.dataset.v)));
  root.querySelector('[data-a="out"]').addEventListener("click", async () => { await api("logout", {}).catch(() => {}); me = null; signInScreen(); });
  go(location.hash.slice(1) || "overview");
}
function go(v) {
  if (!NAV.some(([k]) => k === v)) v = "overview";
  view = v; history.replaceState(null, "", "#" + v);
  root.querySelectorAll("[data-v]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.v === v)));
  const main = document.getElementById("adm-main");
  main.innerHTML = `<p class="adm-loading">Loading…</p>`;
  ({ overview, orders, inventory, products, customers, log })[v](main).catch((e) => { if (e.message !== "signed out") main.innerHTML = `<p class="adm-err">${esc(e.message)}</p>`; });
}
function toast(t) { const el = root.querySelector(".adm-toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 3500); }
const head = (title, sub = "", right = "") => `<header class="adm-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div class="adm-head-r">${right}</div></header>`;

// ---------------- charts (SVG, single series, hover tooltips) ----------------
function barChart(points, { fmt = (v) => v, label = (p) => p.x, height = 220, title = "" } = {}) {
  const W = 760, H = height, L = 52, R = 10, T = 12, B = 30;
  const max = Math.max(1, ...points.map((p) => p.y));
  const nice = (m) => { const e = Math.pow(10, Math.floor(Math.log10(m))); return Math.ceil(m / e / (m / e > 5 ? 2 : 1)) * e * (m / e > 5 ? 2 : 1); };
  const top = nice(max), n = points.length, slot = (W - L - R) / Math.max(1, n), bw = Math.max(2, Math.min(28, slot - 2));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const ticks = [0, top / 2, top];
  const every = Math.ceil(n / 8);
  return `<figure class="adm-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    ${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" class="ax">${esc(fmt(t))}</text>`).join("")}
    ${points.map((p, i) => {
      const x = L + i * slot + (slot - bw) / 2, h = Math.max(0, y(0) - y(p.y)), r = Math.min(4, bw / 2, h);
      const path = h > 0 ? `M${x},${y(0)} V${y(p.y) + r} Q${x},${y(p.y)} ${x + r},${y(p.y)} H${x + bw - r} Q${x + bw},${y(p.y)} ${x + bw},${y(p.y) + r} V${y(0)} Z` : "";
      return `<g class="bar" data-tip="${esc(label(p))}: ${esc(fmt(p.y))}"><rect x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent"/>${path ? `<path d="${path}"/>` : ""}</g>
        ${i % every === 0 ? `<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle" class="ax">${esc(p.short || p.x)}</text>` : ""}`;
    }).join("")}
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="base"/>
  </svg><div class="adm-tip" hidden></div></figure>`;
}
function hbars(items, fmt) {
  const max = Math.max(1, ...items.map((i) => i.v));
  return `<ul class="adm-hbars">${items.map((i) => `<li data-tip="${esc(i.k)}: ${esc(fmt(i.v))}"><span class="k">${esc(i.k)}</span><span class="bar"><i style="width:${(i.v / max) * 100}%"></i></span><b>${esc(fmt(i.v))}</b></li>`).join("")}</ul>`;
}
function wireTips(scope) {
  scope.querySelectorAll(".adm-chart").forEach((fig) => {
    const tip = fig.querySelector(".adm-tip");
    fig.querySelectorAll(".bar").forEach((g) => {
      g.addEventListener("pointerenter", () => { tip.textContent = g.dataset.tip; tip.hidden = false; g.classList.add("on"); });
      g.addEventListener("pointermove", (e) => { const r = fig.getBoundingClientRect(); tip.style.left = `${e.clientX - r.left}px`; tip.style.top = `${e.clientY - r.top - 12}px`; });
      g.addEventListener("pointerleave", () => { tip.hidden = true; g.classList.remove("on"); });
    });
  });
}
const delta = (now, prev) => {
  if (!prev) return now ? `<span class="d up">new</span>` : "";
  const p = ((now - prev) / prev) * 100;
  return `<span class="d ${p >= 0 ? "up" : "down"}">${p >= 0 ? "▲" : "▼"} ${Math.abs(p).toFixed(0)}% vs previous</span>`;
};

// ---------------- views ----------------
let days = 30;
async function overview(main) {
  const d = await api("dashboard", undefined, `&days=${days}`);
  const k = d.kpis;
  const series = d.series.map((s) => ({ x: s.day, y: s.revenue, orders: s.orders, short: new Date(s.day + "T00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short" }) }));
  main.innerHTML = head("Overview", "Sales from the Web Orders tab · stock from Master Inventory",
    `<div class="adm-seg">${[7, 30, 90, 365].map((n) => `<button type="button" data-d="${n}" aria-pressed="${n === days}">${n === 365 ? "12 months" : n + " days"}</button>`).join("")}</div>`) + `
    <section class="adm-kpis">
      <div class="kpi"><span>Revenue</span><b>${aud(k.revenue)}</b>${delta(k.revenue, k.revenuePrev)}</div>
      <div class="kpi"><span>Orders</span><b>${k.orders}</b>${delta(k.orders, k.ordersPrev)}</div>
      <div class="kpi"><span>Average order</span><b>${aud(k.aov)}</b></div>
      <div class="kpi"><span>Pairs sold</span><b>${k.units}</b>${delta(k.units, k.unitsPrev)}</div>
      <div class="kpi"><span>Pairs in stock</span><b>${k.stockPairs}</b><small>${aud(k.stockRetail)} at today's prices</small></div>
      <div class="kpi"><span>Products live</span><b>${k.products}</b><small>${k.hidden ? `${k.hidden} hidden` : "none hidden"}</small></div>
    </section>
    <section class="adm-card"><h2>Revenue by day</h2>${k.orders ? barChart(series, { fmt: (v) => aud(v), label: (p) => `${p.short} · ${p.orders} order${p.orders === 1 ? "" : "s"}`, title: "Revenue by day" }) : `<p class="adm-empty">No web orders in this period yet.</p>`}</section>
    <div class="adm-2">
      <section class="adm-card"><h2>Best sellers</h2>${d.top.length ? hbars(d.top.map((t) => ({ k: t.label, v: t.units })), (v) => `${v} pair${v === 1 ? "" : "s"}`) : `<p class="adm-empty">Nothing sold in this period.</p>`}</section>
      <section class="adm-card"><h2>Sizes sold</h2>${hbars(SIZES.map((s) => ({ k: "EU " + s, v: d.sizeMix[s] || 0 })), (v) => `${v}`)}</section>
    </div>
    <div class="adm-2">
      <section class="adm-card"><h2>Out of stock <small>${d.out.length}</small></h2>${d.out.length ? `<ul class="adm-list">${d.out.map((o) => `<li>${esc(o.model)} <span>${esc(o.colourway)}</span></li>`).join("")}</ul>` : `<p class="adm-empty">Nothing is out of stock.</p>`}</section>
      <section class="adm-card"><h2>Gaps in sizes <small>${d.low.length}</small></h2>${d.low.length ? `<ul class="adm-list">${d.low.map((o) => `<li>${esc(o.model)} <span>${esc(o.colourway)}</span><em>${o.missing.length ? "no EU " + o.missing.join(", ") : o.left + " left"}</em></li>`).join("")}</ul>` : `<p class="adm-empty">Every size is in stock.</p>`}</section>
    </div>
    <section class="adm-card"><h2>Latest orders</h2>${ordersTable(d.recent)}</section>`;
  main.querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => { days = +b.dataset.d; go("overview"); }));
  wireTips(main);
}

function ordersTable(list) {
  if (!list.length) return `<p class="adm-empty">No orders yet. Paid orders appear here (and in the Web Orders tab) as soon as Stripe confirms them.</p>`;
  return `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Date</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Stock</th></tr></thead><tbody>
    ${list.map((o) => `<tr><td>${esc(o.date)}</td><td><b>${esc(o.name)}</b><br><small>${esc(o.email)}${o.phone ? " · " + esc(o.phone) : ""}</small><br><small>${esc(o.shipTo)}</small></td>
      <td>${esc(o.itemsText)}</td><td class="num">${aud(o.total, 2)}</td><td>${/fail|oversold/i.test(o.stock + o.notes) ? `<span class="tag bad">${esc(o.stock || "check")}</span>` : `<span class="tag">${esc(o.stock || "—")}</span>`}</td></tr>`).join("")}
  </tbody></table></div>`;
}
async function orders(main) {
  const { orders: list } = await api("orders");
  main.innerHTML = head("Orders", `${list.length} paid web orders`, `<input class="adm-search" type="search" placeholder="Search name, email, shoe…" aria-label="Search orders">`) + `<section class="adm-card" data-o="t">${ordersTable(list)}</section>`;
  main.querySelector(".adm-search").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    main.querySelector('[data-o="t"]').innerHTML = ordersTable(list.filter((o) => JSON.stringify(o).toLowerCase().includes(q)));
  });
}

async function inventory(main) {
  const d = await api("inventory"); inventoryRows = d.rows;
  const changes = new Map();
  main.innerHTML = head("Inventory", `Edits go straight into the <b>${esc(d.tab)}</b> tab. Use Bulk for styles you don't track by size.`,
    `<input class="adm-search" type="search" placeholder="Search model or colour…" aria-label="Search stock"><button class="adm-btn primary" type="button" data-a="review" disabled>Review changes</button>`) + `
    <section class="adm-card"><div class="adm-table-wrap"><table class="adm-table adm-stock"><thead><tr><th>Model</th><th>Colourway</th>${SIZES.map((s) => `<th class="num">EU ${s}</th>`).join("")}<th class="num">Bulk</th><th class="num">Total</th></tr></thead>
    <tbody>${d.rows.map((r) => `<tr data-row="${r.rowNumber}" data-q="${esc((r.model + " " + r.colourway).toLowerCase())}"><td><b>${esc(r.model)}</b></td><td>${esc(r.colourway)}</td>
      ${SIZES.map((s) => `<td class="num"><input type="number" min="0" max="9999" step="1" inputmode="numeric" value="${r.sizes[s]}" data-size="${s}" aria-label="${esc(r.model)} ${esc(r.colourway)} EU ${s}"></td>`).join("")}
      <td class="num"><input type="number" min="0" max="9999" step="1" inputmode="numeric" value="${r.bulk}" data-size="bulk" aria-label="${esc(r.model)} ${esc(r.colourway)} bulk"></td>
      <td class="num tot">${SIZES.reduce((a, s) => a + r.sizes[s], 0) || r.bulk}</td></tr>`).join("")}</tbody></table></div></section>
    <dialog class="adm-dialog" data-o="dlg"></dialog>`;
  const btn = main.querySelector('[data-a="review"]');
  main.querySelectorAll("tbody input").forEach((inp) => inp.addEventListener("input", () => {
    const tr = inp.closest("tr"), r = inventoryRows.find((x) => x.rowNumber === +tr.dataset.row);
    const size = inp.dataset.size, before = size === "bulk" ? r.bulk : r.sizes[size], v = Math.max(0, Math.floor(+inp.value || 0));
    const key = `${r.rowNumber}:${size}`;
    if (v === before) changes.delete(key); else changes.set(key, { rowNumber: r.rowNumber, size, value: v, before, label: `${r.model} / ${r.colourway} ${size === "bulk" ? "Bulk" : "EU " + size}` });
    inp.classList.toggle("changed", v !== before);
    const vals = [...tr.querySelectorAll("input")].map((i) => Math.max(0, Math.floor(+i.value || 0)));
    tr.querySelector(".tot").textContent = vals.slice(0, 5).reduce((a, b) => a + b, 0) || vals[5];
    btn.disabled = !changes.size; btn.textContent = changes.size ? `Review ${changes.size} change${changes.size === 1 ? "" : "s"}` : "Review changes";
  }));
  main.querySelector(".adm-search").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase(); main.querySelectorAll("tbody tr").forEach((tr) => { tr.hidden = !tr.dataset.q.includes(q); });
  });
  btn.addEventListener("click", () => {
    const dlg = main.querySelector('[data-o="dlg"]');
    dlg.innerHTML = `<h2>Save these stock changes?</h2><p>They'll be written to the Google Sheet now and the shop will use them within a minute.</p>
      <ul class="adm-list">${[...changes.values()].map((c) => `<li>${esc(c.label)} <em>${c.before} → <b>${c.value}</b></em></li>`).join("")}</ul>
      <div class="adm-row"><button class="adm-btn" type="button" data-x="cancel">Cancel</button><button class="adm-btn primary" type="button" data-x="ok">Save to sheet</button></div>`;
    dlg.showModal();
    dlg.querySelector('[data-x="cancel"]').onclick = () => dlg.close();
    dlg.querySelector('[data-x="ok"]').onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await api("inventory", { changes: [...changes.values()] }); dlg.close(); toast(`Saved ${r.changed} change${r.changed === 1 ? "" : "s"} to the sheet.`); go("inventory"); }
      catch (err) { e.target.disabled = false; dlg.querySelector("p").textContent = err.message; }
    };
  });
}

let productList = [];
async function products(main) {
  productList = (await api("products")).products;
  const render = (q = "") => {
    const list = productList.filter((p) => (p.name + " " + p.category).toLowerCase().includes(q));
    main.querySelector('[data-o="grid"]').innerHTML = list.map((p) => `
      <button type="button" class="adm-prod${p.hidden ? " hidden" : ""}" data-slug="${esc(p.slug)}">
        <span class="img"><img src="${esc(p.cutout || p.images?.[0] || "")}" alt="" loading="lazy"></span>
        <b>${esc(p.name)}</b><small>${esc(CATS[p.category] || p.category)} · ${p.colourways?.length || 1} colour${p.colourways?.length === 1 ? "" : "s"}</small>
        <span class="price">${p.sale ? `${aud(p.sale)} <s>${aud(p.price)}</s>` : aud(p.price)}</span>${p.hidden ? `<span class="tag">Hidden</span>` : ""}
      </button>`).join("");
    main.querySelectorAll("[data-slug]").forEach((b) => b.addEventListener("click", () => editProduct(main, productList.find((p) => p.slug === b.dataset.slug))));
  };
  main.innerHTML = head("Products", `${productList.filter((p) => !p.hidden).length} in the shop · edits are live within a minute`,
    `<input class="adm-search" type="search" placeholder="Search products…" aria-label="Search products"><button class="adm-btn primary" type="button" data-a="new">Add product</button>`) +
    `<section class="adm-prods" data-o="grid"></section>`;
  main.querySelector(".adm-search").addEventListener("input", (e) => render(e.target.value.toLowerCase()));
  main.querySelector('[data-a="new"]').addEventListener("click", () => editProduct(main, null));
  render();
}

async function editProduct(main, p) {
  if (!inventoryRows.length) inventoryRows = (await api("inventory")).rows;
  const isNew = !p;
  p = p ? JSON.parse(JSON.stringify(p)) : { name: "", category: "loafers", price: "", sale: null, description: "", images: [], colourways: [{ name: "", hex: "#1e1e20", base: "", sheet: null }] };
  const stockOpts = (ref) => `<option value="">— choose a Master Inventory row —</option>` + inventoryRows.map((r) => {
    const v = `${r.model}|||${r.colourway}`; const sel = ref && ref.model?.toLowerCase() === r.model.toLowerCase() && ref.colourway?.toLowerCase() === r.colourway.toLowerCase();
    return `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(r.model)} / ${esc(r.colourway)}</option>`;
  }).join("");
  const cwRow = (c, i) => `<tr data-i="${i}"><td><input data-f="name" value="${esc(c.name)}" placeholder="e.g. Black" aria-label="Colour name"></td>
    <td><input data-f="hex" type="color" value="${esc(c.hex || "#1e1e20")}" aria-label="Swatch colour"></td>
    <td><input data-f="base" value="${esc(c.base || "")}" placeholder="Black" aria-label="Filter colour"></td>
    <td><select data-f="sheet" aria-label="Stock row">${stockOpts(c.sheet)}</select></td>
    <td><button type="button" class="adm-x" data-del="${i}" aria-label="Remove colour">×</button></td></tr>`;
  main.innerHTML = head(isNew ? "Add product" : esc(p.name), isNew ? "Fill in the details, link each colour to its stock row, then save." : `/product?m=${esc(p.slug)}`,
    `<button class="adm-btn" type="button" data-a="back">Back to products</button>`) + `
    <form class="adm-form" novalidate>
      <section class="adm-card">
        <h2>Details</h2>
        <div class="adm-grid2">
          <label>Name<input name="name" value="${esc(p.name)}" required maxlength="120"></label>
          <label>Category<select name="category">${Object.entries(CATS).map(([k, l]) => `<option value="${k}"${p.category === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Price (AUD, incl. GST)<input name="price" type="number" min="1" step="0.01" value="${esc(p.price)}" required></label>
          <label>Sale price (AUD) <small>leave empty for no sale</small><input name="sale" type="number" min="1" step="0.01" value="${esc(p.sale ?? "")}"></label>
        </div>
        <label>Description<textarea name="description" rows="5" maxlength="4000">${esc(p.description)}</textarea></label>
        <label class="adm-check"><input type="checkbox" name="hidden"${p.hidden ? " checked" : ""}> Hide from the shop (keeps it here so you can bring it back)</label>
      </section>
      <section class="adm-card">
        <h2>Photos</h2>
        <p class="adm-help">One link per line, first one is the main photo. Use https:// links (for example from theyolobrand.com).${p.cutout ? " The cut-out photo the site already uses stays as the main image." : ""}</p>
        <textarea name="images" rows="4">${esc((p.images || []).join("\n"))}</textarea>
        <div class="adm-thumbs" data-o="thumbs"></div>
      </section>
      <section class="adm-card">
        <h2>Colours &amp; stock</h2>
        <p class="adm-help">Each colour sells the stock in one Master Inventory row. A row has to exist in the sheet before you can link it.</p>
        <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Colour name</th><th>Swatch</th><th>Filter colour</th><th>Stock row</th><th></th></tr></thead><tbody data-o="cw">${p.colourways.map(cwRow).join("")}</tbody></table></div>
        <button class="adm-btn" type="button" data-a="addcw">Add colour</button>
      </section>
      <p class="adm-err" role="alert" data-o="err"></p>
      <div class="adm-row sticky"><button class="adm-btn" type="button" data-a="back2">Cancel</button><button class="adm-btn primary" type="submit">${isNew ? "Add product" : "Save changes"}</button></div>
    </form>`;
  const form = main.querySelector("form"), cw = main.querySelector('[data-o="cw"]');
  const thumbs = () => { main.querySelector('[data-o="thumbs"]').innerHTML = form.images.value.split(/\n/).map((u) => u.trim()).filter((u) => /^https:\/\/|^\/assets\//.test(u)).map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join(""); };
  form.images.addEventListener("input", thumbs); thumbs();
  const wireDel = () => cw.querySelectorAll("[data-del]").forEach((b) => { b.onclick = () => { b.closest("tr").remove(); }; });
  wireDel();
  main.querySelector('[data-a="addcw"]').addEventListener("click", () => { cw.insertAdjacentHTML("beforeend", cwRow({ name: "", hex: "#1e1e20", base: "", sheet: null }, cw.children.length)); wireDel(); });
  main.querySelectorAll('[data-a^="back"]').forEach((b) => b.addEventListener("click", () => go("products")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = main.querySelector('[data-o="err"]'); err.textContent = "";
    const old = p.colourways || [];
    const colourways = [...cw.querySelectorAll("tr")].map((tr) => {
      const g = (f) => tr.querySelector(`[data-f="${f}"]`).value.trim();
      const [model, colourway] = g("sheet").split("|||");
      const prev = old.find((c) => c.name === g("name")) || {};
      return { ...prev, name: g("name"), hex: g("hex"), base: g("base") || g("name"), sheet: model ? { model, colourway } : null };
    }).filter((c) => c.name);
    if (colourways.some((c) => !c.sheet)) { err.textContent = "Choose a stock row for every colour."; return; }
    const product = { ...p, name: form.name.value, category: form.category.value, price: form.price.value, sale: form.sale.value || null,
      description: form.description.value, images: form.images.value.split(/\n/).map((u) => u.trim()).filter(Boolean), colourways };
    if (!colourways.length && p.sheetRow) product.colourways = [];
    const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      const r = await api("product", { product, hidden: form.hidden.checked, isNew });
      toast(isNew ? `${r.product.name} added.` : `${r.product.name} saved. Live in the shop within a minute.`);
      go("products");
    } catch (x) { err.textContent = x.message; btn.disabled = false; }
  });
}

async function customers(main) {
  const [{ customers: list }, { orders: ords }] = await Promise.all([api("customers"), api("orders")]);
  const count = (e) => ords.filter((o) => o.email.toLowerCase() === e).length;
  const spent = (e) => ords.filter((o) => o.email.toLowerCase() === e).reduce((s, o) => s + o.total, 0);
  main.innerHTML = head("Customers", `${list.length} accounts · guests who never made an account only appear in Orders`) + `
    <section class="adm-card">${list.length ? `<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Signs in with</th><th>Joined</th><th class="num">Orders</th><th class="num">Spent</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><b>${esc(c.name || "—")}</b></td><td>${esc(c.email)}</td><td>${esc(c.phone || "—")}</td><td>${esc(c.signIn)}</td><td>${esc(String(c.joined).split(",")[0])}</td><td class="num">${count(c.email)}</td><td class="num">${aud(spent(c.email), 2)}</td><td><button class="adm-btn" type="button" data-reset="${esc(c.email)}">Reset password</button></td></tr>`).join("")}
    </tbody></table></div>` : `<p class="adm-empty">No customer accounts yet.</p>`}</section>
    <dialog class="adm-dialog" data-o="dlg"></dialog>`;
  main.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => {
    const dlg = main.querySelector('[data-o="dlg"]'), email = b.dataset.reset;
    dlg.innerHTML = `<h2>Reset this password?</h2><p>${esc(email)} gets a temporary password. Pass it on privately (not in a group chat) and ask them to change it under Your details.</p>
      <div class="adm-row"><button class="adm-btn" type="button" data-x="cancel">Cancel</button><button class="adm-btn primary" type="button" data-x="ok">Reset</button></div>`;
    dlg.showModal();
    dlg.querySelector('[data-x="cancel"]').onclick = () => dlg.close();
    dlg.querySelector('[data-x="ok"]').onclick = async (e) => {
      e.target.disabled = true;
      try { const r = await api("customer-reset", { email }); dlg.innerHTML = `<h2>Temporary password</h2><p>For ${esc(email)}. It's shown once:</p><p class="adm-temp">${esc(r.temp)}</p><div class="adm-row"><button class="adm-btn primary" type="button" data-x="close">Done</button></div>`; dlg.querySelector('[data-x="close"]').onclick = () => dlg.close(); }
      catch (x) { dlg.querySelector("p").textContent = x.message; e.target.disabled = false; }
    };
  }));
}

async function log(main) {
  const { log: list } = await api("log");
  main.innerHTML = head("Activity", "Every admin sign-in, stock change and product edit, newest first (also in the Admin Log tab)") + `
    <section class="adm-card">${list.length ? `<ul class="adm-log">${list.map((l) => `<li><time>${esc(l.time)}</time><b>${esc(l.action)}</b><span>${esc(l.admin)}</span><p>${esc(l.details)}</p></li>`).join("")}</ul>` : `<p class="adm-empty">Nothing yet.</p>`}</section>`;
}

// ---------------- boot ----------------
(async () => {
  try { cfg = await api("config"); } catch { cfg = {}; }
  try { me = (await api("me")).admin; } catch { me = null; }
  me ? shell() : signInScreen();
})();
