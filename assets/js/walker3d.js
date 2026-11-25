/* 3D model: a realistic model (women's or men's body) standing in a seamless studio, wearing the
   YOLO casual outfit (black fleece hoodie with the कथा chest logo and Phool back print, joggers) or the formal
   one (black coat, white shirt, black trousers), and - once their 3D scans are in - our shoes.

   Models: /assets/models/walker/walker-{f,m}.glb, built in Blender (MPFB bodies; garments settled with a cloth
   simulation in the standing pose and skinned; a 6 s breathing idle; Draco). walker.json holds each body's height.
   Shoes: /assets/models/shoes/manifest.json (same file the fit tool uses). An entry may add
   "sole_mm" (sole thickness, default 25) and "accent" ("#rrggbb"; default: the colourway's own colour).
   The hoodie cuffs and the jogger side stripes take the shoe's accent; with no shoe they stay black. */

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
const ADDONS = "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/";
const BASE = "/assets/models/walker/";
const FLEECE = "#1e1e20";
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const slugify = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const DEFAULTS = { f: { kg: 58 }, m: { kg: 72 } };

function el(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of [].concat(kids)) if (k) e.append(k);
  return e;
}
function seg(label, name, options, value, onChange) {
  const box = el("div", { class: "walker-seg", role: "group", "aria-label": label });
  const btns = options.map(([v, t]) => {
    const b = el("button", { type: "button", "aria-pressed": String(v === value), "data-v": v, text: t });
    b.addEventListener("click", () => { btns.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); onChange(v); });
    return b;
  });
  box.append(...btns);
  return el("div", { class: "walker-row" }, [el("span", { class: "walker-label", text: label }), box]);
}
function range(label, min, max, step, value, fmt, onInput) {
  const out = el("b", { text: fmt(value) });
  const inp = el("input", { type: "range", min, max, step, value, "aria-label": label });
  inp.addEventListener("input", () => { out.textContent = fmt(+inp.value); onInput(+inp.value); });
  const f = el("label", { class: "field walker-field" }, [el("span", {}, [label, out]), inp]);
  f.set = (v) => { inp.value = v; out.textContent = fmt(+v); };
  return f;
}

