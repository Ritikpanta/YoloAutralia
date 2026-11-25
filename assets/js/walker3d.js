/* YOLO try-on: a realistic model in a fashion studio, wearing the casual (hoodie + joggers) or formal (shirt +
   trousers) outfit and a pair of shoes.

   Models: /assets/models/walker/walker-{m,f}.glb, rebuilt by tools/tryon (MakeHuman CC0 body + MPFB rig, garments
   modelled as separate geometry around the standing body, skinned, with the body's morph targets transferred so
   clothes follow height and weight). Clips: "Idle" (weight-shifted stance + breathing) and "Walk" (heel-to-toe,
   foot-locked to a floor that moves at the walk speed). walker.json: per body, base height, the joint offsets each
   morph target needs, foot contact points and walk speed.

   Shoes: /assets/models/shoes/manifest.json. "products" maps a catalogue slug (and optionally colourway slugs) to a
   real 3D model of that product. It is empty until scans exist, and the picker says so honestly. "studio" holds the
   plain placeholder shoes the model wears in the meantime; the UI labels them as not-for-sale studio samples.
   The shoe is skinned to the foot and toe bones so it flexes at the ball during toe-off, sized by the EU size chosen
   (independent of the body), and the body is lifted by the shoe's sole so it stands on the ground. */

const V = "0.170.0";
const THREE_URL = `https://cdn.jsdelivr.net/npm/three@${V}/build/three.module.js`;
const ADDONS = `https://cdn.jsdelivr.net/npm/three@${V}/examples/jsm/`;
const BASE = "/assets/models/walker/";
const SHOES = "/assets/models/shoes/manifest.json";
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const isMobile = () => matchMedia("(max-width: 900px), (pointer: coarse)").matches;

const DEFAULTS = { f: { kg: 58, eu: 39 }, m: { kg: 72, eu: 42 } };
const COLOURS = {
  fleece: "#28282b", rib: "#232326", cord: "#2a2a2d", shirt: "#f3f2ee", button: "#e9e6df",
  trouser: "#aa9f8c", belt: "#2c1e15", sock: "#18181a"
};
const bn = (n) => n.replace(/[.\[\]:\/]/g, "");     // three.js strips these from node names
const outerMm = (eu) => (eu / 1.5) * 10 + 12;          // shoe outside length for an EU size (inside + 12 mm)

