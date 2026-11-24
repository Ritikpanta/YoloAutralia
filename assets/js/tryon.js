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
    if (view === "figure") drawFigure(p, await loadImg(p.cutout));
    else drawFoot(p, await loadImg(p.cutoutSide || p.cutout));
  }

  /* ---------- "On you": a minimal figure scaled to height and build ---------- */
  function drawFigure(p, img) {
    const svg = $("#t-figure");
    const FLOOR = 650, PX = 560 / 210;                 // 210 cm fills the frame
    const H = shown.h * PX, top = FLOOR - H, u = H / 7.6;
    const wf = Math.pow(clamp(shown.bmi / 22, 0.7, 1.9), 0.65);   // build factor
    const cx = 340;
    const shoeLenPx = shown.len * PX;                  // shoe length at this scale
    const ankleY = FLOOR - 0.32 * u;
    const hipY = top + 3.85 * u, shY = top + 1.35 * u, waistY = top + 2.95 * u;
    const shW = 1.0 * u * Math.pow(wf, 0.6), waistW = 0.62 * u * wf, hipW = 0.78 * u * wf;
    const thigh = 0.27 * u * wf, ankle = 0.12 * u * Math.pow(wf, 0.4), legGap = 0.07 * u + 0.05 * u * wf;
    const lx = cx - legGap - thigh, rx = cx + legGap + thigh;    // leg centres at hip
    const footX = (s) => cx + s * (0.3 * u + 0.06 * u * wf);   // ankle centres
    const leg = (s) => {
      const hx = s < 0 ? lx : rx, fx = footX(s);
      return `M${hx - thigh} ${hipY} C ${hx - thigh} ${hipY + 1.2 * u}, ${fx - ankle * 1.6} ${ankleY - 1.6 * u}, ${fx - ankle} ${ankleY} L ${fx + ankle} ${ankleY} C ${fx + ankle * 1.8} ${ankleY - 1.6 * u}, ${hx + thigh} ${hipY + 1.2 * u}, ${hx + thigh} ${hipY} Z`;
    };
    const arm = (s) => {
      const x0 = cx + s * shW, x1 = cx + s * (hipW + 0.32 * u), y1 = top + 4.05 * u, w = 0.17 * u * Math.pow(wf, 0.8);
      return `M${x0 - w} ${shY + 0.1 * u} Q ${x0 + s * 0.15 * u} ${shY + 1.6 * u} ${x1 - w * 0.6} ${y1} L ${x1 + w * 0.6} ${y1} Q ${x0 + s * 0.35 * u} ${shY + 1.5 * u} ${x0 + w} ${shY + 0.1 * u} Z`;
    };
    const torso = `M${cx - shW} ${shY} Q ${cx - shW - 0.05 * u} ${shY + 0.9 * u} ${cx - waistW} ${waistY} Q ${cx - hipW - 0.05 * u} ${hipY - 0.3 * u} ${cx - hipW} ${hipY + 0.25 * u} L ${cx + hipW} ${hipY + 0.25 * u} Q ${cx + hipW + 0.05 * u} ${hipY - 0.3 * u} ${cx + waistW} ${waistY} Q ${cx + shW + 0.05 * u} ${shY + 0.9 * u} ${cx + shW} ${shY} Q ${cx} ${shY - 0.25 * u} ${cx - shW} ${shY} Z`;

    // ruler
    let ruler = "";
    for (let cm = 140; cm <= 210; cm += 10) {
      const y = FLOOR - cm * PX;
      ruler += `<line x1="60" x2="${cm % 20 ? 72 : 80}" y1="${y}" y2="${y}" stroke="#0a0a0a" stroke-opacity=".35"/><text x="86" y="${y + 4}" font-size="11" fill="#8a8a8a">${cm}</text>`;
    }
    // pair photo at the feet, scaled to the recommended shoe length (pair shot ≈ 1.9 shoe lengths wide)
    let shoes3 = "";
    if (img) {
      const w = shoeLenPx * 1.9, h = w * (img.height / img.width);
      shoes3 = `<image href="${esc(p.cutout)}" x="${cx - w / 2}" y="${FLOOR - h * 0.86}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
    }
    svg.innerHTML = `
      <defs><radialGradient id="fs" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".18"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>
      <line x1="60" x2="60" y1="${FLOOR - 210 * PX}" y2="${FLOOR}" stroke="#0a0a0a" stroke-opacity=".2"/>${ruler}
      <line x1="40" x2="560" y1="${FLOOR}" y2="${FLOOR}" stroke="#0a0a0a" stroke-opacity=".15"/>
      <ellipse cx="${cx}" cy="${FLOOR}" rx="${hipW * 1.9}" ry="14" fill="url(#fs)"/>
      <line x1="150" x2="${cx - 0.45 * u - 10}" y1="${top}" y2="${top}" stroke="#0a0a0a" stroke-dasharray="3 5" stroke-opacity=".5"/>
      <text x="150" y="${top - 8}" font-size="13" font-weight="700" fill="#0a0a0a">${Math.round(shown.h)} cm</text>
      <g fill="#dedede">
        <path d="${arm(-1)}"/><path d="${arm(1)}"/>
        <path d="${leg(-1)}" fill="#d2d2d2"/><path d="${leg(1)}"/>
        <path d="${torso}"/>
        <rect x="${cx - 0.17 * u}" y="${top + 0.9 * u}" width="${0.34 * u}" height="${0.55 * u}" rx="${0.1 * u}"/>
        <ellipse cx="${cx}" cy="${top + 0.5 * u}" rx="${0.36 * u}" ry="${0.5 * u}"/>
      </g>
      ${shoes3}
      <text x="560" y="${FLOOR + 36}" font-size="12" fill="#8a8a8a" text-anchor="end">${esc(p.name)} · EU ${target.eu}</text>`;
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
