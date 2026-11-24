/* Fit panel — used on every product page and on /try-on.
   Height, weight and foot length -> recommended EU size, the body maths, a 3D mannequin wearing the
   shoe (assets/js/fit3d.js), and a to-scale foot close-up. On /try-on it adds a shoe picker and a
   camera mode. Everything runs in the browser; nothing is uploaded. */
import { createFit3D, footAndShoe, solveBody, styleFor, sampleUpperColour, footprint } from "./fit3d.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ALT = { 39: [6, 7], 40: [6.5, 7.5], 41: [7.5, 8.5], 42: [8, 9], 43: [9, 10] };   // ≈ AU/UK, US (men's)
const images = new Map();
const loadImg = (src) => {
  if (!images.has(src)) images.set(src, new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }));
  return images.get(src);
};

/**
 * @param {HTMLElement} root
 * @param {{products: object[], slug: string, picker?: boolean, camera?: boolean,
 *          getColour?: () => ({hex: string, name: string} | null), onPickSize?: (eu:number)=>void}} opts
 */
export function mountFitPanel(root, opts) {
  const products = opts.products.filter((p) => p.cutout || p.images.length);
  let product = products.find((p) => p.slug === opts.slug) || products[0];
  const $ = (s) => root.querySelector(s);

  root.classList.add("fit");
  root.innerHTML = `
    <form class="fit-form" novalidate>
      ${opts.picker ? `<label class="field"><span>Shoe</span><select class="pref-select" data-k="shoe">${products.map((p) => `<option value="${p.slug}">${esc(p.name)}</option>`).join("")}</select></label>` : ""}
      <label class="field"><span>Height <b data-o="h"></b></span><input type="range" data-k="h" min="140" max="210" step="1" value="175"></label>
      <label class="field"><span>Weight <b data-o="w"></b></span><input type="range" data-k="w" min="40" max="150" step="1" value="72"></label>
      <div class="field">
        <span>Foot length</span>
        <div class="foot-row"><input type="number" data-k="f" inputmode="decimal" min="20" max="32" step="0.1" placeholder="e.g. 26.5" aria-label="Foot length in centimetres"><span class="unit">cm</span></div>
        <details class="howto"><summary>How to measure</summary>
          <svg class="howto-art" viewBox="0 0 520 250" role="img" aria-label="A bare foot standing on paper with the heel against a wall. A mark at the tip of the longest toe, and a ruler from the wall to the mark shows the foot length.">
            <defs><marker id="ht-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#0a0a0a"/></marker></defs>
            <rect x="0" y="0" width="520" height="250" rx="18" fill="#f4f4f2"/>
            <rect x="40" y="20" width="18" height="170" fill="#0a0a0a"/>
            <text x="49" y="14" font-size="11" text-anchor="middle" fill="#6a6a6a">Wall</text>
            <line x1="20" x2="500" y1="190" y2="190" stroke="#0a0a0a" stroke-opacity=".3"/>
            <path d="M58 186 L430 186 L436 196 L58 196 Z" fill="#ffffff" stroke="#0a0a0a" stroke-opacity=".35"/>
            <text x="300" y="214" font-size="11" text-anchor="middle" fill="#6a6a6a">Sheet of paper on a hard floor</text>
            <path d="M118 6 C 116 60, 108 96, 92 122 C 72 140, 60 158, 62 176 C 63 184, 70 186, 80 186 L 384 186 C 397 186, 399 169, 386 163 C 350 151, 262 137, 188 118 C 170 112, 160 96, 158 60 L 157 6 Z" fill="#ffffff" stroke="#0a0a0a" stroke-width="2" stroke-linejoin="round"/>
            <path d="M152 112 q8 6 4 16" fill="none" stroke="#0a0a0a" stroke-opacity=".35" stroke-width="1.4"/>
            <path d="M330 152 q6 -8 14 -4 M352 156 q6 -8 13 -3 M370 160 q5 -6 11 -2" fill="none" stroke="#0a0a0a" stroke-opacity=".45" stroke-width="1.4"/>
            <line x1="396" x2="396" y1="150" y2="192" stroke="#d4232b" stroke-width="2.4"/>
            <path d="M404 120 L 430 86 L 440 94 L 412 126 Z" fill="#0a0a0a"/><path d="M404 120 L 400 132 L 412 126 Z" fill="#d9b48f"/>
            <text x="396" y="104" font-size="11" text-anchor="end" fill="#6a6a6a">Mark the tip of</text><text x="396" y="118" font-size="11" text-anchor="end" fill="#6a6a6a">your longest toe</text>
            <line x1="58" x2="396" y1="232" y2="232" stroke="#0a0a0a" stroke-width="1.6" marker-start="url(#ht-arrow)" marker-end="url(#ht-arrow)"/>
            <line x1="58" x2="58" y1="222" y2="242" stroke="#0a0a0a"/><line x1="396" x2="396" y1="222" y2="242" stroke="#0a0a0a"/>
            <rect x="170" y="222" width="114" height="20" rx="10" fill="#0a0a0a"/>
            <text x="227" y="236" font-size="11" font-weight="700" text-anchor="middle" fill="#ffffff">Foot length (cm)</text>
          </svg>
          <ol class="howto-steps">
            <li>Put a sheet of paper on a hard floor against a wall.</li>
            <li>Stand on it with your heel touching the wall, weight on that foot.</li>
            <li>Mark the tip of your longest toe, then measure from the wall to the mark.</li>
          </ol>
          <p>Do both feet and use the longer one. Leave it blank and we'll estimate from your height.</p>
        </details>
      </div>
      <div class="result" aria-live="polite">
        <p class="eyebrow">Your size</p>
        <div class="result-size"><span data-o="eu">EU 42</span><small data-o="alt"></small></div>
        <p class="result-note" data-o="note"></p>
      </div>
      <div class="tryon-actions">
        <button class="btn btn-primary" type="button" data-a="pick">Select EU 42</button>
        ${opts.camera ? `<button class="btn" type="button" data-a="camera">Try with your camera</button>` : ""}
      </div>
      <details class="maths"><summary>How we worked this out</summary><div data-o="maths"></div></details>
    </form>
    <div class="fit-view">
      <div class="view-tabs" role="tablist" aria-label="View">
        <button type="button" role="tab" aria-selected="true" data-view="model">3D model</button>
        <button type="button" role="tab" aria-selected="false" data-view="foot">Foot close-up</button>
      </div>
      <div class="view-stage">
        <div class="fit3d" data-o="stage3d"><p class="fit3d-msg" data-o="msg">Loading 3D model…</p>
          <div class="fit3d-tools"><button type="button" data-p="full">Full body</button><button type="button" data-p="tee">Tee</button><button type="button" data-p="feet">Feet</button><button type="button" data-p="reset" aria-label="Reset view">↺</button></div>
          <p class="fit3d-hint">Drag to rotate · scroll or pinch to zoom · tap Tee to see the print</p>
          <div class="fit3d-measure" data-o="measure" hidden></div>
        </div>
        <svg data-o="foot" viewBox="0 0 600 700" role="img" aria-label="Top view of your foot inside the shoe, drawn to scale" hidden></svg>
      </div>
    </div>`;

  const inp = { h: $('[data-k="h"]'), w: $('[data-k="w"]'), f: $('[data-k="f"]'), shoe: $('[data-k="shoe"]') };
  if (inp.shoe) inp.shoe.value = product.slug;
  try { const sv = JSON.parse(localStorage.getItem("yolo-fit") || "null"); if (sv) { inp.h.value = sv.h; inp.w.value = sv.w; if (sv.f) inp.f.value = sv.f; } } catch {}

  let teeBack = false, view = "model", viewer = null, lastEU = null, fit = null, raf = 0;
  const stage = $('[data-o="stage3d"]');

  // ---------- 3D viewer ----------
  createFit3D(stage).then((v) => {
    viewer = v;
    if (!v) { $('[data-o="msg"]').textContent = "3D needs WebGL, which this browser has turned off. Showing the foot close-up instead."; setView("foot"); return; }
    $('[data-o="msg"]').remove();
    stage.classList.add("ready");
    render3D();
  });
  root.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => {
    if (!viewer) return;
    if (b.dataset.p === "reset") viewer.resetView();
    else if (b.dataset.p === "tee") { teeBack = !teeBack; viewer.preset("top"); viewer.setAzimuth(teeBack ? Math.PI : 0); b.textContent = teeBack ? "Tee (back)" : "Tee (front)"; }
    else if (b.dataset.p === "feet") setView("foot");
    else if (b.dataset.p === "full") setView("model");
    else viewer.preset(b.dataset.p);
  }));

  async function render3D() {
    if (!viewer || !fit) return;
    const chosen = opts.getColour?.();
    let colour, gloss;
    if (chosen && chosen.hex) { colour = parseInt(chosen.hex.replace("#", ""), 16); gloss = /patent|shiny/i.test(chosen.name || ""); }
    else { const img = await loadImg(product.cutout || product.images[0]); colour = img ? sampleUpperColour(img) : 0x222222; gloss = /shiny|patent/i.test(product.description || "") || product.slug === "odin"; }
    viewer.update({ heightCm: +inp.h.value, weightKg: +inp.w.value, fit, style: styleFor(product), colour, gloss, slug: product.slug, colourName: chosen?.name || product.colourways?.[0]?.name });
  }

  // ---------- numbers ----------
  function update() {
    const h = +inp.h.value, w = +inp.w.value, f = parseFloat(inp.f.value);
    fit = footAndShoe(h, w, f);
    const body = solveBody(h, w);
    $('[data-o="h"]').textContent = `${h} cm`;
    $('[data-o="w"]').textContent = `${w} kg`;
    $('[data-o="eu"]').textContent = `EU ${fit.eu}`;
    $('[data-o="alt"]').textContent = `≈ AU/UK ${ALT[fit.eu][0]} · US ${ALT[fit.eu][1]}`;
    const raw = Math.round(fit.euExact);
    let note = fit.estimated ? `Estimated from your height (foot ≈ ${fit.footCm} cm). Measure your foot for a better match.` : `Based on a ${fit.footCm} cm foot.`;
    if (raw < 39) note = `Your foot (${fit.footCm} cm) is shorter than our range, which starts at EU 39. EU 39 may feel loose.`;
    else if (raw > 43) note = `Your foot (${fit.footCm} cm) is longer than our range, which ends at EU 43. EU 43 may feel tight.`;
    else if (Math.abs(fit.euExact - raw) > 0.35) note += ` You're between sizes. EU ${Math.min(43, Math.ceil(fit.euExact))} gives more room.`;
    if (body.bmi >= 30 && raw >= 39 && raw < 43) note += " If your feet are wide, consider half a size to one size up.";
    $('[data-o="note"]').textContent = note;
    $('[data-a="pick"]').textContent = opts.onPickSize ? `Select EU ${fit.eu}` : `Choose colour & add EU ${fit.eu}`;
    if (lastEU !== fit.eu) { const r = $(".result"); r.classList.remove("pop"); void r.offsetWidth; r.classList.add("pop"); lastEU = fit.eu; }
    $('[data-o="maths"]').innerHTML = `
      <dl>
        <dt>Body mass index</dt><dd>${body.bmi.toFixed(1)} = ${w} kg ÷ (${(h / 100).toFixed(2)} m)²</dd>
        <dt>Body volume</dt><dd>${body.targetL.toFixed(1)} L = ${w} kg ÷ 1.01 kg/L (average body density)</dd>
        <dt>Model build factor</dt><dd>${body.s.toFixed(3)}. Girths are scaled until the 3D model's volume is ${body.volumeL.toFixed(1)} L</dd>
        <dt>Proportions</dt><dd>Hip joint ${(0.505 * h).toFixed(0)} cm · knee ${(0.285 * h).toFixed(0)} cm · shoulder ${(0.78 * h).toFixed(0)} cm (ratios of height). The mannequin is sculpted from smooth muscle-group shapes, and every girth scales with the build factor</dd>
        <dt>Foot</dt><dd>${fit.footCm} cm long × ${fit.breadthCm.toFixed(1)} cm wide${fit.estimated ? " (estimated as 15.2% of height)" : ""}</dd>
        <dt>Size</dt><dd>EU = 1.5 × (${fit.footCm} + 1.5) = ${fit.euExact.toFixed(2)} → EU ${fit.eu}</dd>
        <dt>Shoe</dt><dd>${fit.insideCm.toFixed(1)} cm inside, ${fit.outerCm.toFixed(1)} cm outside · ${fit.roomCm.toFixed(1)} cm toe room</dd>
      </dl>`;
    const verdictShort = fit.roomCm < 0.5 ? "Snug" : fit.roomCm > 2 ? "Roomy" : "Good fit";
    $('[data-o="measure"]').innerHTML = `<strong>${verdictShort}</strong><span>Your foot ${fit.footCm.toFixed(1)} cm · EU ${fit.eu} inside ${fit.insideCm.toFixed(1)} cm · ${fit.roomCm.toFixed(1)} cm toe room</span><em>See-through shoe: the grey foot inside is yours, to scale</em>`;
    try { localStorage.setItem("yolo-fit", JSON.stringify({ h, w, f: inp.f.value })); } catch {}
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { render3D(); drawFoot(); });
  }

  // ---------- foot close-up: top view, everything to the same scale ----------
  async function drawFoot() {
    if (view !== "foot" || !fit) return;
    const svg = $('[data-o="foot"]');
    const st = styleFor(product);
    const point = { loafer: 1.7, derby: 1.55, sneaker: 2.2, slipon: 2.2, chelsea: 1.8, zip: 1.8, work: 2.6 }[st] || 1.8;
    const outW = fit.breadthCm + 1.6, inW = fit.breadthCm + 0.5;          // shoe outside / insole width, cm
    const PX = 500 / fit.outerCm, x0 = 50, CY = 330;
    const X = (cm) => x0 + cm * PX;
    // outline of a footprint-shaped loop: length L (cm) starting at x (cm), width W (cm), toe bias toward the big toe
    const outline = (start, L, W, pt, arch) => {
      const top = [], bot = [];
      for (let i = 0; i <= 80; i++) {
        const u = i / 80, hw = footprint(u, pt) * W / 2;
        const bias = -0.07 * W * Math.max(0, (u - 0.65) / 0.35) ** 2;                    // big toe on the inner side
        const inner = hw * (1 - arch * Math.exp(-(((u - 0.42) / 0.13) ** 2)));             // arch on the inner side
        top.push([X(start + u * L), CY + (bias - inner) * PX]);
        bot.push([X(start + u * L), CY + (bias + hw) * PX]);
      }
      const pts = top.concat(bot.reverse());
      return "M" + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L") + " Z";
    };
    const heelIn = (fit.outerCm - fit.insideCm) * 0.35;                    // heel counter thickness
    const shoeOut = outline(0, fit.outerCm, outW, point, 0.08);
    const insole = outline(heelIn, fit.insideCm, inW, point, 0.12);
    const foot = outline(heelIn + 0.1, fit.footCm, fit.breadthCm, 1.35, 0.3);
    const footTip = X(heelIn + 0.1 + fit.footCm), inTip = X(heelIn + fit.insideCm);
    const room = fit.roomCm;
    const dim = (y, a, b, label, col = "#0a0a0a") => `<g stroke="${col}" stroke-width="1.2"><line x1="${a}" x2="${b}" y1="${y}" y2="${y}"/><line x1="${a}" x2="${a}" y1="${y - 6}" y2="${y + 6}"/><line x1="${b}" x2="${b}" y1="${y - 6}" y2="${y + 6}"/></g><text x="${(a + b) / 2}" y="${y - 9}" font-size="13" font-weight="700" text-anchor="middle" fill="${col}">${label}</text>`;
    const verdict = room < 0.5 ? "Snug: consider a size up" : room > 2 ? "Roomy: consider a size down" : "Good fit: about a thumb's width of room";
    const widthGap = inW - fit.breadthCm;
    const ballX = X(heelIn + 0.1 + fit.footCm * 0.7);
    const img = await loadImg(product.cutout || product.images[0]);
    svg.innerHTML = `
      <defs><pattern id="roomHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#0a0a0a" stroke-opacity=".35" stroke-width="2"/></pattern>
        <clipPath id="insoleClip"><path d="${insole}"/></clipPath></defs>
      ${img ? `<image href="${esc(img.src)}" x="40" y="40" width="130" height="80" preserveAspectRatio="xMidYMid meet"/>` : ""}
      <text x="184" y="72" font-size="15" font-weight="800" fill="#0a0a0a">${esc(product.name)} · EU ${fit.eu}</text>
      <text x="184" y="94" font-size="12" fill="#8a8a8a">Seen from above, drawn to scale</text>
      <path d="${shoeOut}" fill="#ffffff" stroke="#0a0a0a" stroke-width="2"/>
      <path d="${insole}" fill="#ececea" stroke="#0a0a0a" stroke-opacity=".25"/>
      ${room > 0 ? `<rect x="${footTip}" y="${CY - outW * PX}" width="${Math.max(0, inTip - footTip)}" height="${outW * 2 * PX}" fill="url(#roomHatch)" clip-path="url(#insoleClip)"/>` : ""}
      <path d="${foot}" fill="#0a0a0a" fill-opacity=".07" stroke="#0a0a0a" stroke-width="1.6" stroke-dasharray="6 5"/>
      <g stroke="#0a0a0a" stroke-opacity=".5" stroke-width="1"><line x1="${ballX}" x2="${ballX}" y1="${CY - inW / 2 * PX - 4}" y2="${CY + inW / 2 * PX + 4}" stroke-dasharray="2 3"/></g>
      <text x="${ballX + 8}" y="${CY - inW / 2 * PX - 8}" font-size="11" fill="#5a5a5a">Width at the ball: foot ${fit.breadthCm.toFixed(1)} cm · shoe ${inW.toFixed(1)} cm</text>
      ${dim(CY + outW / 2 * PX + 46, X(heelIn + 0.1), footTip, `Your foot ${fit.footCm.toFixed(1)} cm`)}
      ${dim(CY + outW / 2 * PX + 96, X(heelIn), inTip, `EU ${fit.eu} inside length ${fit.insideCm.toFixed(1)} cm`)}
      <text x="300" y="${CY + outW / 2 * PX + 150}" font-size="17" font-weight="800" text-anchor="middle" fill="#0a0a0a">${verdict}</text>
      <text x="300" y="${CY + outW / 2 * PX + 174}" font-size="12" text-anchor="middle" fill="#8a8a8a">${room.toFixed(1)} cm of toe room (hatched) · ${widthGap.toFixed(1)} cm spare width at the ball</text>
      <g font-size="11" fill="#5a5a5a"><line x1="40" x2="62" y1="${CY + outW / 2 * PX + 206}" y2="${CY + outW / 2 * PX + 206}" stroke="#0a0a0a" stroke-dasharray="6 5"/><text x="68" y="${CY + outW / 2 * PX + 210}">Your foot</text>
        <rect x="150" y="${CY + outW / 2 * PX + 200}" width="16" height="12" fill="#ececea" stroke="#0a0a0a" stroke-opacity=".25"/><text x="172" y="${CY + outW / 2 * PX + 210}">Inside of the shoe</text>
        <rect x="290" y="${CY + outW / 2 * PX + 200}" width="16" height="12" fill="#fff" stroke="#0a0a0a" stroke-width="1.5"/><text x="312" y="${CY + outW / 2 * PX + 210}">Outside of the shoe</text></g>`;
  }

  function setView(v) {
    view = v;
    root.querySelectorAll(".view-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.view === v)));
    if (viewer) {
      // the close-up is the 3D model itself: the camera flies to the feet and the shoes turn see-through
      stage.removeAttribute("hidden");
      $('[data-o="foot"]').setAttribute("hidden", "");
      viewer.preset(v === "foot" ? "feet" : "full");
      $('[data-o="measure"]').toggleAttribute("hidden", v !== "foot");
      return;
    }
    // no WebGL: a to-scale drawing instead
    stage.toggleAttribute("hidden", v !== "model");
    $('[data-o="foot"]').toggleAttribute("hidden", v !== "foot");
    if (v === "foot") drawFoot();
  }
  root.querySelectorAll(".view-tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  [inp.h, inp.w, inp.f].forEach((el) => el.addEventListener("input", update));
  inp.shoe?.addEventListener("change", () => {
    product = products.find((p) => p.slug === inp.shoe.value);
    history.replaceState(null, "", `?m=${encodeURIComponent(product.slug)}`);
    update();
  });
  $('[data-a="pick"]').addEventListener("click", () => {
    if (opts.onPickSize) opts.onPickSize(fit.eu);
    else location.href = `/product?m=${encodeURIComponent(product.slug)}&s=${fit.eu}`;
  });
  if (opts.camera) $('[data-a="camera"]').addEventListener("click", () => openCamera(product));
  update();

  return { refresh: () => render3D(), get product() { return product; } };
}

/* ---------- Camera: overlay the shoe on the live camera, drag / pinch to fit (try-on page) ---------- */
let camReady = false, openCamera = () => {};
function initCamera() {
  const cam = document.getElementById("cam");
  if (!cam || camReady) return; camReady = true;
  const $ = (s) => cam.querySelector(s);
  const video = $("#cam-video"), shoe = $("#cam-shoe"), msg = $("#cam-msg");
  let stream = null;
  const st = { x: 0, y: 0, s: 1, r: 0, flip: 1 };
  const apply = () => { shoe.style.transform = `translate(calc(-50% + ${st.x}px), calc(-50% + ${st.y}px)) rotate(${st.r}deg) scale(${st.flip * st.s}, ${st.s})`; };
  openCamera = async (p) => {
    shoe.src = p.cutoutSide || p.cutout || p.images[0];
    Object.assign(st, { x: 0, y: 0, s: 1, r: 0, flip: 1 }); apply();
    $("#cam-scale").value = 1; $("#cam-rot").value = 0;
    cam.hidden = false; $("#cam-shot").hidden = true; msg.hidden = true; document.body.style.overflow = "hidden";
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }); video.srcObject = stream; }
    catch { msg.hidden = false; msg.textContent = "We couldn't open your camera. Allow camera access for this site in your browser settings, then try again."; }
  };
  const close = () => { cam.hidden = true; document.body.style.overflow = ""; if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } };
  $("#cam-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !cam.hidden) close(); });
  $("#cam-scale").addEventListener("input", (e) => { st.s = +e.target.value; apply(); });
  $("#cam-rot").addEventListener("input", (e) => { st.r = +e.target.value; apply(); });
  $("#cam-flip").addEventListener("click", () => { st.flip *= -1; apply(); });
  const pts = new Map(); let base = null;
  shoe.addEventListener("pointerdown", (e) => { shoe.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); base = null; });
  shoe.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { st.x += e.clientX - prev.x; st.y += e.clientY - prev.y; }
    else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      if (!base) base = { d, ang, s: st.s, r: st.r };
      st.s = clamp(base.s * d / base.d, 0.2, 2.5); st.r = clamp(base.r + ang - base.ang, -60, 60);
      $("#cam-scale").value = st.s; $("#cam-rot").value = st.r;
    }
    apply();
  });
  const up = (e) => { pts.delete(e.pointerId); base = null; };
  shoe.addEventListener("pointerup", up); shoe.addEventListener("pointercancel", up);
  $("#cam-snap").addEventListener("click", () => {
    const W = cam.clientWidth, H = cam.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
    const c = document.createElement("canvas"); c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext("2d"); ctx.scale(dpr, dpr); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (video.videoWidth) { const k = Math.max(W / video.videoWidth, H / video.videoHeight); const vw = video.videoWidth * k, vh = video.videoHeight * k; ctx.drawImage(video, (W - vw) / 2, (H - vh) / 2, vw, vh); }
    const sw = shoe.offsetWidth, sh = shoe.offsetHeight;
    ctx.save(); ctx.translate(shoe.offsetLeft + st.x, shoe.offsetTop + st.y); ctx.rotate(st.r * Math.PI / 180); ctx.scale(st.flip * st.s, st.s);
    ctx.drawImage(shoe, -sw / 2, -sh / 2, sw, sh); ctx.restore();
    ctx.font = "600 14px Inter, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fillText("YOLO Australia", 16, H - 18);
    const url = c.toDataURL("image/jpeg", 0.9); $("#cam-shot-img").src = url; $("#cam-save").href = url; $("#cam-shot").hidden = false;
  });
  $("#cam-retake").addEventListener("click", () => { $("#cam-shot").hidden = true; });
}

/* ---------- /try-on page ---------- */
const pageRoot = document.getElementById("fit-root");
if (pageRoot) {
  initCamera();
  const slug = new URLSearchParams(location.search).get("m");
  const products = (window.YOLO_PRODUCTS || []).filter((p) => p.cutout);
  mountFitPanel(pageRoot, { products, slug: products.some((p) => p.slug === slug) ? slug : "atlas-chelseaboots", picker: true, camera: true });
}