function el(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of [].concat(kids)) if (k) e.append(k);
  return e;
}
function seg(label, options, value, onChange) {
  const box = el("div", { class: "walker-seg", role: "group", "aria-label": label });
  const btns = options.map(([v, t]) => {
    const b = el("button", { type: "button", "aria-pressed": String(v === value), "data-v": v, text: t });
    b.addEventListener("click", () => { btns.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); onChange(v); });
    return b;
  });
  box.append(...btns);
  const row = el("div", { class: "walker-row" }, [el("span", { class: "walker-label", text: label }), box]);
  row.set = (v) => btns.forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === v)));
  return row;
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
  // ------------------------------------------------------------------ UI
  const canvasBox = el("div", { class: "walker-stage" });
  const status = el("p", { class: "walker-status", text: "Loading the 3D model…" });
  const camBtns = el("div", { class: "walker-cam" });
  const viewBtn = (v, t) => { const b = el("button", { type: "button", class: "chip", text: t }); b.addEventListener("click", () => frameView(v)); return b; };
  const bSpin = el("button", { type: "button", class: "chip", text: "360°" });
  const bReset = el("button", { type: "button", class: "chip", text: "Reset" });
  camBtns.append(viewBtn("front", "Front"), viewBtn("side", "Side"), viewBtn("back", "Back"), viewBtn("shoes", "Shoes close-up"), bSpin, bReset);
  const shoeTag = el("p", { class: "walker-shoetag", hidden: true });
  canvasBox.append(status, shoeTag, camBtns);

  const st = { body: "m", outfit: "casual", walk: false, heightCm: null, kg: null, eu: null, shoeKey: "studio", product: null };
  const bodySeg = seg("Model", [["f", "Women"], ["m", "Men"]], st.body, (v) => { st.body = v; st.heightCm = null; st.kg = null; st.eu = null; showBody(); });
  const outfitSeg = seg("Outfit", [["casual", "Casual"], ["formal", "Formal"]], st.outfit, (v) => { st.outfit = v; applyOutfit(); refreshShoe(); });
  const motionSeg = seg("Motion", [["stand", "Stand"], ["walk", "Walk"]], "stand", (v) => { st.walk = v === "walk"; applyMotion(); });
  const hRange = range("Height", 150, 200, 1, 178, (v) => `${v} cm`, (v) => { st.heightCm = v; applyShape(); });
  const wRange = range("Weight", 40, 120, 1, 72, (v) => `${v} kg`, (v) => { st.kg = v; applyShape(); });
  const sizeSel = el("select", { class: "walker-size", "aria-label": "Shoe size (EU)" });
  for (let s = 36; s <= 46; s++) sizeSel.append(el("option", { value: s, text: `EU ${s}` }));
  sizeSel.addEventListener("change", () => { st.eu = +sizeSel.value; placeShoes(); });
  const shoeList = el("div", { class: "walker-shoes", role: "list" });
  const shoeNote = el("div", { class: "walker-shoenote" });
  const ui = el("div", { class: "walker-ui" }, [
    bodySeg, outfitSeg, motionSeg, hRange, wRange,
    el("div", { class: "walker-row" }, [el("label", { class: "walker-label", text: "Shoe size" }), sizeSel,
      el("p", { class: "fineprint", text: "Set separately from height and weight, the way you'd choose it in store." })]),
    el("div", { class: "walker-row walker-row-col" }, [el("span", { class: "walker-label", text: "Shoes" }), shoeList, shoeNote])
  ]);
  root.append(el("div", { class: "walker" }, [canvasBox, ui]));

  // ------------------------------------------------------------------ three
  let THREE, renderer, scene, camera, controls, clock, composer, floor, floorTex, contact, loaderP;
  let meta = {}, manifest = { products: {}, studio: {} };
  const bodies = {};
  let cur = null, camAnim = null, spin = null, started = false, visible = false;
  let shoe = null;            // { key, objs: [SkinnedMesh], sole, lenScale }
  const mobile = isMobile();

  async function start() {
    if (started) return; started = true;
    try {
      const mods = await Promise.all([
        import(THREE_URL), import(ADDONS + "controls/OrbitControls.js"), import(ADDONS + "environments/RoomEnvironment.js"),
        import(ADDONS + "postprocessing/EffectComposer.js"), import(ADDONS + "postprocessing/RenderPass.js"),
        import(ADDONS + "postprocessing/OutputPass.js")
      ]);
      THREE = mods[0];
      const [, { OrbitControls }, { RoomEnvironment }, { EffectComposer }, { RenderPass }, { OutputPass }] = mods;
      renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      canvasBox.prepend(renderer.domElement);
      scene = new THREE.Scene();
      // seamless studio: a soft vertical gradient behind, a matte floor that fades into it
      scene.background = gradientTexture();
      const pm = new THREE.PMREMGenerator(renderer);
      scene.environment = pm.fromScene(new RoomEnvironment(), 0.03).texture;
      scene.environmentIntensity = 0.8;
      const key = new THREE.DirectionalLight("#fff6ec", 2.8);              // large softbox, front-left, high
      key.position.set(1.6, 4.2, 3.2); key.castShadow = true;
      key.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048); key.shadow.radius = 8; key.shadow.bias = -0.0003; key.shadow.normalBias = 0.02;
      Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: 2.2, bottom: -0.3, near: 1, far: 9 });
      scene.add(key, key.target);
      const fill = new THREE.DirectionalLight("#eef2ff", 0.55); fill.position.set(-3, 2.0, 2.0); scene.add(fill);
      const rim = new THREE.DirectionalLight("#ffffff", 1.6); rim.position.set(-1.5, 3.2, -3.5); scene.add(rim);
      scene.add(new THREE.HemisphereLight("#ffffff", "#d6d3cf", 0.35));
      // floor: very subtle concrete, fades out at the edges, moves when walking
      floorTex = concreteTexture(); floorTex.repeat.set(10, 10);
      floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92, alphaMap: fadeTexture(), transparent: true, depthWrite: false }));
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.renderOrder = -2; scene.add(floor);
      const shadowCatch = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.12, depthWrite: false }));
      shadowCatch.rotation.x = -Math.PI / 2; shadowCatch.position.y = 0.0005; shadowCatch.receiveShadow = true; shadowCatch.renderOrder = -1; scene.add(shadowCatch);
      contact = contactShadows();

      camera = new THREE.PerspectiveCamera(28, 1, 0.05, 40);
      controls = new OrbitControls(camera, renderer.domElement);
      Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 0.45, maxDistance: 7, maxPolarAngle: Math.PI * 0.497, zoomSpeed: 0.8, zoomToCursor: true, rotateSpeed: 0.8 });
      controls.addEventListener("start", () => { camAnim = null; spin = null; });
      // post: MSAA render target, ground-truth AO (desktop), tone mapping + sRGB output
      const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
      composer = new EffectComposer(renderer, rt);
      composer.addPass(new RenderPass(scene, camera));
      composer.addPass(new OutputPass());
      clock = new THREE.Clock();
      new ResizeObserver(resize).observe(canvasBox); resize();
      shopLink(renderer.domElement);
      [meta, manifest] = await Promise.all([
        fetch(BASE + "walker.json").then((r) => r.json()).catch(() => ({})),
        fetch(SHOES, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
      ]);
      manifest.products ||= {}; manifest.studio ||= {};
      buildShoeList();
      await showBody();
      frameView("full", true);
      renderer.setAnimationLoop(tick);
      if (new URLSearchParams(location.search).has("qa")) window.__walkerTest = qa;
    } catch (e) {
      console.warn("Walker failed to start", e);
      status.textContent = "The 3D model couldn't load on this device."; status.hidden = false;
    }
  }

  function resize() {
    if (!renderer) return;
    const w = canvasBox.clientWidth, h = canvasBox.clientHeight;
    renderer.setSize(w, h, false); composer.setSize(w, h);
    camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- studio textures
  function canvasTex(w, h, draw, srgb = true) {
    const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h);
    const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function gradientTexture() {
    return canvasTex(8, 256, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, "#f2f1ef"); grd.addColorStop(0.62, "#e7e6e3"); grd.addColorStop(1, "#dcdad6");
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    });
  }
  function concreteTexture() {
    const t = canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = "#dedcd8"; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) { const a = Math.random() * 0.035; g.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`; g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2); }
      for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.02})`; g.beginPath(); g.arc(Math.random() * w, Math.random() * h, 8 + Math.random() * 40, 0, 7); g.fill(); }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t;
  }
  function fadeTexture() {
    return canvasTex(256, 256, (g, w, h) => {
      const grd = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
      grd.addColorStop(0, "#fff"); grd.addColorStop(0.35, "#fff"); grd.addColorStop(1, "#000");
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }, false);
  }
  function ribNormal() {
    const t = canvasTex(64, 8, (g, w, h) => {
      const img = g.createImageData(w, h);
      for (let x = 0; x < w; x++) {
        const s = Math.sin((x / w) * Math.PI * 2 * 8);             // 8 ribs across
        const nx = -Math.cos((x / w) * Math.PI * 2 * 8) * 0.55 * Math.sign(s || 1) * Math.abs(s) ** 0.3;
        for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; img.data[i] = 128 + nx * 127; img.data[i + 1] = 128; img.data[i + 2] = 255; img.data[i + 3] = 255; }
      }
      g.putImageData(img, 0, 0);
    }, false);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  function grainNormal() {         // fine leather grain for the studio shoes
    const t = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = "rgb(128,128,255)"; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 5000; i++) {
        const x = Math.random() * w, y = Math.random() * h, r = 0.6 + Math.random() * 1.8;
        g.fillStyle = `rgba(${100 + Math.random() * 56},${100 + Math.random() * 56},255,0.5)`; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      }
    }, false);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }

  // Contact shadows: a tight, dark core under each sole that softens and fades as the foot lifts, plus a broad pool
  // of occlusion under the figure. They follow the feet every frame, so they stay right while walking.
  function contactShadows() {
    const blob = (inner, outer, a) => canvasTex(128, 128, (g) => {
      const grd = g.createRadialGradient(64, 64, inner, 64, 64, outer);
      grd.addColorStop(0, `rgba(0,0,0,${a})`); grd.addColorStop(0.5, `rgba(0,0,0,${a * 0.45})`); grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    }, false);
    const mk = (t, w, h, o) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, opacity: o, toneMapped: false }));
      m.renderOrder = 0; scene.add(m); return m;
    };
    const pool = mk(blob(6, 62, 0.5), 1.0, 0.75, 0.55);
    pool.position.y = 0.0012;
    const feetT = blob(10, 60, 0.95);
    const feet = [mk(feetT, 0.16, 0.36, 0.85), mk(feetT, 0.16, 0.36, 0.85)];
    const v = new THREE.Vector3(), v2 = new THREE.Vector3();
    return {
      update() {
        if (!cur) return;
        ["L", "R"].forEach((sd, i) => {
          const f = cur.bones[bn(`foot.${sd}`)], toe = cur.bones[bn(`toe1-1.${sd}`)]; if (!f || !toe) return;
          f.getWorldPosition(v); toe.getWorldPosition(v2);
          const lift = Math.max(0, Math.min(v.y, v2.y) - 0.09 * cur.root.scale.y - cur.root.position.y * 0.3);
          const m = feet[i], cx = (v.x + v2.x) / 2, cz = (v.z + v2.z) / 2 + (v2.z - v.z) * 0.15;
          m.position.set(cx, 0.0015 + i * 0.0002, cz);
          m.rotation.y = Math.atan2(v2.x - v.x, v2.z - v.z);
          const k = clamp(1 - lift / 0.12, 0, 1);
          m.material.opacity = 0.85 * k * k; m.scale.setScalar(1 + lift * 3);
        });
        const r = cur.bones.root; if (r) { r.getWorldPosition(v); pool.position.x = v.x; pool.position.z = v.z + 0.03; }
      }
    };
  }

  // ---------------------------------------------------------------- loading
  async function loader() {
    loaderP ||= (async () => {
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import(ADDONS + "loaders/GLTFLoader.js"), import(ADDONS + "libs/meshopt_decoder.module.js")]);
      const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder); return l;
    })();
    return loaderP;
  }
  const texCache = new Map();
  const tex = (file, srgb = false) => {
    if (!texCache.has(file)) { const t = new THREE.TextureLoader().load(BASE + file); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; texCache.set(file, t); }
    return texCache.get(file);
  };
  let RIB = null;
  // garments' UVs are in metres, so a texture's repeat is simply 1 / (metres it covers)
  function fabric(m, { color, file, tile, nscale, rough, sheen = 0, sheenRough = 0.8, sheenColor = "#3a3a3c" }) {
    const p = new THREE.MeshPhysicalMaterial({ name: m.name, color, roughness: rough, metalness: 0, side: THREE.DoubleSide });
    if (file) { const t = (file === "rib" ? (RIB ||= ribNormal()) : tex(file)).clone(); t.needsUpdate = true; t.repeat.set(1 / tile, 1 / tile); p.normalMap = t; p.normalScale.set(nscale, nscale); }
    if (sheen) { p.sheen = sheen; p.sheenRoughness = sheenRough; p.sheenColor.set(sheenColor); }
    p.specularIntensity = 0.35;
    return p;
  }
  function dress(o) {
    const m = o.material, n = m.name || "";
    if (/^YOLO_Skin/.test(n)) {
      const p = new THREE.MeshPhysicalMaterial({ name: n, map: m.map, roughness: 0.5, specularIntensity: 0.42, sheen: 0.35, sheenRoughness: 0.55, sheenColor: new THREE.Color("#c98c76") });
      skinWrap(p); return p;
    }
    if (/^YOLO_Eyes/.test(n)) { m.roughness = 0.06; m.alphaTest = 0.5; m.transparent = false; return m; }
    if (/^YOLO_(Hair|Brows|Lashes)/.test(n)) {
      m.alphaTest = /Hair/.test(n) ? 0.42 : 0.3; m.transparent = false; m.depthWrite = true; m.side = THREE.DoubleSide; m.roughness = 0.55;
      if (!mobile) m.alphaToCoverage = true;
      return m;
    }
    if (n === "YOLO_Hoodie" || n === "YOLO_Fleece") return fabric(m, { color: COLOURS.fleece, file: "fleece-normal.webp", tile: 0.06, nscale: 0.8, rough: 0.9, sheen: 0.9, sheenRough: 0.7, sheenColor: "#6b6b72" });
    if (n === "YOLO_Rib") return fabric(m, { color: COLOURS.rib, file: "rib", tile: 0.022, nscale: 1.0, rough: 0.88, sheen: 0.8, sheenRough: 0.6, sheenColor: "#5f5f66" });
    if (n === "YOLO_Cord") return fabric(m, { color: COLOURS.cord, rough: 0.8, sheen: 0.4 });
    if (n === "YOLO_Shirt") return fabric(m, { color: COLOURS.shirt, file: "weave-normal.webp", tile: 0.018, nscale: 0.35, rough: 0.78, sheen: 0.35, sheenColor: "#ffffff" });
    if (n === "YOLO_Button") return new THREE.MeshPhysicalMaterial({ color: COLOURS.button, roughness: 0.3, clearcoat: 0.5 });
    if (n === "YOLO_Trouser") return fabric(m, { color: COLOURS.trouser, file: "twill-normal.webp", tile: 0.03, nscale: 0.45, rough: 0.86, sheen: 0.2, sheenColor: "#d8cfbd" });
    if (n === "YOLO_Belt") return new THREE.MeshPhysicalMaterial({ color: COLOURS.belt, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.3 });
    if (n === "YOLO_Sock") return fabric(m, { color: COLOURS.sock, file: "jersey-normal.webp", tile: 0.03, nscale: 0.5, rough: 0.95, sheen: 0.4 });
    if (n === "YOLO_Print") { m.transparent = true; m.alphaTest = 0.25; m.depthWrite = false; m.roughness = 0.75; m.polygonOffset = true; m.polygonOffsetFactor = -2; return m; }
    return m;
  }
  // baked ambient occlusion (vertex colour from Blender), applied like an AO map: it attenuates ambient + environment
  // light fully and direct light a little, so creases, armpits and cuff stacks read without dirtying the albedo
  function addAO(mat, k) {
    mat.vertexColors = true;
    const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey?.bind(mat);
    mat.onBeforeCompile = (sh, r) => {
      prev?.call(mat, sh, r);
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <color_fragment>", `float vAO = mix(1.0, vColor.r, ${k.toFixed(2)}); diffuseColor.rgb *= mix(1.0, vAO, 0.45);`)
        .replace("#include <aomap_fragment>", "#include <aomap_fragment>\n reflectedLight.indirectDiffuse *= vAO; reflectedLight.indirectSpecular *= vAO; reflectedLight.directDiffuse *= mix(1.0, vAO, 0.35);");
    };
    mat.customProgramCacheKey = () => (prevKey ? prevKey() : "") + "-ao" + k;
    mat.needsUpdate = true;
  }
  // a little light wraps round the terminator in warm red: cheap stand-in for skin's subsurface scattering
  function skinWrap(p) {
    p.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace("#include <lights_fragment_end>",
        "#include <lights_fragment_end>\n reflectedLight.indirectDiffuse += vec3(0.10, 0.035, 0.02) * diffuseColor.rgb * (1.0 - saturate(dot(normal, normalize(vViewPosition))));");
    };
    p.customProgramCacheKey = () => "yolo-skin";
  }

  async function loadBody(b) {
    if (bodies[b]) return bodies[b];
    const gltf = await (await loader()).loadAsync(BASE + `walker-${b}.glb`);
    const group = new THREE.Group(); group.add(gltf.scene);
    const rec = { root: group, scene: gltf.scene, meshes: [], parts: [], hoodie: [], bones: {}, rest: {}, meta: meta[b.toUpperCase()] || {} };
    gltf.scene.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        o.material = dress(o);
        if (o.geometry.attributes.color) {
          const n = o.material.name || "";
          addAO(o.material, /Skin/.test(n) ? 0.55 : /Hair/.test(n) ? 0.6 : 0.9);
        }
        if (/^(Hoodie|HoodieRib|Drawcords|ChestPrint)/.test(o.name)) rec.hoodie.push(o);
        if (o.isSkinnedMesh) rec.meshes.push(o);
        if (/Print/.test(o.material.name)) o.castShadow = false;
      }
      if (o.userData?.yolo_outfit) rec.parts.push(o);
      if (o.isBone) { rec.bones[o.name] = o; rec.rest[o.name] = { p: o.position.clone(), q: o.quaternion.clone() }; }
    });
    rec.skel = rec.meshes[0].skeleton;
    // Rest frames. The GLB is meshopt-quantised: each mesh's inverse bind matrices carry its dequantisation, so a
    // re-bind must be relative to them (B' = W'^-1 W0 B0), never recomputed from scratch.
    gltf.scene.updateMatrixWorld(true);
    rec.W0 = new Map(); rec.armRot = {};
    for (const b of Object.values(rec.bones)) {
      rec.W0.set(b, b.matrixWorld.clone());
      const q = new THREE.Quaternion(); b.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3()); rec.armRot[b.name] = q;
    }
    rec.B0 = new Map(rec.meshes.map((m) => [m, m.skeleton.boneInverses.map((x) => x.clone())]));
    // clips: rotations only (+ the root's translation), so bones can be lengthened by the body morphs
    rec.mixer = new THREE.AnimationMixer(gltf.scene);
    const clean = (c) => { c.tracks = c.tracks.filter((t) => t.name.endsWith(".quaternion") || t.name === "root.position"); return c; };
    const clip = (re) => gltf.animations.find((a) => re.test(a.name));
    rec.idle = rec.mixer.clipAction(clean(clip(/idle/i)));
    rec.walk = rec.mixer.clipAction(clean(clip(/walk/i)));
    rec.idle.play(); rec.walk.play(); rec.walk.setEffectiveWeight(0);
    // joint names in walker.json are Blender's ("foot.L"); three.js names the bones "footL"
    const mj = {};
    for (const [k, d] of Object.entries(rec.meta.morph_joints || {})) { mj[k] = {}; for (const [n, v] of Object.entries(d)) mj[k][bn(n)] = v; }
    rec.meta = { ...rec.meta, morph_joints: mj };
    bodies[b] = rec; return rec;
  }

  async function showBody() {
    status.textContent = "Loading the 3D model…"; status.hidden = false;
    const rec = await loadBody(st.body);
    if (cur && cur !== rec) scene.remove(cur.root);
    cur = rec; scene.add(rec.root);
    st.heightCm ??= Math.round((rec.meta.height_m || 1.7) * 100); st.kg ??= DEFAULTS[st.body].kg;
    st.eu ??= DEFAULTS[st.body].eu;
    hRange.set(st.heightCm); wRange.set(st.kg); sizeSel.value = st.eu;
    applyOutfit(); applyMotion(true); applyShape(); await refreshShoe();
    status.hidden = true;
  }

  function applyOutfit() {
    if (!cur) return;
    for (const p of cur.parts) { const o = p.userData.yolo_outfit; p.visible = o === "both" || o === st.outfit; }
  }
  function applyMotion(instant) {
    if (!cur) return;
    const [to, from] = st.walk ? [cur.walk, cur.idle] : [cur.idle, cur.walk];
    if (instant) { to.setEffectiveWeight(1); from.setEffectiveWeight(0); return; }
    to.enabled = true; to.setEffectiveWeight(1); if (st.walk) to.time = 0; from.crossFadeTo(to, 0.6, false);
  }

  // ---------------------------------------------------------------- body shape
  // Height and weight drive MakeHuman's own morph targets (proportions change: legs lengthen more than the torso,
  // weight goes to the waist, hips, thighs and upper arms, not a stretched mesh). The skeleton follows: every joint
  // moves by the offset the morph gives it, and the skin is re-bound, so knees and elbows still bend in the right place.
  function morphWeights() {
    const M = cur.meta, H = st.heightCm / 100, h0 = M.height_m, hs = M.heights;
    const w = { height_lo: 0, height_hi: 0, weight_lo: 0, weight_hi: 0, muscle_hi: 0 };
    let scale = 1;
    if (H >= h0) { const k = (H - h0) / (hs.height_hi - h0); w.height_hi = clamp(k, 0, 0.45); scale = H / (h0 + w.height_hi * (hs.height_hi - h0)); }
    else { const k = (h0 - H) / (h0 - hs.height_lo); w.height_lo = clamp(k, 0, 0.7); scale = H / (h0 - w.height_lo * (h0 - hs.height_lo)); }
    const bmi = st.kg / (H * H), ref = st.body === "f" ? 21 : 22.5;
    if (bmi >= ref) w.weight_hi = clamp((bmi - ref) / 11, 0, 1.25); else w.weight_lo = clamp((ref - bmi) / 5, 0, 1);
    return { w, scale };
  }
  function applyShape() {
    if (!cur) return;
    const { w, scale } = morphWeights();
    cur.morph = w; cur.scale = scale;
    for (const m of cur.meshes) {
      const d = m.morphTargetDictionary; if (!d) continue;
      for (const [k, v] of Object.entries(w)) if (k in d) m.morphTargetInfluences[d[k]] = v;
    }
    // joints
    const J = cur.meta.morph_joints || {}, delta = {};
    for (const name of Object.keys(cur.bones)) {
      const dv = new THREE.Vector3();
      for (const [k, v] of Object.entries(w)) if (v && J[k]?.[name]) dv.addScaledVector(new THREE.Vector3(...J[k][name]), v);
      delta[name] = dv;
    }
    cur.rootDelta = new THREE.Vector3();
    for (const [name, b] of Object.entries(cur.bones)) {
      const r = cur.rest[name], p = b.parent?.isBone ? b.parent.name : null;
      const d = delta[name].clone(); if (p) d.sub(delta[p]);
      const local = p ? d.applyQuaternion(cur.armRot[p].clone().invert()) : d;
      b.position.copy(r.p).add(local);
      b.userData.restPos = b.position.clone();
      if (!p) cur.rootDelta.copy(local);
    }
    rebind();
    cur.root.scale.setScalar(scale);
    const legBase = cur.meta.leg_m || 0.85;
    cur.legScale = (legBase + (delta[bn("upperleg01.L")].y - delta[bn("foot.L")].y)) / legBase * scale;
    placeShoes();
  }
  // re-bind the skin to the reshaped skeleton (in the rest pose, with the outer group at identity)
  function rebind() {
    const s = cur.root.scale.x, y = cur.root.position.y;
    cur.root.scale.setScalar(1); cur.root.position.y = 0;
    for (const [n, b] of Object.entries(cur.bones)) { b.quaternion.copy(cur.rest[n].q); b.position.copy(b.userData.restPos || cur.rest[n].p); }
    cur.root.updateMatrixWorld(true);
    const corr = new Map();
    for (const b of Object.values(cur.bones)) corr.set(b, b.matrixWorld.clone().invert().multiply(cur.W0.get(b)));
    for (const m of cur.meshes) {
      const B0 = cur.B0.get(m);
      m.skeleton.bones.forEach((b, i) => m.skeleton.boneInverses[i].copy(corr.get(b)).multiply(B0[i]));
    }
    // the shoes are not quantised: plain inverse rest matrices
    cur.shoeInv = cur.skel.bones.map((b) => b.matrixWorld.clone().invert());
    cur.root.scale.setScalar(s); cur.root.position.y = y;
    cur.mixer.update(0);
  }

  // ---------------------------------------------------------------- shoes
  function buildShoeList() {
    shoeList.replaceChildren();
    const studioBtn = el("button", { type: "button", class: "walker-shoe walker-shoe-studio", "aria-pressed": "true", title: "Studio sample (not for sale)" },
      [el("span", { text: "Studio sample" })]);
    studioBtn.addEventListener("click", () => selectShoe({ key: "studio" }, studioBtn));
    shoeList.append(studioBtn);
    let have = 0;
    for (const p of products) {
      const has = manifest.products[p.slug];
      if (has) have++;
      const img = p.cutout || p.images?.[0] || "";
      const b = el("button", { type: "button", class: "walker-shoe" + (has ? "" : " is-pending"), "aria-pressed": "false",
        title: has ? p.name : `${p.name}: 3D model not available yet` },
        [el("img", { src: img, alt: "", loading: "lazy", class: "photo" }), has ? null : el("span", { class: "walker-shoe-badge", text: "Photo only" })]);
      b.addEventListener("click", () => selectShoe({ key: "product", p }, b));
      shoeList.append(b);
    }
    noteStudio(have);
  }
  function noteStudio(have) {
    shoeNote.replaceChildren(
      el("p", { class: "fineprint", text: have ? "" : "None of our shoes has a 3D model yet, so the model wears a plain studio sample that isn't for sale. Each style will appear here once it's been 3D scanned." })
    );
  }
  async function selectShoe(sel, btn) {
    shoeList.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === btn)));
    if (sel.key === "product") {
      const m = manifest.products[sel.p.slug];
      if (!m) {
        // be straight about it: no model, so don't pretend; keep the studio sample on and link to the real product
        st.product = null; st.shoeKey = "studio";
        shoeNote.replaceChildren(
          el("p", { class: "walker-pending" }, [el("b", { text: sel.p.name }), " doesn't have a 3D model yet, so it can't be shown on the model accurately. It's still wearing the plain studio sample."]),
          el("a", { class: "btn walker-pending-link", href: `/product?m=${encodeURIComponent(sel.p.slug)}`, text: `See ${sel.p.name} photos` }));
        shoeList.querySelector(".walker-shoe-studio")?.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-pressed", "false");
        return;
      }
      st.product = sel.p; st.shoeKey = "product";
    } else { st.product = null; st.shoeKey = "studio"; noteStudio(0); }
    await refreshShoe();
  }
  function currentShoeSpec() {
    if (st.shoeKey === "product" && st.product) {
      const m = manifest.products[st.product.slug];
      const cw = st.product.colourways?.[0]?.slug;
      return { id: st.product.slug, label: st.product.name, file: m.colours?.[cw] || m.file, ...m, studio: false };
    }
    const k = st.outfit === "formal" ? "derby" : "sneaker";
    const m = manifest.studio[k]; return m ? { id: "studio-" + k, ...m, studio: true } : null;
  }
  const shoeCache = new Map();
  async function refreshShoe() {
    if (!cur) return;
    const spec = currentShoeSpec();
    if (!spec) { clearShoes(); return; }
    if (shoe && shoe.id === spec.id && shoe.body === cur) { placeShoes(); return; }
    if (!shoeCache.has(spec.file)) shoeCache.set(spec.file, (await loader()).loadAsync(spec.file).then((g) => g.scene));
    let src;
    try { src = await shoeCache.get(spec.file); } catch (e) { shoeNote.replaceChildren(el("p", { class: "fineprint", text: "That shoe's 3D model didn't load. Please try again." })); return; }
    clearShoes();
    shoe = { id: spec.id, spec, src, body: cur, objs: [] };
    buildShoeMeshes();
    placeShoes();
    shoeTag.hidden = false;
    shoeTag.textContent = spec.studio ? `${spec.label} · studio sample, not a YOLO product` : `${spec.label}`;
  }
  function clearShoes() {
    for (const o of shoe?.objs || []) o.parent?.remove(o);
    shoe = null; shoeTag.hidden = true;
    if (cur) cur.root.position.y = 0;
    setFootHide(null);
  }
  // one shoe per foot, made into SkinnedMeshes on the body's own skeleton: weighted to the foot bone and, past the
  // ball, to the big-toe bone, so the forefoot stays flat on the floor while the heel lifts (real shoes flex there)
  function buildShoeMeshes() {
    const leatherN = grainNormal();
    for (const sd of ["L", "R"]) {
      const holder = new THREE.Group(); holder.userData.side = sd;
      shoe.src.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry.clone(); o.updateWorldMatrix(true, false); g.applyMatrix4(o.matrixWorld);
        const mats = [].concat(o.material).map((m0) => {
          const m = m0.clone();
          if (shoe.spec.studio && /Upper|Collar/.test(m.name)) { m.normalMap = leatherN; m.normalScale.set(0.25, 0.25); leatherN.repeat.set(60, 60); }
          return m;
        });
        const mesh = new THREE.SkinnedMesh(g, mats.length === 1 ? mats[0] : mats);
        mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.userData.srcGeo = g;
        holder.add(mesh);
      });
      shoe.objs.push(holder);
    }
  }
  function footFrame(sd) {
    // rest-pose foot data (glTF coords, unmorphed) + morph deltas of the foot joints
    const F = cur.meta.foot[sd];
    const v = (a) => new THREE.Vector3(...a);
    return { heel: v(F.heel), ball: v(F.ball), tip: v(F.tip), ankle: v(F.ankle) };
  }
  function placeShoes() {
    if (!cur || !shoe) return;
    const spec = shoe.spec;
    const lenScale = outerMm(st.eu) / outerMm(spec.size_eu || 42);
    const k = cur.scale || 1;                       // cancel the body's uniform scale: shoe size is its own choice
    const sk = cur.skel, idx = (n) => sk.bones.findIndex((b) => b.name === n);
    let soleH = 0;
    for (const holder of shoe.objs) {
      const sd = holder.userData.side;
      const F = footFrame(sd);
      const footIdx = idx(bn(`foot.${sd}`)), toeIdx = idx(bn(`toe1-1.${sd}`));
      // foot joints after the body morph (rest space)
      const J = cur.meta.morph_joints, w = cur.morph || {};
      const dFoot = new THREE.Vector3();
      for (const [key, val] of Object.entries(w)) if (val && J[key]?.[bn(`foot.${sd}`)]) dFoot.addScaledVector(new THREE.Vector3(...J[key][bn(`foot.${sd}`)]), val);
      const heel = F.heel.clone().add(dFoot), tip = F.tip.clone().add(dFoot), ball = F.ball.clone().add(dFoot);
      const dir = tip.clone().sub(heel).setY(0).normalize();
      const yaw = Math.atan2(dir.x, dir.z);
      // shoe frame -> rest space: heel of the shoe 8 mm behind the foot's heel, centred under the foot axis
      const mirror = (spec.side || "right") === (sd === "L" ? "left" : "right") ? 1 : -1;
      const sc = lenScale / k;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(heel.x, 0, heel.z).addScaledVector(dir, -0.008 / k),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
        new THREE.Vector3(sc * mirror, sc, sc));
      // sole thickness under the heel, measured from the model itself (highest point of the sole near the heel)
      let soleTop = spec.sole_mm ? spec.sole_mm / 1000 : null;
      const ballT = clamp((ball.clone().sub(heel).dot(dir)) / (tip.clone().sub(heel).dot(dir)), 0.55, 0.8);
      for (const mesh of holder.children) {
        const g = mesh.userData.srcGeo.clone();
        g.applyMatrix4(m);
        if (m.determinant() < 0 && g.index) {          // mirrored (left) shoe: restore the triangle winding
          const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; }
          g.index.needsUpdate = true;
        }
        const pos = g.attributes.position, n = pos.count;
        const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
        const L = (tip.clone().sub(heel).dot(dir)) * lenScale / k + 0.02;
        for (let i = 0; i < n; i++) {
          const p = new THREE.Vector3().fromBufferAttribute(pos, i);
          const t = p.clone().sub(heel).dot(dir) / L;
          const wt = smooth(ballT - 0.04, ballT + 0.06, t);
          si[i * 4] = footIdx; si[i * 4 + 1] = toeIdx; sw[i * 4] = 1 - wt; sw[i * 4 + 1] = wt;
        }
        g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
        g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
        if (soleTop == null && /Sole/.test([].concat(mesh.material)[0].name)) {
          g.computeBoundingBox(); soleTop = (g.boundingBox.max.y - g.boundingBox.min.y) * 0.62;
        }
        mesh.geometry.dispose(); mesh.geometry = g;
      }
      soleH = soleTop ?? 0.025;
      holder.userData.frame = { m, heel, dir, len: (tip.clone().sub(heel).dot(dir)) };
    }
    // bind to the body's skeleton; the whole body is then raised by the heel's sole height (in world units)
    for (const holder of shoe.objs) {
      for (const mesh of holder.children) {
        mesh.geometry.translate(0, -soleH / k, 0);
        shoe.skel = new THREE.Skeleton(cur.skel.bones, cur.shoeInv.map((x) => x.clone()));
        mesh.bind(shoe.skel, new THREE.Matrix4());
        mesh.bindMode = "attached";
      }
      if (!holder.parent) cur.scene.add(holder);
    }
    cur.root.position.y = soleH;
    setFootHide(shoe.objs);
  }
  // inside a shoe, the sock/skin is never drawn (it could otherwise poke through the leather at the sides)
  const hideU = { uShoe: { value: [] }, uShoeOn: { value: 0 } };
  function setFootHide(objs) {
    if (!cur) return;
    hideU.uShoeOn.value = objs ? 1 : 0;
    if (!objs) return;
    for (const m of cur.meshes) {
      const mat = m.material; if (!/Skin|Sock/.test(mat.name) || mat.userData.hideHooked) continue;
      mat.userData.hideHooked = true;
      const prev = mat.onBeforeCompile;
      mat.onBeforeCompile = (sh, r) => {
        prev?.call(mat, sh, r);
        sh.uniforms.uShoeA = hideU.uShoeA ||= { value: new THREE.Matrix4() };
        sh.uniforms.uShoeB = hideU.uShoeB ||= { value: new THREE.Matrix4() };
        sh.uniforms.uShoeOn = hideU.uShoeOn;
        sh.uniforms.uShoeBox = hideU.uShoeBox ||= { value: new THREE.Vector3(0.05, 0.062, 0.3) };
        sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
          .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vWPos; uniform mat4 uShoeA; uniform mat4 uShoeB; uniform float uShoeOn; uniform vec3 uShoeBox;\nbool inShoe(mat4 M){ vec3 p = (M * vec4(vWPos,1.0)).xyz; float lim = p.z > uShoeBox.z * 0.43 ? 0.16 : uShoeBox.y; return abs(p.x) < uShoeBox.x && p.y < lim && p.z > -0.05 && p.z < uShoeBox.z; }")
          .replace("void main() {", "void main() {\n if (uShoeOn > 0.5 && (inShoe(uShoeA) || inShoe(uShoeB))) discard;");
      };
      mat.customProgramCacheKey = () => (mat.name + "-shoehide");
      mat.needsUpdate = true;
    }
  }
  const _m = () => new THREE.Matrix4();
  function updateFootHide() {
    if (!shoe || !hideU.uShoeA) return;
    const spec = shoe.spec, lenScale = outerMm(st.eu) / outerMm(spec.size_eu || 42);
    const s = cur.root.scale.x;
    // world matrix of each shoe frame = foot bone world * (foot rest inverse) * shoe frame
    ["L", "R"].forEach((sd, i) => {
      const holder = shoe.objs[i], f = holder.userData.frame; if (!f) return;
      const bi = cur.skel.bones.findIndex((b) => b.name === bn(`foot.${sd}`));
      const W = cur.skel.bones[bi].matrixWorld.clone().multiply(shoe.skel.boneInverses[bi]);
      const frame = f.m.clone().premultiply(new THREE.Matrix4().makeTranslation(0, -cur.root.position.y / s, 0));
      const world = W.multiply(frame);
      // normalise to metres in the shoe's own frame (undo the size scale so the box is in shoe units)
      (i ? hideU.uShoeB : hideU.uShoeA).value.copy(world).invert();
    });
    // everything below the collar line around the shoe: inside it, or poking out through the leather
    const L = (shoe.spec.length_mm || 290) / 1000;
    hideU.uShoeBox.value.set(0.09, (shoe.spec.collar_mm || 60) / 1000, L + 0.03);
  }

  // ---------------------------------------------------------------- "Shop this hoodie"
  const SHOP_URL = "https://chitrakathaproduction.com/shop/";
  function shopLink(cv) {
    const tag = el("a", { class: "walker-shop", href: SHOP_URL, target: "_blank", rel: "noopener", text: "Shop this hoodie" });
    tag.append(el("span", { class: "walker-shop-arrow", text: "→" })); tag.hidden = true;
    canvasBox.append(tag);
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let pending = null, down = null, hideT = 0;
    const shown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
    function hit(e) {
      const meshes = (cur?.hoodie || []).filter(shown);
      if (!meshes.length) return false;
      const r = cv.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const first = ray.intersectObject(cur.root, true).find((h) => shown(h.object));
      return !!first && meshes.includes(first.object);
    }
    function place(e, on) {
      const r = canvasBox.getBoundingClientRect();
      cv.style.cursor = on ? "pointer" : "";
      if (on) {
        clearTimeout(hideT); tag.hidden = false;
        const x = Math.min(e.clientX - r.left + 14, r.width - tag.offsetWidth - 8), y = Math.max(e.clientY - r.top - tag.offsetHeight - 10, 8);
        tag.style.transform = `translate(${x}px, ${y}px)`;
      } else if (e.pointerType !== "touch") tag.hidden = true;
    }
    cv.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch" || e.buttons || pending) return;
      pending = requestAnimationFrame(() => { pending = null; place(e, hit(e)); });
    });
    cv.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") { tag.hidden = true; cv.style.cursor = ""; } });
    cv.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
    cv.addEventListener("pointerup", (e) => {
      const tap = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && e.timeStamp - down.t < 700; down = null;
      if (!tap) return;
      const on = hit(e);
      if (e.pointerType === "touch") { place(e, on); clearTimeout(hideT); if (on) hideT = setTimeout(() => { tag.hidden = true; }, 4000); else tag.hidden = true; }
      else if (on) window.open(SHOP_URL, "_blank", "noopener");
    });
  }

  // ---------------------------------------------------------------- camera
  function views() {
    const s = cur ? cur.root.scale.y : 1, H = (st.heightCm || 175) / 100;
    const fit = (h) => (h * 1.3) / (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.min(1, camera.aspect * 1.2);
    const d = fit(H);
    const at = (az, el = 0.05) => ({ target: [0, H * 0.54, 0], az, el, r: d });
    return {
      full: at(0.55), front: at(0), side: at(Math.PI / 2), back: at(Math.PI),
      // product-photo angle on the shoes: low, three-quarter from the front-outside, both shoes in frame
      shoes: { target: [0.0, 0.07, 0.07], az: 0.62, el: 0.16, r: 0.95 / Math.min(1, camera.aspect * 1.25) }
    };
  }
  const sph = () => {
    const off = camera.position.clone().sub(controls.target);
    return { r: off.length(), az: Math.atan2(off.x, off.z), el: Math.asin(clamp(off.y / Math.max(1e-6, off.length()), -1, 1)) };
  };
  function setCam(t, az, el, r) {
    controls.target.copy(t);
    camera.position.set(t.x + Math.sin(az) * Math.cos(el) * r, t.y + Math.sin(el) * r, t.z + Math.cos(az) * Math.cos(el) * r);
  }
  // transitions orbit around the model (spherical interpolation), never cut through it
  function frameView(name, instant) {
    if (!camera) return;
    spin = null;
    const v = views()[name], t = new THREE.Vector3(...v.target);
    if (instant) { setCam(t, v.az, v.el, v.r); controls.update(); return; }
    const a = sph(); let daz = v.az - a.az; daz = Math.atan2(Math.sin(daz), Math.cos(daz));
    camAnim = { t0: performance.now(), dur: 900, from: { t: controls.target.clone(), ...a }, to: { t, az: a.az + daz, el: v.el, r: v.r } };
  }
  bSpin.addEventListener("click", () => { camAnim = null; const a = sph(); spin = { t0: performance.now(), az0: a.az, el: a.el, r: a.r, t: controls.target.clone() }; });
  bReset.addEventListener("click", () => {
    if (!cur) return;
    st.heightCm = Math.round((cur.meta.height_m || 1.7) * 100); st.kg = DEFAULTS[st.body].kg; st.eu = DEFAULTS[st.body].eu;
    hRange.set(st.heightCm); wRange.set(st.kg); sizeSel.value = st.eu; applyShape();
    if (st.walk) { st.walk = false; motionSeg.set("stand"); applyMotion(); }
    frameView("full");
  });

  // ---------------------------------------------------------------- loop
  function tick() {
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    if (cur) {
      cur.mixer.update(dt);
      const r = cur.bones.root; if (r && cur.rootDelta) r.position.add(cur.rootDelta);
      const ww = cur.walk.getEffectiveWeight();
      if (ww > 0) floorTex.offset.y += (cur.meta.walk?.speed || 1.1) * (cur.legScale || 1) * ww * dt / 2.0;   // floor repeat: 10 tiles / 20 m
      cur.root.updateMatrixWorld(true);
      updateFootHide();
    }
    if (camAnim) {
      const t = clamp((performance.now() - camAnim.t0) / camAnim.dur, 0, 1), e = ease(t), f = camAnim.from, o = camAnim.to;
      setCam(f.t.clone().lerp(o.t, e), lerp(f.az, o.az, e), lerp(f.el, o.el, e), lerp(f.r, o.r, e));
      if (t >= 1) camAnim = null;
    }
    if (spin) {
      const t = clamp((performance.now() - spin.t0) / 6000, 0, 1);
      setCam(spin.t, spin.az0 + ease(t) * Math.PI * 2, spin.el, spin.r);
      if (t >= 1) spin = null;
    }
    controls.update();
    contact.update();
    composer.render();
  }

  // deterministic hooks for visual QA (only with ?qa in the URL)
  async function qa(a) {
    if (a.body && a.body !== st.body) { bodySeg.set(a.body); st.body = a.body; st.heightCm = null; st.kg = null; st.eu = null; await showBody(); }
    if (a.outfit) { st.outfit = a.outfit; outfitSeg.set(a.outfit); applyOutfit(); await refreshShoe(); }
    if (a.h) { st.heightCm = a.h; hRange.set(a.h); }
    if (a.kg) { st.kg = a.kg; wRange.set(a.kg); }
    if (a.eu) { st.eu = a.eu; sizeSel.value = a.eu; }
    if (a.h || a.kg || a.eu) applyShape();
    if (a.motion) { st.walk = a.motion === "walk"; motionSeg.set(a.motion); applyMotion(true); }
    if (a.time != null) { (st.walk ? cur.walk : cur.idle).time = a.time; }
    if (a.view) frameView(a.view, true);
    if (a.cam) { setCam(new THREE.Vector3(...a.cam.target), a.cam.az, a.cam.el, a.cam.r); }
    if (a.noshoe) clearShoes();
    if (a.noshadow) renderer.shadowMap.enabled = false, scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => (m.needsUpdate = true)); });
    if (a.pickProduct) { const b = shoeList.querySelectorAll(".walker-shoe")[a.pickProduct]; b?.click(); }
    cur.mixer.update(0); controls.update();
    if (a.dbg) {
      cur.root.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(cur.root, true);
      const r = cur.bones.root, h = cur.bones.head;
      const wp = (b) => b.getWorldPosition(new THREE.Vector3()).toArray().map((x) => +x.toFixed(3));
      return { bb: [bb.min.toArray().map((x) => +x.toFixed(3)), bb.max.toArray().map((x) => +x.toFixed(3))], root: wp(r), head: wp(h), rootPos: r.position.toArray(), rootRest: cur.rest.root.p.toArray(), rd: cur.rootDelta?.toArray(), sceneScale: cur.scene.scale.toArray(), meshes: cur.meshes.map((m) => m.name).slice(0, 6) };
    }
    return { state: { ...st }, morph: cur.morph, scale: cur.scale };
  }

  let onScreen = false;
  const vis = () => { const was = visible; visible = onScreen && !document.hidden; if (visible && !was) clock?.getDelta(); };
  new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); if (onScreen) start(); vis(); }, { rootMargin: "200px" }).observe(canvasBox);
  document.addEventListener("visibilitychange", vis);
  return { get state() { return { ...st }; } };
}
