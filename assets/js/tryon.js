/* Try-on: size from height / weight / foot length, a figure scaled to the customer,
   a side-on foot close-up, and a camera mode that overlays the shoe on the customer's feet.
   Everything runs in the browser; nothing is uploaded. */
const PRODUCTS = window.YOLO_PRODUCTS || [];
const $ = (s, r = document) => r.querySelector(s);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SIZES = [39, 40, 41, 42, 43];
// Approximate men's conversions (AU uses UK sizing)
const ALT = { 39: [6, 7], 40: [6.5, 7.5], 41: [7.5, 8.5], 42: [8, 9], 43: [9, 10] };

const form = $("#tryon-form");
if (form) init();

function init() {
  const shoes = PRODUCTS.filter((p) => p.cutout);
  const params = new URLSearchParams(location.search);
  const sel = $("#t-shoe");
  sel.innerHTML = shoes.map((p) => `<option value="${p.slug}">${esc(p.name)}</option>`).join("");
  sel.value = shoes.some((p) => p.slug === params.get("m")) ? params.get("m") : (shoes.find((p) => p.cutoutSide) || shoes[0]).slug;

  const height = $("#t-height"), weight = $("#t-weight"), foot = $("#t-foot");
  // restore last inputs (this browser only)
  try { const saved = JSON.parse(localStorage.getItem("yolo-fit") || "null"); if (saved) { height.value = saved.h; weight.value = saved.w; if (saved.f) foot.value = saved.f; } } catch {}

  const images = new Map();
  const loadImg = (src) => {
    if (!images.has(src)) images.set(src, new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }));
    return images.get(src);
  };

  // tweened values so the figure morphs smoothly
  const shown = { h: +height.value, bmi: 24, len: 27 };
  let target = { ...shown }, raf = 0, view = "figure", lastEU = null;

  function compute() {
    const h = +height.value, w = +weight.value;
    const f = parseFloat(foot.value);
    const footLen = f >= 20 && f <= 32 ? f : Math.round(h * 0.152 * 10) / 10;   // estimate from height
    const euExact = 1.5 * (footLen + 1.5);                                       // Paris point: 2/3 cm
    const eu = Math.round(euExact);
    const bmi = w / Math.pow(h / 100, 2);
    return { h, w, footLen, estimated: !(f >= 20 && f <= 32), euExact, eu, bmi };
  }

  function update() {
    const r = compute();
    $("#t-height-val").textContent = `${r.h} cm`;
    $("#t-weight-val").textContent = `${r.w} kg`;
    const inRange = clamp(r.eu, 39, 43);
    $("#t-eu").textContent = `EU ${inRange}`;
    $("#t-alt").textContent = `≈ AU/UK ${ALT[inRange][0]} · US ${ALT[inRange][1]}`;
    let note = r.estimated ? `Estimated from your height (foot ≈ ${r.footLen} cm). Measure your foot for a better match.` : `Based on a ${r.footLen} cm foot.`;
    if (r.eu < 39) note = `Your foot (${r.footLen} cm) is smaller than our range, which starts at EU 39. EU 39 may feel loose.`;
    else if (r.eu > 43) note = `Your foot (${r.footLen} cm) is longer than our range, which ends at EU 43. EU 43 may feel tight.`;
    else if (Math.abs(r.euExact - r.eu) > 0.35) note += ` You're between sizes. Go up to EU ${Math.min(43, Math.ceil(r.euExact))} for room or thicker socks.`;
    if (r.bmi >= 30 && r.eu >= 39 && r.eu < 43) note += " If your feet are wide, consider half a size to one size up.";
    $("#t-note").textContent = note;
    if (lastEU !== inRange) { const res = $("#t-result"); res.classList.remove("pop"); void res.offsetWidth; res.classList.add("pop"); lastEU = inRange; }
    const slug = sel.value;
    $("#t-shop").href = `/product?m=${encodeURIComponent(slug)}&s=${inRange}`;
    $("#t-shop").textContent = `Choose colour & add EU ${inRange}`;
    try { localStorage.setItem("yolo-fit", JSON.stringify({ h: r.h, w: r.w, f: foot.value })); } catch {}
    target = { h: r.h, bmi: clamp(r.bmi, 15, 45), len: inRange / 1.5 + 1, foot: r.footLen, eu: inRange };
    tick();
  }

  function tick() {
    cancelAnimationFrame(raf);
    const step = () => {
      let moving = false;
      for (const k of ["h", "bmi", "len"]) {
        const d = target[k] - shown[k];
        if (Math.abs(d) > 0.01 && !reduceMotion) { shown[k] += d * 0.18; moving = true; } else shown[k] = target[k];
      }
      draw();
      if (moving) raf = requestAnimationFrame(step);
    };
    step();
  }

  async function draw() {
    const p = shoes.find((x) => x.slug === sel.value);
    if (view === "figure") drawFigure(p, await loadImg(p.cutout));   // pair shot: both shoes worn
    else drawFoot(p, await loadImg(p.cutoutSide || p.cutout));
  }

  /* ---------- "On you": a dressed mannequin, scaled to height and build, wearing the shoe ----------
     The shoe photo is analysed once to find where each shoe's opening is, so the legs go *into*
     the shoes and the trouser hems fall over the collars. */
  const shoeFit = new Map();
  function analyseShoe(img) {
    if (shoeFit.has(img.src)) return shoeFit.get(img.src);
    const W = 200, H = Math.max(1, Math.round(200 * img.height / img.width));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
    const a = g.getImageData(0, 0, W, H).data;
    const solid = (x, y) => a[(y * W + x) * 4 + 3] > 150;
    let minX = W, maxX = 0, maxY = 0;
    const top = new Array(W).fill(-1);
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (solid(x, y)) { if (top[x] < 0) top[x] = y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const mid = Math.round((minX + maxX) / 2);
    const collar = (x0, x1) => {               // the high part of each shoe = its opening / collar
      let tMin = H; for (let x = x0; x < x1; x++) if (top[x] >= 0) tMin = Math.min(tMin, top[x]);
      let sx = 0, n = 0; const lim = tMin + H * 0.09;
      for (let x = x0; x < x1; x++) if (top[x] >= 0 && top[x] <= lim) { sx += x; n++; }
      const cx = n ? sx / n : (x0 + x1) / 2;
      return { x: cx / W, y: (tMin + H * 0.035) / H, w: Math.max(0.06, (n / W) * 0.9) };
    };
    const fit = { left: collar(minX, mid), right: collar(mid, maxX + 1), floor: maxY / H, spanX: (maxX - minX) / W };
    shoeFit.set(img.src, fit);
    return fit;
  }

  function drawFigure(p, img) {
    const svg = $("#t-figure");
    const FLOOR = 655, PX = 560 / 210;                 // 210 cm fills the frame
    const Hh = shown.h * PX, top = FLOOR - Hh, u = Hh / 7.7;   // u = head height
    const wf = Math.pow(clamp(shown.bmi / 22, 0.75, 1.9), 0.62);  // build factor
    const cx = 330;
    const fit = img ? analyseShoe(img) : { left: { x: 0.38, y: 0.4, w: 0.12 }, right: { x: 0.62, y: 0.4, w: 0.12 }, floor: 0.95, spanX: 0.9 };

    // place the pair photo so its shoes are the recommended length and its openings straddle the body centre
    const imgW = shown.len * PX * 1.9, imgH = img ? imgW * img.height / img.width : imgW * 0.6;
    const imgX = cx - ((fit.left.x + fit.right.x) / 2) * imgW, imgY = FLOOR - fit.floor * imgH;
    const ankL = { x: imgX + fit.left.x * imgW, y: imgY + fit.left.y * imgH, w: fit.left.w * imgW };
    const ankR = { x: imgX + fit.right.x * imgW, y: imgY + fit.right.y * imgH, w: fit.right.w * imgW };

    // body landmarks
    const neckY = top + 1.05 * u, shY = top + 1.42 * u, chestY = top + 2.2 * u, waistY = top + 3.05 * u, hipY = top + 3.55 * u, crotchY = top + 3.95 * u;
    const shW = 0.98 * u * Math.pow(wf, 0.55), chestW = 0.8 * u * wf, waistW = 0.66 * u * wf, hipW = 0.8 * u * wf;
    const thigh = 0.36 * u * wf;
    // trouser legs: hip -> knee -> hem (hem sits over the shoe collar)
    const leg = (side, ank) => {
      const hx = cx + side * (hipW - thigh);
      const hemW = Math.max(ank.w * 0.85, 0.22 * u * Math.pow(wf, 0.5));
      const kneeY = (crotchY + ank.y) / 2 + 0.2 * u, kneeX = (hx + ank.x) / 2, kneeW = (thigh + hemW) / 2;
      const outer = side < 0 ? -1 : 1;
      return `M ${hx + outer * thigh} ${hipY - 0.1 * u}
        C ${hx + outer * thigh * 1.05} ${crotchY + 0.6 * u}, ${kneeX + outer * kneeW} ${kneeY - 0.6 * u}, ${kneeX + outer * kneeW} ${kneeY}
        C ${kneeX + outer * kneeW} ${kneeY + 0.8 * u}, ${ank.x + outer * hemW * 1.05} ${ank.y - 0.9 * u}, ${ank.x + outer * hemW} ${ank.y + 0.16 * u}
        L ${ank.x - outer * hemW} ${ank.y + 0.2 * u}
        C ${ank.x - outer * hemW * 1.02} ${ank.y - 0.9 * u}, ${kneeX - outer * kneeW * 0.85} ${kneeY + 0.6 * u}, ${kneeX - outer * kneeW * 0.85} ${kneeY}
        C ${kneeX - outer * kneeW * 0.85} ${kneeY - 0.5 * u}, ${cx + outer * 0.03 * u} ${crotchY + 0.3 * u}, ${cx} ${crotchY}
        L ${cx} ${hipY - 0.1 * u} Z`;
    };
    const arm = (side) => {
      const sx = cx + side * shW, hx = cx + side * (hipW + 0.22 * u), hy = top + 3.95 * u, w = 0.19 * u * Math.pow(wf, 0.75);
      return `M ${sx - side * 0.05 * u} ${shY - 0.05 * u} C ${sx + side * 0.25 * u} ${shY + 0.1 * u}, ${hx + side * w} ${chestY}, ${hx + side * w * 0.7} ${hy}
        Q ${hx} ${hy + 0.35 * u} ${hx - side * w * 0.7} ${hy}
        C ${hx - side * w * 0.9} ${chestY + 0.2 * u}, ${sx - side * 0.15 * u} ${shY + 0.5 * u}, ${sx - side * 0.3 * u} ${shY + 0.3 * u} Z`;
    };
    const tee = `M ${cx - 0.18 * u} ${neckY} Q ${cx} ${neckY + 0.18 * u} ${cx + 0.18 * u} ${neckY}
      C ${cx + shW * 0.6} ${neckY + 0.05 * u}, ${cx + shW} ${shY - 0.12 * u}, ${cx + shW + 0.12 * u} ${shY + 0.25 * u}
      L ${cx + shW + 0.28 * u} ${shY + 0.95 * u} L ${cx + chestW + 0.02 * u} ${shY + 1.0 * u}
      C ${cx + chestW} ${chestY + 0.4 * u}, ${cx + waistW} ${waistY - 0.2 * u}, ${cx + hipW * 0.98} ${hipY}
      L ${cx - hipW * 0.98} ${hipY}
      C ${cx - waistW} ${waistY - 0.2 * u}, ${cx - chestW} ${chestY + 0.4 * u}, ${cx - chestW - 0.02 * u} ${shY + 1.0 * u}
      L ${cx - shW - 0.28 * u} ${shY + 0.95 * u} L ${cx - shW - 0.12 * u} ${shY + 0.25 * u}
      C ${cx - shW} ${shY - 0.12 * u}, ${cx - shW * 0.6} ${neckY + 0.05 * u}, ${cx - 0.18 * u} ${neckY} Z`;

    let ruler = "";
    for (let cm = 140; cm <= 210; cm += 10) {
      const y = FLOOR - cm * PX;
      ruler += `<line x1="60" x2="${cm % 20 ? 70 : 78}" y1="${y}" y2="${y}" stroke="#0a0a0a" stroke-opacity=".3"/><text x="84" y="${y + 4}" font-size="11" fill="#8a8a8a">${cm}</text>`;
    }
    const shoeImg = img ? `<image href="${esc(img.src)}" x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}"/>` : "";
    svg.innerHTML = `
      <defs>
        <radialGradient id="fs" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".2"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
        <linearGradient id="skin" x1="0" x2="1"><stop offset="0" stop-color="#cfcfcf"/><stop offset=".5" stop-color="#e2e2e2"/><stop offset="1" stop-color="#cbcbcb"/></linearGradient>
        <linearGradient id="pants" x1="0" x2="1"><stop offset="0" stop-color="#0c0c0c"/><stop offset=".5" stop-color="#262626"/><stop offset="1" stop-color="#0c0c0c"/></linearGradient>
        <linearGradient id="teeG" x1="0" x2="1"><stop offset="0" stop-color="#efefef"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#ececec"/></linearGradient>
      </defs>
      <line x1="60" x2="60" y1="${FLOOR - 210 * PX}" y2="${FLOOR}" stroke="#0a0a0a" stroke-opacity=".15"/>${ruler}
      <line x1="40" x2="560" y1="${FLOOR}" y2="${FLOOR}" stroke="#0a0a0a" stroke-opacity=".12"/>
      <ellipse cx="${cx}" cy="${FLOOR + 2}" rx="${imgW * 0.55}" ry="12" fill="url(#fs)"/>
      <line x1="140" x2="${cx - 0.5 * u}" y1="${top}" y2="${top}" stroke="#0a0a0a" stroke-dasharray="3 5" stroke-opacity=".45"/>
      <text x="140" y="${top - 8}" font-size="13" font-weight="700" fill="#0a0a0a">${Math.round(shown.h)} cm</text>
      <g>
        <path d="${arm(-1)}" fill="url(#skin)"/><path d="${arm(1)}" fill="url(#skin)"/>
        <rect x="${cx - 0.15 * u}" y="${top + 0.85 * u}" width="${0.3 * u}" height="${0.35 * u}" fill="#d6d6d6"/>
        <ellipse cx="${cx}" cy="${top + 0.5 * u}" rx="${0.37 * u}" ry="${0.5 * u}" fill="url(#skin)"/>
        ${shoeImg}
        <path d="${leg(-1, ankL)}" fill="url(#pants)"/>
        <path d="${leg(1, ankR)}" fill="url(#pants)"/>
        <path d="${tee}" fill="url(#teeG)" stroke="#0a0a0a" stroke-opacity=".08"/>
        <path d="M ${cx - hipW * 0.98} ${hipY} L ${cx + hipW * 0.98} ${hipY} L ${cx + hipW * 0.98} ${hipY + 0.12 * u} L ${cx - hipW * 0.98} ${hipY + 0.12 * u} Z" fill="#111"/>
      </g>
      <text x="560" y="${FLOOR + 34}" font-size="12" fill="#8a8a8a" text-anchor="end">${esc(p.name)} · EU ${target.eu}</text>`;
  }

  /* ---------- "Foot close-up": your foot vs the shoe, side on, to scale ---------- */
  function drawFoot(p, img) {
    const svg = $("#t-foot-view");
    const PX = 17, FLOOR = 470, x0 = 70;                // 17 px per cm
    const footL = (target.foot || 26) * PX, shoeIn = (target.eu / 1.5) * PX, shoeOut = shown.len * PX;
    const heelX = x0 + 0.6 * PX;                        // foot heel sits ~0.6 cm inside the shoe heel
    // simple side-on foot silhouette, length = footL
    const fx = (t) => heelX + t * footL;
    const footPath = `M${fx(0)} ${FLOOR - 0.5 * PX} C ${fx(-0.02)} ${FLOOR - 3.2 * PX}, ${fx(0.06)} ${FLOOR - 6.8 * PX}, ${fx(0.2)} ${FLOOR - 7.2 * PX} L ${fx(0.26)} ${FLOOR - 9.5 * PX} L ${fx(0.4)} ${FLOOR - 9.5 * PX} C ${fx(0.45)} ${FLOOR - 6.5 * PX}, ${fx(0.7)} ${FLOOR - 4.4 * PX}, ${fx(0.88)} ${FLOOR - 3.2 * PX} C ${fx(0.97)} ${FLOOR - 2.8 * PX}, ${fx(1.0)} ${FLOOR - 1.6 * PX}, ${fx(1)} ${FLOOR - 0.6 * PX} C ${fx(0.99)} ${FLOOR}, ${fx(0.02)} ${FLOOR}, ${fx(0)} ${FLOOR - 0.5 * PX} Z`;
    let shoe = "", note = "";
    if (img && p.cutoutSide) {
      // side cut-out: sole spans 5.7%–97.3% of the image width
      const w = shoeOut / (0.973 - 0.057), h = w * (img.height / img.width);
      shoe = `<image href="${esc(p.cutoutSide)}" x="${x0 - 0.057 * w}" y="${FLOOR - h * (1 - 0.073)}" width="${w}" height="${h}" opacity=".92"/>`;
    } else if (img) {
      const w = shoeOut * 1.35, h = w * (img.height / img.width);
      shoe = `<image href="${esc(p.cutout)}" x="${x0 - 0.1 * shoeOut}" y="${FLOOR - h * 0.9}" width="${w}" height="${h}" opacity=".9"/>`;
      note = "Side view isn't available for this style, so the photo is a guide only.";
    }
    const room = ((target.eu / 1.5) - (target.foot || 26)).toFixed(1);
    const dim = (y, a, b, label) => `<g stroke="#0a0a0a" stroke-width="1.2"><line x1="${a}" x2="${b}" y1="${y}" y2="${y}"/><line x1="${a}" x2="${a}" y1="${y - 6}" y2="${y + 6}"/><line x1="${b}" x2="${b}" y1="${y - 6}" y2="${y + 6}"/></g><text x="${(a + b) / 2}" y="${y - 10}" font-size="13" font-weight="700" text-anchor="middle" fill="#0a0a0a">${label}</text>`;
    const fit = room < 0.5 ? "Snug: consider a size up" : room > 2 ? "Roomy: consider a size down" : "Good fit: about a thumb's width of room";
    svg.innerHTML = `
      <line x1="30" x2="570" y1="${FLOOR}" y2="${FLOOR}" stroke="#0a0a0a" stroke-opacity=".15"/>
      ${shoe}
      <path d="${footPath}" fill="#0a0a0a" fill-opacity=".06" stroke="#0a0a0a" stroke-width="1.5" stroke-dasharray="5 5"/>
      ${dim(FLOOR + 40, heelX, heelX + footL, `Your foot ${(target.foot || 26).toFixed(1)} cm`)}
      ${dim(FLOOR + 92, x0, x0 + shoeIn, `EU ${target.eu} inside length ≈ ${(target.eu / 1.5).toFixed(1)} cm`)}
      <text x="300" y="${FLOOR + 150}" font-size="16" font-weight="800" text-anchor="middle" fill="#0a0a0a">${fit}</text>
      <text x="300" y="${FLOOR + 172}" font-size="12" text-anchor="middle" fill="#8a8a8a">${room} cm of toe room${note ? " · " + esc(note) : ""}</text>
      <text x="300" y="60" font-size="12" text-anchor="middle" fill="#8a8a8a">Dashed outline is your foot, drawn to scale</text>`;
  }

  // tabs
  document.querySelectorAll(".view-tabs button").forEach((b) => b.addEventListener("click", () => {
    view = b.dataset.view;
    document.querySelectorAll(".view-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $("#t-figure").toggleAttribute("hidden", view !== "figure");   // SVG elements have no .hidden property
    $("#t-foot-view").toggleAttribute("hidden", view !== "foot");
    draw();
  }));

  [height, weight, foot].forEach((el) => el.addEventListener("input", update));
  sel.addEventListener("change", () => { history.replaceState(null, "", `?m=${encodeURIComponent(sel.value)}`); update(); draw(); });
  update();

  initCamera(() => shoes.find((x) => x.slug === sel.value));
}

/* ---------- Camera: overlay the shoe on the live camera, drag / pinch to fit ---------- */
function initCamera(currentShoe) {
  const cam = $("#cam"), video = $("#cam-video"), shoe = $("#cam-shoe"), msg = $("#cam-msg");
  let stream = null;
  const st = { x: 0, y: 0, s: 1, r: 0, flip: 1 };
  const apply = () => { shoe.style.transform = `translate(calc(-50% + ${st.x}px), calc(-50% + ${st.y}px)) rotate(${st.r}deg) scale(${st.flip * st.s}, ${st.s})`; };

  async function open() {
    const p = currentShoe();
    shoe.src = p.cutoutSide || p.cutout;
    Object.assign(st, { x: 0, y: 0, s: 1, r: 0, flip: 1 }); apply();
    $("#cam-scale").value = 1; $("#cam-rot").value = 0;
    cam.hidden = false; $("#cam-shot").hidden = true; msg.hidden = true;
    document.body.style.overflow = "hidden";
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      video.srcObject = stream;
    } catch (e) {
      msg.hidden = false;
      msg.textContent = "We couldn't open your camera. Allow camera access for this site in your browser settings, then try again.";
    }
  }
  function close() {
    cam.hidden = true; document.body.style.overflow = "";
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }
  $("#t-camera").addEventListener("click", open);
  $("#cam-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !cam.hidden) close(); });
  $("#cam-scale").addEventListener("input", (e) => { st.s = +e.target.value; apply(); });
  $("#cam-rot").addEventListener("input", (e) => { st.r = +e.target.value; apply(); });
  $("#cam-flip").addEventListener("click", () => { st.flip *= -1; apply(); });

  // drag with one finger, pinch/rotate with two
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

  // snapshot: video (cover-fitted) + shoe, at screen size
  $("#cam-snap").addEventListener("click", () => {
    const W = cam.clientWidth, H = cam.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
    const c = document.createElement("canvas"); c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext("2d"); ctx.scale(dpr, dpr);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (video.videoWidth) {
      const k = Math.max(W / video.videoWidth, H / video.videoHeight);
      const vw = video.videoWidth * k, vh = video.videoHeight * k;
      ctx.drawImage(video, (W - vw) / 2, (H - vh) / 2, vw, vh);
    }
    const r = cam.getBoundingClientRect(), sw = shoe.offsetWidth, sh = shoe.offsetHeight;
    const cx = shoe.offsetLeft + st.x, cy = shoe.offsetTop + st.y;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(st.r * Math.PI / 180); ctx.scale(st.flip * st.s, st.s);
    ctx.drawImage(shoe, -sw / 2, -sh / 2, sw, sh); ctx.restore();
    ctx.font = "600 14px Inter, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fillText("YOLO Australia", 16, H - 18);
    const url = c.toDataURL("image/jpeg", 0.9);
    $("#cam-shot-img").src = url; $("#cam-save").href = url; $("#cam-shot").hidden = false;
    void r;
  });
  $("#cam-retake").addEventListener("click", () => { $("#cam-shot").hidden = true; });
}
