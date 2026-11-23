/* Homepage hero in three.js: the best-seller walks onto the screen, heel-to-toe.
   - Move the pointer to look around the boots; click a boot to make it hop.
   - "Walk again" sends them off and back on.
   Falls back to the CSS animation in app.js if three.js or WebGL isn't available. */
window.YOLO_HERO3D = "loading";

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const stage = document.getElementById("run-stage");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function fail(reason) {
  console.info("3D hero unavailable:", reason);
  window.YOLO_HERO3D = "failed";
  stage?.classList.remove("three");
  window.dispatchEvent(new Event("hero3d:failed"));
}

function webglOK() {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function start() {
  if (!stage) return;
  if (!webglOK()) return fail("no WebGL");
  let THREE;
  try { THREE = await withTimeout(import(THREE_URL), 7000); } catch (e) { return fail(e.message); }

  const products = window.YOLO_PRODUCTS || [];
  const slug = (window.YOLO_CONFIG?.offer?.slug) || products[0]?.slug;
  const product = products.find((p) => p.slug === slug) || products[0];
  if (!product) return fail("no product");
  const sideView = Boolean(product.cutoutSide);
  const src = product.cutoutSide || product.cutout || product.images[0];

  let texture;
  try {
    texture = await withTimeout(new THREE.TextureLoader().loadAsync(src), 8000);
  } catch (e) { return fail("texture " + e.message); }
  texture.colorSpace = THREE.SRGBColorSpace;

  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const canvas = renderer.domElement;
  canvas.id = "hero-3d";
  canvas.setAttribute("aria-label", `${product.name} walking onto the screen. Click a boot to make it hop.`);
  canvas.setAttribute("role", "img");
  stage.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const look = new THREE.Vector3(0.25, 1.05, 0);
  const CAM_R = 9.5;

  // ---------- boot geometry (pivot maths in boot-local coords, sole at y=0) ----------
  const img = texture.image;
  const aspect = img.width / img.height;
  const H = sideView ? 2.45 : 2.3, W = H * aspect;
  // measured from the side cut-out: transparent padding around the boot
  const pad = sideView ? { l: 0.057, r: 0.027, b: 0.073 } : { l: 0.04, r: 0.04, b: 0.04 };
  const geo = new THREE.PlaneGeometry(W, H);
  geo.translate(0, H / 2 - pad.b * H, 0);                 // sole sits on y = 0
  const HEEL = -W / 2 + pad.l * W, TOE = W / 2 - pad.r * W;

  // soft contact shadow texture
  const sc = document.createElement("canvas"); sc.width = sc.height = 128;
  const g = sc.getContext("2d"); const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.55)"); grad.addColorStop(0.55, "rgba(0,0,0,0.18)"); grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(sc);

  function makeFoot(z, tint, order) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, color: tint });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = order + 1;
    group.add(mesh);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.95, 0.3 * H), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.set((HEEL + TOE) / 2, 0.002, 0); shadow.renderOrder = 0;
    group.add(shadow);
    group.position.z = z;
    scene.add(group);
    return { group, mesh, shadow, x: 0, y: 0, a: 0, pivot: 0, step: null, hop: null };
  }
  // far boot is a touch darker, so the pair reads as left + right
  const feet = sideView
    ? [makeFoot(-0.42, 0x9a9a9a, 0), makeFoot(0.42, 0xffffff, 2)]
    : [makeFoot(0, 0xffffff, 0)];
  const near = feet[feet.length - 1];

  function applyFoot(f) {
    // rotate the boot by f.a about a point on the sole (heel or toe), then lift by f.y
    const P = f.a >= 0 ? HEEL : TOE;
    f.mesh.rotation.z = f.a;
    f.mesh.position.set(P - P * Math.cos(f.a), f.y - P * Math.sin(f.a), 0);
    f.group.position.x = f.x;
    const lift = Math.max(0, f.y + Math.abs(Math.sin(f.a)) * W * 0.35);
    const k = 1 / (1 + lift * 1.6);
    f.shadow.scale.set(0.6 + 0.4 * k, 0.6 + 0.4 * k, 1);
    f.shadow.material.opacity = 0.25 + 0.75 * k;
  }

  // ---------- walk cycle ----------
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const clamp01 = (t) => Math.min(1, Math.max(0, t));
  const STEP_T = 0.56, STEP_GAP = 0.43;
  const STRIDE = 0.62 * H;          // seconds per step / between step starts
  const TOE_OFF = -0.42, HEEL_STRIKE = 0.26;     // radians

  // pose of a stepping foot at progress s (0..1)
  function stepPose(st, s) {
    const lift = 0.2 * H * Math.min(1, Math.abs(st.to - st.from) / STRIDE) + 0.04 * H;
    if (s < 0.2) {                     // toe-off: heel rises, toe stays planted
      const t = ease(s / 0.2); return { x: st.from, y: 0, a: TOE_OFF * t };
    }
    if (s < 0.85) {                    // swing: travel forward in an arc
      const t = (s - 0.2) / 0.65, e = ease(t);
      return { x: st.from + (st.to - st.from) * e, y: lift * Math.sin(Math.PI * t), a: TOE_OFF + (HEEL_STRIKE - TOE_OFF) * ease(t) };
    }
    const t = ease((s - 0.85) / 0.15);   // heel strike, roll down to flat
    return { x: st.to, y: 0, a: HEEL_STRIKE * (1 - t) };
  }

  let schedule = [];   // [{foot, from, to, t0}]
  let clock = 0;

  function planWalk(fromX, toNear, toFar, stride = STRIDE) {
    // feet start together at fromX; alternate steps, back foot first, until both reach their spot
    schedule = [];
    const pos = feet.map(() => fromX);
    const finals = sideView ? [toFar, toNear] : [toNear];
    let t = clock + 0.15, mover = 0, guard = 0;
    while (pos.some((p, i) => Math.abs(p - finals[i]) > 1e-3) && guard++ < 60) {
      const other = feet.length > 1 ? pos[1 - mover] : pos[mover];
      const target = Math.min(finals[mover], other + stride);
      if (target > pos[mover] + 1e-3) {
        schedule.push({ foot: feet[mover], from: pos[mover], to: target, t0: t });
        pos[mover] = target; t += STEP_GAP;
      }
      if (feet.length > 1) mover = 1 - mover;
    }
    feet.forEach((f) => { f.x = fromX; f.a = 0; f.y = 0; f.step = null; f.done = null; applyFoot(f); });
    return t + STEP_T;
  }

  let phase = "enter", phaseEnd = 0, nextTap = 0;
  const HOME = { near: 0.45, far: -0.1 };
  function viewHalfWidth() { return Math.tan((camera.fov * Math.PI) / 360) * CAM_R * camera.aspect; }
  function walkIn() {
    phase = "enter";
    phaseEnd = planWalk(-viewHalfWidth() - W * 1.2, HOME.near, HOME.far);
  }
  function walkOutThenIn() {
    phase = "exit";
    // continue walking to the right edge from where they stand
    schedule = [];
    const pos = feet.map((f) => f.x), endX = viewHalfWidth() + W * 1.2;
    let t = clock + 0.05, mover = 0;
    for (let k = 0; k < 40 && pos.some((p) => p < endX); k++) {
      const other = feet.length > 1 ? pos[1 - mover] : pos[mover];
      const target = Math.min(endX + (mover ? 0.4 : 0), other + STRIDE);
      if (target > pos[mover]) { schedule.push({ foot: feet[mover], from: pos[mover], to: target, t0: t }); pos[mover] = target; t += STEP_GAP; }
      if (feet.length > 1) mover = 1 - mover;
    }
    phaseEnd = t + STEP_T;
  }

  function updateSteps() {
    for (const f of feet) f.step = null;
    for (const st of schedule) {
      const s = (clock - st.t0) / STEP_T;
      if (s >= 0 && s <= 1) st.foot.step = { st, s };
      else if (s > 1 && (!st.foot.done || st.foot.done.t0 < st.t0)) st.foot.done = st;
    }
    for (const f of feet) {
      if (f.step) Object.assign(f, stepPose(f.step.st, f.step.s));
      else { if (f.done) f.x = f.done.to; f.y = 0; f.a = 0; }
      if (f.hop) {                                  // click hop
        const s = (clock - f.hop) / 0.55;
        if (s >= 1) f.hop = null;
        else { f.y += 0.55 * Math.sin(Math.PI * s); f.a += 0.18 * Math.sin(Math.PI * s); }
      }
      if (f.tap) {                                  // idle toe tap (heel stays down)
        const s = (clock - f.tap) / 0.42;
        if (s >= 1) f.tap = null; else f.a += 0.13 * Math.sin(Math.PI * s);
      }
      applyFoot(f);
    }
  }

  // ---------- camera: pointer parallax ----------
  const aim = { yaw: 0, pitch: 0 }, cur = { yaw: 0.18, pitch: 0.12 };
  stage.addEventListener("pointermove", (e) => {
    const r = stage.getBoundingClientRect();
    aim.yaw = ((e.clientX - r.left) / r.width - 0.5) * 0.55;
    aim.pitch = ((e.clientY - r.top) / r.height - 0.5) * 0.25;
  });
  stage.addEventListener("pointerleave", () => { aim.yaw = 0; aim.pitch = 0; });

  // ---------- click a boot to hop ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function hitFoot(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(feet.map((f) => f.mesh));
    // ignore clicks on transparent parts of the image
    for (const h of hits) {
      const uv = h.uv; const c = alphaAt(uv.x, uv.y);
      if (c > 0.3) return feet.find((f) => f.mesh === h.object);
    }
    return null;
  }
  const ac = document.createElement("canvas"); ac.width = 128; ac.height = Math.round(128 / aspect);
  const actx = ac.getContext("2d", { willReadFrequently: true }); actx.drawImage(img, 0, 0, ac.width, ac.height);
  const alphaData = actx.getImageData(0, 0, ac.width, ac.height).data;
  function alphaAt(u, v) {
    const x = Math.min(ac.width - 1, Math.floor(u * ac.width)), y = Math.min(ac.height - 1, Math.floor((1 - v) * ac.height));
    return alphaData[(y * ac.width + x) * 4 + 3] / 255;
  }
  canvas.addEventListener("pointermove", (e) => { canvas.style.cursor = phase === "idle" && hitFoot(e) ? "pointer" : ""; });
  canvas.addEventListener("click", (e) => {
    const f = hitFoot(e);
    if (f && phase === "idle") { f.hop = clock; if (feet.length > 1) feet.find((o) => o !== f).hop = clock + 0.12; }
  });
  window.addEventListener("hero:replay", () => { if (phase === "idle") walkOutThenIn(); });

  // ---------- sizing / loop ----------
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < 520 ? 34 : 28;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  let visible = true, last = performance.now();
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; }).observe(stage);

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (visible && !document.hidden) {
      clock += dt;
      if (phase === "enter" && clock > phaseEnd) { phase = "idle"; nextTap = clock + 3; }
      if (phase === "exit" && clock > phaseEnd) walkIn();
      if (phase === "idle" && clock > nextTap && !reduceMotion) { near.tap = clock; nextTap = clock + 4 + Math.random() * 3; }
      updateSteps();
      const k = 1 - Math.pow(0.001, dt);
      cur.yaw += (aim.yaw + 0.18 - cur.yaw) * k * 0.6;
      cur.pitch += (aim.pitch + 0.12 - cur.pitch) * k * 0.6;
      camera.position.set(Math.sin(cur.yaw) * CAM_R, look.y + Math.sin(cur.pitch) * CAM_R, Math.cos(cur.yaw) * CAM_R);
      camera.lookAt(look);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }

  stage.classList.add("three");
  window.YOLO_HERO3D = "ready";
  if (reduceMotion) {
    feet.forEach((f, i) => { f.x = feet.length > 1 ? (i ? HOME.near : HOME.far) : HOME.near; f.done = { to: f.x, t0: -1 }; applyFoot(f); });
    phase = "idle";
  } else walkIn();
  requestAnimationFrame(frame);
}

start().catch((e) => fail(e?.message || String(e)));
