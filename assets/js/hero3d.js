/* Homepage hero in three.js — the best-seller walks continuously, heel to toe, on a moving floor.
   - The canvas fills the whole hero, so nothing gets clipped.
   - Floor lines scroll under the boots and each heel strike leaves a fading footprint.
   - Scrolling the page makes them walk faster; move the pointer to look around; click a boot to hop.
   - The Pause button stops/starts the walk.
   Falls back to the CSS animation in app.js if three.js or WebGL isn't available. */
window.YOLO_HERO3D = "loading";

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
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

function radialTexture(THREE, stops) {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"); const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

async function start() {
  if (!stage) return;
  if (!webglOK()) return fail("no WebGL");
  let THREE;
  try { THREE = await withTimeout(import(THREE_URL), 7000); } catch (e) { return fail(e.message); }

  const products = window.YOLO_PRODUCTS || [];
  const slug = window.YOLO_CONFIG?.offer?.slug || products[0]?.slug;
  const product = products.find((p) => p.slug === slug) || products[0];
  if (!product) return fail("no product");
  const sideView = Boolean(product.cutoutSide);
  const src = product.cutoutSide || product.cutout || product.images[0];
  let texture;
  try { texture = await withTimeout(new THREE.TextureLoader().loadAsync(src), 8000); } catch (e) { return fail("texture " + e.message); }
  texture.colorSpace = THREE.SRGBColorSpace;

  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const canvas = renderer.domElement;
  canvas.id = "hero-3d";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${product.name} walking. Click a boot to make it hop.`);
  stage.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const rig = new THREE.Group(); scene.add(rig);           // everything moves together (placed per screen size)
  const CAM_R = 10;
  const look = new THREE.Vector3();

  // ---------- boot geometry: sole on y = 0; pivots at heel/toe ----------
  const img = texture.image, aspect = img.width / img.height;
  const H = sideView ? 1.75 : 1.7, W = H * aspect;
  const pad = sideView ? { l: 0.057, r: 0.027, b: 0.073 } : { l: 0.04, r: 0.04, b: 0.04 };
  const geo = new THREE.PlaneGeometry(W, H);
  geo.translate(0, H / 2 - pad.b * H, 0);
  const HEEL = -W / 2 + pad.l * W, TOE = W / 2 - pad.r * W, MID = (HEEL + TOE) / 2;

  const shadowTex = radialTexture(THREE, [[0, "rgba(0,0,0,0.5)"], [0.55, "rgba(0,0,0,0.16)"], [1, "rgba(0,0,0,0)"]]);
  const printTex = radialTexture(THREE, [[0, "rgba(0,0,0,0.16)"], [0.7, "rgba(0,0,0,0.06)"], [1, "rgba(0,0,0,0)"]]);

  function makeFoot(z, tint, order, phaseOffset) {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, color: tint }));
    mesh.renderOrder = order + 10;
    group.add(mesh);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.95, 0.32 * H), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.set(MID, 0.003, 0); shadow.renderOrder = 2;
    group.add(shadow);
    group.position.z = z;
    rig.add(group);
    return { group, mesh, shadow, z, phaseOffset, x: 0, y: 0, a: 0, wasSwing: false, hop: null };
  }
  const feet = sideView
    ? [makeFoot(-0.5, 0x8e8e8e, 0, 0.5), makeFoot(0.5, 0xffffff, 2, 0)]
    : [makeFoot(0, 0xffffff, 0, 0)];

  function applyFoot(f) {
    const P = f.a >= 0 ? HEEL : TOE;                      // toe up -> pivot heel; heel up -> pivot toe
    f.mesh.rotation.z = f.a;
    f.mesh.position.set(P - P * Math.cos(f.a), f.y - P * Math.sin(f.a), 0);
    f.group.position.x = f.x;
    const lift = Math.max(0, f.y + Math.abs(Math.sin(f.a)) * W * 0.3);
    const k = 1 / (1 + lift * 1.4);
    f.shadow.scale.set(0.55 + 0.45 * k, 0.55 + 0.45 * k, 1);
    f.shadow.material.opacity = 0.2 + 0.8 * k;
  }

  // ---------- floor: scrolling lines + footprints ----------
  const LINE_GAP = 0.9, LINE_N = 28;
  const lines = Array.from({ length: LINE_N }, () => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 3.2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.08, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.001; m.renderOrder = 1;
    rig.add(m); return m;
  });
  const prints = Array.from({ length: 12 }, () => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.7, 0.3), new THREE.MeshBasicMaterial({ map: printTex, transparent: true, opacity: 0, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.002; m.renderOrder = 1; m.userData.age = 99;
    rig.add(m); return m;
  });
  let printIdx = 0;
  function leavePrint(f) {
    const m = prints[printIdx++ % prints.length];
    m.position.set(f.x + MID, 0.002, f.z); m.userData.age = 0;
  }

  // ---------- gait (walk in place; the floor moves) ----------
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const smooth = (t) => t * t * (3 - 2 * t);
  const T = 1.15;                      // seconds per full cycle (one step each foot)
  const STANCE = 0.6;                  // share of the cycle the foot is on the ground
  const L = 0.72 * H;                  // stride travel
  const TO = -0.36, HS = 0.24;         // toe-off / heel-strike angles (rad)
  const LIFT = 0.17 * H;
  const groundSpeed = L / (STANCE * T);

  function pose(phi) {
    if (phi < STANCE) {                // on the ground, carried back by the floor
      const q = phi / STANCE;
      const x = L / 2 - L * q;
      let a = 0;
      if (q < 0.18) a = HS * (1 - smooth(q / 0.18));          // roll from heel to flat
      else if (q > 0.78) a = TO * smooth((q - 0.78) / 0.22);    // heel rises, toe still down
      return { x, y: 0, a, swing: false };
    }
    const s = (phi - STANCE) / (1 - STANCE);                     // swing forward in an arc
    return { x: -L / 2 + L * ease(s), y: LIFT * Math.sin(Math.PI * s) * (1 - 0.25 * s), a: TO + (HS - TO) * smooth(s), swing: true };
  }

  // ---------- state ----------
  let gaitT = 0, floorX = 0, speed = 1, boost = 0, paused = false, intro = reduceMotion ? 1 : 0, clock = 0;
  let lastScroll = window.scrollY;
  window.addEventListener("scroll", () => { const d = Math.abs(window.scrollY - lastScroll); lastScroll = window.scrollY; boost = Math.min(1.2, boost + d * 0.004); }, { passive: true });

  const toggle = document.getElementById("replay");
  if (toggle) {
    toggle.textContent = "Pause";
    toggle.setAttribute("aria-pressed", "false");
    toggle.addEventListener("click", (e) => {
      e.stopImmediatePropagation();
      paused = !paused;
      toggle.textContent = paused ? "Walk" : "Pause";
      toggle.setAttribute("aria-pressed", String(paused));
    }, true);
  }

  // pointer parallax
  const aim = { yaw: 0, pitch: 0 }, cur = { yaw: 0.35, pitch: 0.2 };
  const host = stage.closest(".hero") || stage;
  host.addEventListener("pointermove", (e) => {
    aim.yaw = (e.clientX / window.innerWidth - 0.5) * 0.6;
    aim.pitch = (e.clientY / window.innerHeight - 0.5) * 0.22;
  });
  host.addEventListener("pointerleave", () => { aim.yaw = 0; aim.pitch = 0; });

  // click a boot -> hop (alpha-tested so clicks on empty image areas don't count)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const ac = document.createElement("canvas"); ac.width = 128; ac.height = Math.max(1, Math.round(128 / aspect));
  const actx = ac.getContext("2d", { willReadFrequently: true }); actx.drawImage(img, 0, 0, ac.width, ac.height);
  const alpha = actx.getImageData(0, 0, ac.width, ac.height).data;
  const alphaAt = (u, v) => alpha[(Math.min(ac.height - 1, Math.floor((1 - v) * ac.height)) * ac.width + Math.min(ac.width - 1, Math.floor(u * ac.width))) * 4 + 3] / 255;
  function hitFoot(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const h of ray.intersectObjects(feet.map((f) => f.mesh))) if (h.uv && alphaAt(h.uv.x, h.uv.y) > 0.3) return feet.find((f) => f.mesh === h.object);
    return null;
  }
  canvas.addEventListener("pointermove", (e) => { canvas.style.cursor = hitFoot(e) ? "pointer" : ""; });
  canvas.addEventListener("click", (e) => { if (hitFoot(e)) feet.forEach((f, i) => { f.hop = clock + i * 0.08; }); });

  // ---------- layout: boots on the right on desktop, centred above the text on mobile ----------
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    const mobile = w < 900;
    camera.aspect = w / h;
    camera.fov = mobile ? 22 : 26;
    camera.updateProjectionMatrix();
    const halfW = Math.tan((camera.fov * Math.PI) / 360) * CAM_R * camera.aspect;
    // camera looks at the screen centre; the boots sit right of centre on desktop (clear of the copy)
    rig.position.x = mobile ? -MID : Math.max(halfW * 0.42, W * 0.62) - MID;
    look.set(0, mobile ? 0.8 : 0.75, 0);
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  // ---------- loop ----------
  let visible = true, last = performance.now();
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; }).observe(stage);

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (visible && !document.hidden) {
      clock += dt;
      boost *= Math.pow(0.25, dt);
      const target = paused || reduceMotion ? 0 : 1 + boost;
      speed += (target - speed) * Math.min(1, dt * 4);           // ease in/out of walking
      const adv = dt * speed;
      gaitT += adv;
      floorX = (floorX + groundSpeed * adv) % LINE_GAP;
      intro = Math.min(1, intro + dt / 2.4);

      const enter = (1 - smooth(intro)) * -7;                     // walk in from the left on load
      const still = 1 - Math.min(1, speed);                       // 1 when stopped: stand flat, side by side
      for (const f of feet) {
        const phi = ((gaitT / T + f.phaseOffset) % 1 + 1) % 1;
        const p = pose(phi);
        const rest = feet.length > 1 && f === feet[0] ? -0.15 : 0.15;
        f.x = p.x * (1 - still) + rest * still + enter;
        f.y = p.y * (1 - still);
        f.a = p.a * (1 - still);
        if (f.wasSwing && !p.swing && speed > 0.3) leavePrint(f);
        f.wasSwing = p.swing;
        if (f.hop !== null) {
          const s = (clock - f.hop) / 0.6;
          if (s >= 1) f.hop = null; else if (s > 0) { f.y += 0.5 * Math.sin(Math.PI * s); f.a += 0.14 * Math.sin(Math.PI * s); }
        }
        applyFoot(f);
      }
      // floor lines scroll back and fade towards the edges
      const span = LINE_N * LINE_GAP, halfSpan = span / 2;
      lines.forEach((m, i) => {
        const x = (((i * LINE_GAP - floorX) % span) + span) % span - halfSpan + MID;
        m.position.x = x;
        m.material.opacity = 0.09 * Math.max(0, 1 - Math.abs(x - MID) / halfSpan) * smooth(intro);
      });
      // footprints drift back with the floor and fade
      prints.forEach((m) => {
        const u = m.userData; if (u.age > 3) { m.material.opacity = 0; return; }
        u.age += dt; m.position.x -= groundSpeed * adv;
        m.material.opacity = Math.max(0, 1 - u.age / 2.4) * 0.9;
      });

      // camera
      const k = 1 - Math.pow(0.02, dt);
      cur.yaw += (aim.yaw + 0.35 - cur.yaw) * k;
      cur.pitch += (aim.pitch + 0.2 - cur.pitch) * k;
      camera.position.set(look.x + Math.sin(cur.yaw) * CAM_R, look.y + Math.sin(cur.pitch) * CAM_R, Math.cos(cur.yaw) * CAM_R);
      camera.lookAt(look);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }

  stage.classList.add("three");
  window.YOLO_HERO3D = "ready";
  requestAnimationFrame(frame);
}

start().catch((e) => fail(e?.message || String(e)));