export function mountWalker(root, { products = [] } = {}) {
  // ---------- UI ----------
  const canvasBox = el("div", { class: "walker-stage" });
  const status = el("p", { class: "walker-status", text: "Loading the 3D model…" });
  const camBtns = el("div", { class: "walker-cam" });
  const viewBtn = (v, t) => { const b = el("button", { type: "button", class: "chip", text: t }); b.addEventListener("click", () => frameView(v)); return b; };
  const bReset = el("button", { type: "button", class: "chip", text: "Reset" });
  camBtns.append(viewBtn("front", "Front"), viewBtn("side", "Side"), viewBtn("back", "Back"), viewBtn("shoes", "Shoes close-up"), bReset);
  canvasBox.append(status, camBtns);

  const st = { body: "m", outfit: "casual", walk: false, heightCm: null, kg: null, shoe: null, floating: false };
  const hRange = range("Height", 150, 195, 1, 178, (v) => `${v} cm`, (v) => { st.heightCm = v; applyShape(); frameView("full"); });
  const wRange = range("Weight", 45, 110, 1, 72, (v) => `${v} kg`, (v) => { st.kg = v; applyShape(); });
  const shoeList = el("div", { class: "walker-shoes", role: "list" });
  const shoeNote = el("p", { class: "fineprint walker-shoenote", text: "" });
  const floatChk = el("input", { type: "checkbox", disabled: true });
  floatChk.addEventListener("change", () => { st.floating = floatChk.checked; updateFloating(); });
  const ui = el("div", { class: "walker-ui" }, [
    seg("Model", "body", [["f", "Women"], ["m", "Men"]], st.body, (v) => { st.body = v; st.heightCm = null; st.kg = null; showBody(); }),
    seg("Outfit", "outfit", [["casual", "Try in casual"], ["formal", "Try in formal"]], st.outfit, (v) => { st.outfit = v; applyOutfit(); }),
    seg("Motion", "motion", [["stand", "Stand"], ["walk", "Walk"]], "stand", (v) => { st.walk = v === "walk"; applyMotion(); }),
    hRange, wRange,
    el("div", { class: "walker-row walker-row-col" }, [el("span", { class: "walker-label", text: "Shoes" }), shoeList, shoeNote]),
    el("label", { class: "walker-toggle" }, [floatChk, el("span", { text: "Show the shoe big, floating behind" })])
  ]);
  root.append(el("div", { class: "walker" }, [canvasBox, ui]));

  // ---------- three ----------
  let THREE, renderer, scene, camera, controls, clock, floor, floorTex, key, loaderP, meta = {};
  const bodies = {};               // f/m -> { root, mixer, walk, idle, accent: [], bones: {}, rest: {} }
  let cur = null, camAnim = null, started = false, visible = false;
  let shoeObjs = [], floatObj = null, manifest = {};

  async function start() {
    if (started) return; started = true;
    try {
      const [T, { OrbitControls }, { RoomEnvironment }] = await Promise.all([
        import(THREE_URL), import(ADDONS + "controls/OrbitControls.js"), import(ADDONS + "environments/RoomEnvironment.js")
      ]);
      THREE = T;
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;   // Neutral from three r162; ACES keeps blacks black before that
      renderer.toneMappingExposure = THREE.NeutralToneMapping ? 0.95 : 1.15;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.localClippingEnabled = true;
      canvasBox.prepend(renderer.domElement);
      scene = new THREE.Scene();
      const bg = new THREE.Color("#e4e4e6"); scene.background = bg; scene.fog = new THREE.Fog(bg, 7, 16);   // seamless sweep
      const pm = new THREE.PMREMGenerator(renderer);
      scene.environment = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture;
      scene.environmentIntensity = 0.28;
      scene.add(new THREE.HemisphereLight("#ffffff", "#c9c9cc", 0.35));
      key = new THREE.DirectionalLight("#fffaf2", 1.7);                 // soft daylight from the front-left
      key.position.set(2.2, 4.5, 3.0); key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 6; key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
      Object.assign(key.shadow.camera, { left: -1.4, right: 1.4, top: 2.4, bottom: -0.4, near: 0.5, far: 12 });
      scene.add(key, key.target);
      const rim = new THREE.DirectionalLight("#ffffff", 0.7); rim.position.set(-3, 3, -3); scene.add(rim);
      // floor: seamless matte studio sweep; fog blends it into the backdrop
      // a barely-there grain, only so the floor visibly moves under the feet when walking
      const c = document.createElement("canvas"); c.width = c.height = 256; const g = c.getContext("2d");
      g.fillStyle = "#e0e0e2"; g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 2200; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.03})`; g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5); }
      floorTex = new THREE.CanvasTexture(c); floorTex.colorSpace = THREE.SRGBColorSpace;
      floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping; floorTex.repeat.set(40, 40); floorTex.anisotropy = 8;
      floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1 }));
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
      // contact shadow: a soft blob right under the feet, on top of the directional shadow
      const cs = document.createElement("canvas"); cs.width = cs.height = 128; const cg = cs.getContext("2d");
      const grd = cg.createRadialGradient(64, 64, 4, 64, 64, 62); grd.addColorStop(0, "rgba(0,0,0,0.35)"); grd.addColorStop(1, "rgba(0,0,0,0)");
      cg.fillStyle = grd; cg.fillRect(0, 0, 128, 128);
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cs), transparent: true, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.002; scene.add(blob);

      camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
      controls = new OrbitControls(camera, renderer.domElement);
      Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 0.55, maxDistance: 9, maxPolarAngle: Math.PI * 0.495 });
      controls.addEventListener("start", () => { camAnim = null; });
      clock = new THREE.Clock();
      new ResizeObserver(resize).observe(canvasBox); resize();
      meta = await fetch(BASE + "walker.json").then((r) => r.json()).catch(() => ({}));
      manifest = await fetch("/assets/models/shoes/manifest.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      buildShoeList();
      await showBody();
      frameView("full", true);
      renderer.setAnimationLoop(tick);
    } catch (e) {
      console.warn("Walker failed to start", e);
      status.textContent = "The 3D model couldn't load on this device."; status.hidden = false;
    }
  }

  function resize() {
    if (!renderer) return;
    const w = canvasBox.clientWidth, h = canvasBox.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  }

  async function loader() {
    loaderP ||= (async () => {
      const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([import(ADDONS + "loaders/GLTFLoader.js"), import(ADDONS + "loaders/DRACOLoader.js")]);
      const d = new DRACOLoader(); d.setDecoderPath(ADDONS + "libs/draco/gltf/");
      const l = new GLTFLoader(); l.setDRACOLoader(d); return l;
    })();
    return loaderP;
  }

  // Real fabric surface: a tiling knit / twill / weave normal map, scaled from the mesh's own UV density so
  // a knit loop is knit-loop sized on every garment; fleece keeps a soft sheen, wool a little more.
  const FABRIC = [
    [/hoodie/i, { file: "fleece-normal.webp", tile: 0.05, scale: 0.55, rough: 0.95, sheen: 0.35, sheenRough: 0.8 }],
    [/fleece|accent/i, { file: "jersey-normal.webp", tile: 0.045, scale: 0.5, rough: 0.9, sheen: 0.25, sheenRough: 0.8 }],
    [/suit/i, { file: "twill-normal.webp", tile: 0.03, scale: 0.35, rough: 0.78, sheen: 0.2, sheenRough: 0.6 }]
  ];
  const texCache = new Map();
  const fabricTex = (file) => {
    if (!texCache.has(file)) {
      const t = new THREE.TextureLoader().load(BASE + file);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; texCache.set(file, t);
    }
    return texCache.get(file);
  };
  function uvMetres(geo) {                                          // average metres per UV unit (bind pose)
    const p = geo.attributes.position, uv = geo.attributes.uv, idx = geo.index;
    if (!p || !uv) return 1;
    const tri = idx ? idx.count / 3 : p.count / 3, step = Math.max(1, Math.floor(tri / 400)); let sw = 0, su = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let t = 0; t < tri; t += step) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1);
      const du = Math.hypot(uv.getX(i0) - uv.getX(i1), uv.getY(i0) - uv.getY(i1));
      if (du > 1e-6) { sw += a.distanceTo(b); su += du; }
    }
    return su ? sw / su : 1;
  }
  function dressFabric(mesh, m) {
    const f = FABRIC.find(([re]) => re.test(m.name))?.[1];
    if (!f || !m.isMeshStandardMaterial) return;
    const t = fabricTex(f.file).clone();
    const rep = uvMetres(mesh.geometry) / f.tile; t.repeat.set(rep, rep); t.channel = 0;
    m.normalMap = t; m.normalScale.set(f.scale, f.scale); m.roughness = f.rough;
    if ("sheen" in m) { m.sheen = f.sheen; m.sheenRoughness = f.sheenRough; m.sheenColor.set(0x3a3a3c); }
    m.needsUpdate = true;
  }

  // jogger side stripe: a smooth 0..1 mask in the vertex colour; drawn crisp in the shader, in the accent colour
  function stripeShader(m, rec) {
    m.vertexColors = false;
    const u = { uAccent: { value: new THREE.Color(FLEECE) } };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute vec4 color;\nvarying float vStripe;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvStripe = color.r;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform vec3 uAccent;\nvarying float vStripe;")
        .replace("#include <map_fragment>", "#include <map_fragment>\nfloat sw = fwidth(vStripe) + 1e-4;\ndiffuseColor.rgb = mix(diffuseColor.rgb, uAccent, smoothstep(0.5 - sw, 0.5 + sw, vStripe));");
    };
    m.customProgramCacheKey = () => "yolo-stripe";
    rec.stripe.push(u); m.needsUpdate = true;
  }

  async function loadBody(b) {
    if (bodies[b]) return bodies[b];
    const gltf = await (await loader()).loadAsync(BASE + `walker-${b}.glb`);
    const rootObj = new THREE.Group(); rootObj.add(gltf.scene);
    const rec = { root: rootObj, mixer: new THREE.AnimationMixer(gltf.scene), accent: [], skin: [], stripe: [], parts: [], bones: {}, rest: {} };
    gltf.scene.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        for (const m of [].concat(o.material)) {
          if (/accent/i.test(m.name)) rec.accent.push(m);
          if (m.map) m.map.anisotropy = 8;
          dressFabric(o, m);
          if (/skin/i.test(m.name)) { m.roughness = 0.58; m.metalness = 0; }
          if (/eyes/i.test(m.name)) { m.roughness = 0.12; m.alphaTest = 0.5; m.transparent = false; }   // outer cornea layer is see-through
          if (/hair|brows|lashes/i.test(m.name)) { m.roughness = 0.5; m.alphaTest = 0.35; m.transparent = false; m.depthWrite = true; m.side = THREE.DoubleSide; }
          if (/skin/i.test(m.name)) rec.skin.push(m);
          if (o.geometry.attributes.color && /fleece/i.test(m.name)) stripeShader(m, rec);
        }
      }
      if (o.userData?.yolo_outfit) rec.parts.push(o);
      if (o.isBone) { rec.bones[o.name] = o; rec.rest[o.name] = o.scale.clone(); }
    });
    const clip = (re) => gltf.animations.find((a) => re.test(a.name));
    rec.idle = clip(/idle/i) ? rec.mixer.clipAction(clip(/idle/i)) : null;
    rec.walk = clip(/walk/i) ? rec.mixer.clipAction(clip(/walk/i)) : null;
    rec.idle?.play(); if (rec.walk) { rec.walk.play(); rec.walk.setEffectiveWeight(0); }
    rec.meta = meta[b.toUpperCase()] || {};
    bodies[b] = rec; return rec;
  }

  async function showBody() {
    status.textContent = "Loading the 3D model…"; status.hidden = false;
    const rec = await loadBody(st.body);
    if (cur && cur !== rec) scene.remove(cur.root);
    cur = rec; scene.add(rec.root);
    const natural = Math.round((rec.meta.height_m || 1.7) * 100);
    st.heightCm ??= natural; st.kg ??= DEFAULTS[st.body].kg;
    hRange.set(st.heightCm); wRange.set(st.kg);
    applyOutfit(); applyMotion(true); applyShape(); applyAccent(); attachShoes();
    status.hidden = true;
  }

  function applyOutfit() {
    if (!cur) return;
    for (const p of cur.parts) { const o = p.userData.yolo_outfit; p.visible = o === "both" || o === st.outfit; }
  }
  // standing is the default; walking crossfades in (0.5 s) and the floor moves at the planted foot's speed
  function applyMotion(instant) {
    if (!cur || !cur.walk || !cur.idle) return;
    const [to, from] = st.walk ? [cur.walk, cur.idle] : [cur.idle, cur.walk];
    if (instant) { to.setEffectiveWeight(1); from.setEffectiveWeight(0); return; }
    to.enabled = true; to.setEffectiveWeight(1); to.time = 0; from.crossFadeTo(to, 0.5, false);
  }
  // height: the whole figure (bones, body, clothes) scales together, so nothing clips; the floor speed scales too.
  // weight: girth of the torso, thighs and upper arms (bone scale across the bone), children counter-scaled.
  const B = (n) => cur.bones[n] || cur.bones[n.replace(/\./g, "")];
  function girth(name, f, child) {
    const b = B(name); if (!b) return;
    cur.girth.push([b, f]);
    for (const cn of [].concat(child || [])) { const c = B(cn); if (c) cur.girth.push([c, 1 / f]); }
  }
  function applyGirth() { if (cur?.girth) for (const [b, f] of cur.girth) b.scale.set(f, 1, f); }
  function applyShape() {
    if (!cur) return;
    const s = st.heightCm / ((cur.meta.height_m || 1.7) * 100);
    cur.root.scale.setScalar(s);
    const k = clamp(st.kg / DEFAULTS[st.body].kg, 0.65, 1.7);
    const fT = clamp(Math.pow(k / (s * s), 0.62), 0.78, 1.4);       // same weight on a taller frame reads slimmer
    cur.girth = [];
    girth("spine05", fT, ["spine04"]); girth("spine03", Math.sqrt(fT), ["spine02"]);
    for (const sd of ["L", "R"]) {
      girth(`upperleg01.${sd}`, Math.pow(fT, 0.8), [`upperleg02.${sd}`]);
      girth(`upperarm01.${sd}`, Math.pow(fT, 0.6), [`upperarm02.${sd}`]);
    }
    placeShoes();
  }

  // ---------- shoes ----------
  function buildShoeList() {
    shoeList.replaceChildren();
    const items = [];
    for (const p of products) for (const cw of (p.colourways?.length ? p.colourways : [{ name: "", hex: null }])) {
      const m = manifest[p.slug]; if (!m) continue;
      if (m.colours && cw.slug && !m.colours[cw.slug] && Object.keys(m.colours).length) continue;
      items.push({ p, cw, m });
    }
    if (!items.length) {
      shoeNote.textContent = "Our shoes are being 3D scanned. They'll appear here to try on the model as each scan comes in.";
      floatChk.disabled = true; return;
    }
    shoeNote.textContent = "";
    const none = el("button", { type: "button", class: "walker-shoe", "aria-pressed": "true", title: "No shoes", text: "None" });
    none.addEventListener("click", () => selectShoe(null, none));
    shoeList.append(none);
    for (const it of items) {
      const b = el("button", { type: "button", class: "walker-shoe", "aria-pressed": "false", title: `${it.p.name}${it.cw.name ? " – " + it.cw.name : ""}` },
        [el("img", { src: it.p.images?.[0] || "", alt: "", loading: "lazy", class: "photo" })]);
      b.addEventListener("click", () => selectShoe(it, b));
      shoeList.append(b);
    }
  }
  const scanCache = new Map();
  async function loadScan(it) {
    const file = it.m.colours?.[it.cw.slug] || it.m.file;
    if (!scanCache.has(file)) scanCache.set(file, (async () => (await (await loader()).loadAsync(file)).scene)());
    return scanCache.get(file);
  }
  async function selectShoe(it, btn) {
    shoeList.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === btn)));
    if (!it) { st.shoe = null; await fadeShoes(0); clearShoes(); applyAccent(); floatChk.disabled = true; updateFloating(); return; }
    let scene0;
    try { scene0 = await loadScan(it); } catch (e) { shoeNote.textContent = "That shoe's 3D model didn't load. Please try again."; return; }
    await fadeShoes(0); clearShoes();
    st.shoe = { ...it, scene: scene0, sole: (it.m.sole_mm ?? 25) / 1000, accent: it.m.accent || it.cw.hex || null };
    attachShoes(); applyAccent(); floatChk.disabled = false; updateFloating();
    await fadeShoes(1);
  }
  function clearShoes() { for (const o of shoeObjs) o.parent?.remove(o); shoeObjs = []; if (cur) { cur.root.position.y = 0; footClip(null); } }
  // the bare foot is hidden inside the shoe: skin below the shoe's top edge isn't drawn (works while walking too,
  // because the plane follows each foot's own shoe)
  const clipPlanes = [];
  function footClip(heights) {
    for (const m of cur?.skin || []) { m.clippingPlanes = heights ? clipPlanes : null; m.clipIntersection = true; m.needsUpdate = true; }
    clipPlanes.length = 0;
    if (heights) for (const h of heights) clipPlanes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h));
  }
  function shoeMats(o, fn) { o.traverse((m) => { if (m.isMesh) for (const x of [].concat(m.material)) fn(x); }); }
  function fadeShoes(to) {
    const objs = shoeObjs.slice(); if (!objs.length) return Promise.resolve();
    return new Promise((res) => {
      const t0 = performance.now(), from = to ? 0 : 1;
      const step = () => {
        const t = clamp((performance.now() - t0) / 300, 0, 1), a = from + (to - from) * ease(t);
        objs.forEach((o) => shoeMats(o, (m) => { m.transparent = a < 1; m.opacity = a; m.depthWrite = a > 0.5; }));
        t < 1 ? requestAnimationFrame(step) : res();
      };
      step();
    });
  }
  // A scan is normalised (toe +z, heel at z = 0, sole at y = 0, length = the model's foot + 4%) and fixed to the foot
  // bone with the offset it has when the foot stands flat; the model is lifted by the sole thickness.
  function attachShoes() {
    if (!cur || !st.shoe) return;
    clearShoes();
    const foot = { L: B("foot.L"), R: B("foot.R") };
    if (!foot.L || !foot.R) return;
    for (const sd of ["L", "R"]) {
      const inner = new THREE.Group(); const sc = st.shoe.scene.clone(true);
      sc.traverse((m) => { if (m.isMesh) { m.material = [].concat(m.material).map((x) => x.clone()); if (m.material.length === 1) m.material = m.material[0]; m.castShadow = true; } });
      inner.add(sc);
      inner.rotation.y = { "+z": 0, "-z": Math.PI, "+x": -Math.PI / 2, "-x": Math.PI / 2 }[st.shoe.m.toe || "+z"] ?? 0;
      const holder = new THREE.Group(); holder.add(inner); holder.userData.side = sd;
      if ((st.shoe.m.side || "right") !== (sd === "L" ? "left" : "right")) holder.scale.x = -1;
      shoeObjs.push(holder);
    }
    placeShoes();
  }
  function placeShoes() {
    if (!cur || !shoeObjs.length) return;
    // measure the feet in the idle pose's first frame (both feet flat)
    const t0 = cur.idle ? cur.idle.time : 0, w0 = cur.walk ? cur.walk.getEffectiveWeight() : 0, i0 = cur.idle ? cur.idle.getEffectiveWeight() : 1;
    if (cur.walk) cur.walk.setEffectiveWeight(0); if (cur.idle) { cur.idle.setEffectiveWeight(1); cur.idle.time = 0; }
    cur.mixer.update(0); applyGirth();
    cur.root.position.y = 0; cur.root.updateMatrixWorld(true);
    for (const h of shoeObjs) {
      const sd = h.userData.side, fb = B(`foot.${sd}`), toe = B(`toe1-1.${sd}`) || B(`toes.${sd}`);
      const ank = fb.getWorldPosition(new THREE.Vector3()), tip = (toe || fb).getWorldPosition(new THREE.Vector3());
      const len = (tip.z - ank.z) * 1.55 + 0.02;                       // ankle -> toe joints is ~65% of the foot
      const inner = h.children[0]; inner.scale.setScalar(1); inner.position.set(0, 0, 0); inner.updateMatrixWorld(true);
      let bb = new THREE.Box3().setFromObject(inner, true);
      inner.scale.setScalar(len * 1.04 / Math.max(1e-6, bb.max.z - bb.min.z)); inner.updateMatrixWorld(true);
      bb = new THREE.Box3().setFromObject(inner, true);
      inner.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -bb.min.z);
      // desired world placement: heel 32% of the length behind the ankle, sole st.shoe.sole below the foot's sole
      const want = new THREE.Matrix4().makeTranslation(ank.x, -st.shoe.sole, ank.z - len * 0.32);
      const off = new THREE.Matrix4().copy(fb.matrixWorld).invert().multiply(want);
      h.matrixAutoUpdate = false; h.userData.off = off; fb.add(h);
      h.matrix.copy(off).multiply(new THREE.Matrix4().makeScale(h.scale.x, 1, 1));
    }
    if (cur.idle) { cur.idle.time = t0; cur.idle.setEffectiveWeight(i0); } if (cur.walk) cur.walk.setEffectiveWeight(w0);
    cur.root.position.y = st.shoe ? st.shoe.sole : 0;
    if (st.shoe) {                                                   // collar height of the scan, in world units
      cur.root.updateMatrixWorld(true);
      const tops = shoeObjs.map((h) => new THREE.Box3().setFromObject(h).max.y);
      footClip([Math.max(Math.min(...tops) - 0.012, st.shoe.sole + 0.06 * cur.root.scale.y)]);   // closed shoes: the whole foot is inside
    }
    updateFloating();
  }
  function applyAccent() {
    if (!cur) return;
    for (const m of cur.accent) m.color.set(st.shoe?.accent || FLEECE);
    for (const u of cur.stripe) u.uAccent.value.set(st.shoe?.accent || FLEECE);
  }
  function updateFloating() {
    if (floatObj) { scene.remove(floatObj); floatObj = null; }
    if (!st.floating || !st.shoe) return;
    floatObj = new THREE.Group(); const s = st.shoe.scene.clone(true);
    s.traverse((m) => { if (m.isMesh) m.castShadow = false; });
    floatObj.add(s); const bb = new THREE.Box3().setFromObject(s); const L = Math.max(...bb.getSize(new THREE.Vector3()).toArray());
    s.scale.setScalar(1.6 / L); const bb2 = new THREE.Box3().setFromObject(s); s.position.sub(bb2.getCenter(new THREE.Vector3()));
    floatObj.position.set(-0.2, 1.25, -1.9); scene.add(floatObj);
  }

  // ---------- camera ----------
  function views() {
    const s = cur ? cur.root.scale.y : 1, H = (cur?.meta.height_m || 1.7) * s;
    const d = (H * 1.16) / (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.min(1, camera.aspect * 1.25);
    const at = (az) => ({ target: [0, H * 0.53, 0], pos: [Math.sin(az) * d, H * 0.56, Math.cos(az) * d] });
    return {
      // same framing for every model: whole figure, a little headroom; distance from the lens, not guesswork
      full: at(0.7), front: at(0), side: at(Math.PI / 2), back: at(Math.PI),
      shoes: { target: [0, 0.16 * s, 0.02], pos: [1.15 * s, 0.42 * s, 1.0 * s] }
    };
  }
  function frameView(name, instant) {
    if (!camera) return;
    const v = views()[name];
    const to = { t: new THREE.Vector3(...v.target), p: new THREE.Vector3(...v.pos) };
    if (instant) { controls.target.copy(to.t); camera.position.copy(to.p); controls.update(); return; }
    camAnim = { t0: performance.now(), from: { t: controls.target.clone(), p: camera.position.clone() }, to };
  }
  bReset.addEventListener("click", () => {
    if (!cur) return;
    st.heightCm = Math.round((cur.meta.height_m || 1.7) * 100); st.kg = DEFAULTS[st.body].kg;
    hRange.set(st.heightCm); wRange.set(st.kg); applyShape();
    if (st.walk) { st.walk = false; ui.querySelectorAll('[data-v="stand"],[data-v="walk"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === "stand"))); applyMotion(); }
    frameView("full");
  });

  function tick() {
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (cur) {
      cur.mixer.update(dt); applyGirth();
      if (cur.walk) floorTex.offset.y -= (cur.meta.walk?.speed || 0.8) * cur.root.scale.y * cur.walk.getEffectiveWeight() * dt;
    }
    if (floatObj) floatObj.rotation.y += dt * 0.35;
    if (camAnim) {
      const t = clamp((performance.now() - camAnim.t0) / 800, 0, 1), e = ease(t);
      controls.target.lerpVectors(camAnim.from.t, camAnim.to.t, e); camera.position.lerpVectors(camAnim.from.p, camAnim.to.p, e);
      if (t >= 1) camAnim = null;
    }
    controls.update();
    renderer.render(scene, camera);
  }

  // lazy: nothing loads until the walker scrolls into view; it stops drawing when off screen
  let onScreen = false;
  const vis = () => { const was = visible; visible = onScreen && !document.hidden; if (visible && !was) clock?.getDelta(); };
  new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); if (onScreen) start(); vis(); }, { rootMargin: "200px" }).observe(canvasBox);
  document.addEventListener("visibilitychange", vis);

  return { get state() { return { ...st }; } };
}
