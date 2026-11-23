/* Shop page showcase in three.js: a floating turntable of shoes.
   Drag or swipe to spin, hover to lift a shoe, click the front shoe to open it
   (click any other shoe to bring it to the front). Arrow keys work too.
   Falls back to the CSS carousel in app.js if three.js or WebGL isn't available. */
const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const host = document.getElementById("shop3d");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const aud = (n) => "A$" + Number(n).toFixed(0);

async function start() {
  if (!host) return;
  try { const c = document.createElement("canvas"); if (!(c.getContext("webgl2") || c.getContext("webgl"))) return; } catch { return; }
  let THREE;
  try { THREE = await withTimeout(import(THREE_URL), 7000); } catch { return; }
  const items = (window.YOLO_SHOWCASE || []).slice(0, 12);
  if (items.length < 3) return;
  const priceOf = window.YOLO_PRICE_OF || ((p) => p.price);

  const loader = new THREE.TextureLoader();
  const textures = await Promise.all(items.map((p) => withTimeout(loader.loadAsync(p.cutout), 8000).catch(() => null)));

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "Spinning showcase of shoes. Drag or use the arrow keys to turn; press Enter to open the front shoe.");
  host.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const ring = new THREE.Group(); scene.add(ring);
  const n = items.length;
  const R = Math.max(3.2, n * 0.5);
  const step = (Math.PI * 2) / n;

  const sc = document.createElement("canvas"); sc.width = sc.height = 128;
  const g = sc.getContext("2d"); const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.35)"); grad.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(sc);

  const nodes = items.map((p, i) => {
    const tex = textures[i];
    const node = new THREE.Group();
    const θ = i * step;
    node.position.set(Math.sin(θ) * R, 0, Math.cos(θ) * R);
    let mesh = null;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const a = tex.image.width / tex.image.height, h = 1.5, w = h * a;
      const geo = new THREE.PlaneGeometry(w, h); geo.translate(0, h / 2, 0);
      mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      node.add(mesh);
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.9, 0.6), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
      sh.rotation.x = -Math.PI / 2; sh.position.y = 0.01; node.add(sh);
      node.userData.shadow = sh;
    }
    node.userData = { ...node.userData, p, θ, mesh, lift: 0, bob: Math.random() * Math.PI * 2 };
    ring.add(node);
    return node;
  });

  // ---- state ----
  let angle = 0, vel = reduceMotion ? 0 : -0.0025, dragging = false, lastX = 0, moved = 0, target = null, hovered = null;
  const label = host.querySelector(".shop3d-label");
  let frontIdx = -1;
  const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  function frontIndex() {
    let best = 0, bestD = 9;
    nodes.forEach((nd, i) => { const d = Math.abs(norm(nd.userData.θ + angle)); if (d < bestD) { bestD = d; best = i; } });
    return best;
  }
  function showLabel(i) {
    if (i === frontIdx || !label) return; frontIdx = i;
    const p = items[i];
    label.innerHTML = `<h3>${p.name.replace(/[<>&]/g, "")}</h3><p>${aud(priceOf(p))}</p>`;
  }
  function bringToFront(i) { target = angle - norm(nodes[i].userData.θ + angle); vel = 0; }

  // ---- input ----
  canvas.addEventListener("pointerdown", (e) => { dragging = true; moved = 0; lastX = e.clientX; target = null; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) { const dx = e.clientX - lastX; lastX = e.clientX; moved += Math.abs(dx); const d = dx * 0.006; angle += d; vel = d; }
    else hovered = pick(e);
    canvas.style.cursor = dragging ? "grabbing" : hovered ? "pointer" : "grab";
  });
  const end = () => { dragging = false; if (Math.abs(vel) < 0.004) bringToFront(frontIndex()); };
  canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { hovered = null; });
  canvas.addEventListener("click", (e) => {
    if (moved > 6) return;
    const hit = pick(e); if (!hit) return;
    const i = nodes.indexOf(hit);
    if (i === frontIndex()) location.href = `/product?m=${encodeURIComponent(items[i].slug)}`;
    else bringToFront(i);
  });
  canvas.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { bringToFront((frontIndex() + n - 1) % n); e.preventDefault(); }
    if (e.key === "ArrowRight") { bringToFront((frontIndex() + 1) % n); e.preventDefault(); }
    if (e.key === "Enter") location.href = `/product?m=${encodeURIComponent(items[frontIndex()].slug)}`;
  });

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(nodes.map((nd) => nd.userData.mesh).filter(Boolean));
    return hits.length ? hits[0].object.parent : null;
  }

  // ---- size / loop ----
  function resize() {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const dist = R + (w < 600 ? 7.5 : 6);
    camera.position.set(0, 1.9, dist);
    camera.lookAt(0, 0.55, R * 0.35);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host); resize();
  let visible = true; new IntersectionObserver(([en]) => { visible = en.isIntersecting; }).observe(host);

  let t = 0, last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (visible && !document.hidden) {
      t += dt;
      if (!dragging) {
        if (target !== null) { const d = target - angle; angle += d * Math.min(1, dt * 8); if (Math.abs(d) < 0.0005) { angle = target; target = null; } }
        else { angle += vel; vel += ((reduceMotion ? 0 : -0.0025) - vel) * Math.min(1, dt * 1.5); }
      }
      ring.rotation.y = angle;
      const fi = frontIndex(); showLabel(fi);
      nodes.forEach((nd, i) => {
        const u = nd.userData; const a = norm(u.θ + angle);
        nd.rotation.y = -angle + a * 0.3;          // cancel the ring spin so each shoe faces the camera, plus a slight turn
        const want = (nd === hovered ? 0.22 : 0) + (i === fi ? 0.08 : 0);
        u.lift += (want - u.lift) * Math.min(1, dt * 10);
        const bob = reduceMotion ? 0 : Math.sin(t * 1.6 + u.bob) * 0.04;
        if (u.mesh) {
          u.mesh.position.y = 0.12 + u.lift + bob;
          const s = 1 + u.lift * 0.35; u.mesh.scale.set(s, s, 1);
          const depth = (Math.cos(a) + 1) / 2;                          // 1 = front, 0 = back
          u.mesh.material.opacity = 0.35 + 0.65 * depth;
          u.mesh.renderOrder = Math.round(depth * 100);
          if (u.shadow) { u.shadow.material.opacity = (0.4 + 0.6 * depth) / (1 + u.lift * 3); u.shadow.renderOrder = 0; }
        }
      });
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }
  host.classList.add("three");
  requestAnimationFrame(frame);
}

start().catch((e) => console.info("3D shop unavailable:", e?.message || e));
