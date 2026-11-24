/* 3D try-on: a unisex fashion mannequin built from the customer's height, weight and foot length,
   dressed in the Phool tee and wide-leg trousers, wearing a 3D model of the chosen shoe.
   Drag to rotate, scroll / pinch to zoom.

   The body and clothes are built in fit3d-geom.js (signed-distance sculpture + surface nets,
   build factor solved so volume = weight / 1010 kg/m³), in a Web Worker via fit3d-worker.js.
   This file owns the studio scene: image-based light, soft shadows, cotton materials, true-size
   prints, the shoe models and the orbit camera.

   Foot and size maths are below (footAndShoe). */

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const RHO = 1010;                       // kg/m³
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/* ---------------- body model ---------------- */
// torso cross-sections: [height/H, half-width/H, half-depth/H, weight exponent]
const TORSO = [
  [0.465, 0.072, 0.056, 1.15],
  [0.50, 0.094, 0.066, 1.25],
  [0.54, 0.096, 0.066, 1.3],
  [0.585, 0.084, 0.060, 1.45],
  [0.625, 0.080, 0.058, 1.5],
  [0.67, 0.086, 0.061, 1.25],
  [0.72, 0.092, 0.063, 1.05],
  [0.765, 0.097, 0.058, 0.9],
  [0.80, 0.104, 0.052, 0.8],
  [0.825, 0.092, 0.047, 0.7],
  [0.845, 0.050, 0.040, 0.6],
  [0.86, 0.031, 0.032, 0.6]
];
// limb radii (fraction of H) and weight exponents
const LIMB = {
  thighTop: [0.054, 1.2], knee: [0.032, 0.75], calf: [0.036, 0.85], ankle: [0.018, 0.4],
  upperArm: [0.023, 1.0], elbow: [0.017, 0.6], forearm: [0.019, 0.75], wrist: [0.0115, 0.35],
  neck: [0.03, 0.7]
};

// Geometry of the body for a given stature H (m) and build factor s
function bodyPlan(H, s) {
  const R = (k) => LIMB[k][0] * H * Math.pow(s, LIMB[k][1]);
  const hipX = 0.052 * H * Math.pow(s, 0.6);
  return {
    H,
    torso: TORSO.map(([y, rx, rz, e]) => ({ y: y * H, rx: rx * H * Math.pow(s, e), rz: rz * H * Math.pow(s, e) })),
    hip: { x: hipX, y: 0.50 * H }, knee: { x: 0.056 * H, y: 0.285 * H }, ankle: { x: 0.058 * H, y: 0.047 * H },
    shoulder: { x: 0.118 * H + 0.006 * H * (s - 1), y: 0.815 * H }, elbow: { x: 0.150 * H + 0.01 * H * (s - 1), y: 0.632 * H }, wrist: { x: 0.165 * H + 0.012 * H * (s - 1), y: 0.487 * H },
    r: { thighTop: R("thighTop"), knee: R("knee"), calf: R("calf"), ankle: R("ankle"), upperArm: R("upperArm"), elbow: R("elbow"), forearm: R("forearm"), wrist: R("wrist"), neck: R("neck") },
    head: { y: 0.935 * H, rx: 0.048 * H, ry: 0.066 * H, rz: 0.058 * H },
    hand: { len: 0.105 * H, r: 0.022 * H }
  };
}

// Volume of the plan (m³): torso slices (elliptic frustums) + limbs (frustums) + head + hands
function bodyVolume(b) {
  let v = 0;
  for (let i = 0; i < b.torso.length - 1; i++) {
    const a = b.torso[i], c = b.torso[i + 1];
    v += (c.y - a.y) * Math.PI * (a.rx * a.rz + c.rx * c.rz + Math.sqrt(a.rx * a.rz * c.rx * c.rz)) / 3;
  }
  const frustum = (h, r1, r2) => Math.PI * h * (r1 * r1 + r1 * r2 + r2 * r2) / 3;
  const len = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const thigh = frustum(len(b.hip, b.knee), b.r.thighTop, b.r.knee);
  const shinL = len(b.knee, b.ankle);
  const shin = frustum(shinL * 0.3, b.r.knee, b.r.calf) + frustum(shinL * 0.7, b.r.calf, b.r.ankle);
  const upper = frustum(len(b.shoulder, b.elbow), b.r.upperArm, b.r.elbow);
  const fore = frustum(len(b.elbow, b.wrist), b.r.forearm, b.r.wrist);
  const head = (4 / 3) * Math.PI * b.head.rx * b.head.ry * b.head.rz;
  const neck = frustum(0.03 * b.H, b.r.neck, b.r.neck);
  const hands = 2 * Math.PI * b.hand.r * b.hand.r * 0.45 * b.hand.len;
  const feet = 2 * 0.0011 * Math.pow(b.H / 1.75, 3);                 // ~1.1 L per foot, scales with size
  return v + 2 * (thigh + shin + upper + fore) + head + neck + hands + feet;
}

// Solve the build factor so model volume = weight / density
export function solveBody(heightCm, weightKg) {
  const H = heightCm / 100, target = weightKg / RHO;
  let lo = 0.5, hi = 2.6;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (bodyVolume(bodyPlan(H, m)) < target) lo = m; else hi = m; }
  const s = (lo + hi) / 2;
  const plan = bodyPlan(H, s);
  return { s, plan, volumeL: bodyVolume(plan) * 1000, targetL: target * 1000, bmi: weightKg / (H * H) };
}

export function footAndShoe(heightCm, weightKg, footCm) {
  const est = !(footCm >= 20 && footCm <= 32);
  const L = est ? Math.round(heightCm * 0.152 * 10) / 10 : footCm;
  const bmi = weightKg / Math.pow(heightCm / 100, 2);
  const B = L * 0.39 * (1 + clamp((bmi - 22) / 10, -0.4, 1.5) * 0.05);    // foot breadth, cm
  const euExact = 1.5 * (L + 1.5);
  const eu = clamp(Math.round(euExact), 39, 43);
  const inside = eu / 1.5, outer = inside + 1.2;
  return { footCm: L, estimated: est, breadthCm: B, euExact, eu, insideCm: inside, outerCm: outer, roomCm: inside - L };
}

/* ---------------- shoe styles ---------------- */
const STYLE_BY_SLUG = {
  "axel-penny": "loafer", "retro-vegan": "loafer", "vegan-penny-loafer": "loafer", "monarch-loafers": "loafer", "duke": "loafer",
  "polo-horsebit-loafers": "loafer", "pattern-penny": "loafer",
  "eden": "derby", "volt": "derby", "eton": "derby", "hampton": "derby", "odin": "derby",
  "capri": "sneaker", "vista": "sneaker", "essential-vegan": "sneaker", "series-001": "sneaker", "series-003": "sneaker", "series-005": "sneaker",
  "monaco": "slipon", "summerset": "slipon", "heritage": "slipon", "amber": "slipon", "monks": "slipon", "series-006": "slipon",
  "atlas-chelseaboots": "chelsea", "zane-zipper-boot": "zip", "builder-boots": "work"
};
const STYLES = {
  //          sole m   heel  toe  open u  collar m  vamp toe/instep m   laces  soleColour   pointy
  loafer:  { sole: 0.014, heel: 0.012, open: 0.47, collar: 0.052, toeH: 0.040, instep: 0.062, laces: false, soleCol: null, point: 1.7 },
  derby:   { sole: 0.014, heel: 0.016, open: 0.44, collar: 0.058, toeH: 0.040, instep: 0.070, laces: true,  soleCol: null, point: 1.55 },
  sneaker: { sole: 0.030, heel: 0,     open: 0.44, collar: 0.068, toeH: 0.048, instep: 0.075, laces: true,  soleCol: 0xf2f2f2, point: 2.2 },
  slipon:  { sole: 0.028, heel: 0,     open: 0.47, collar: 0.058, toeH: 0.046, instep: 0.066, laces: false, soleCol: 0xf2f2f2, point: 2.2 },
  chelsea: { sole: 0.016, heel: 0.016, open: 0.42, collar: 0.150, toeH: 0.042, instep: 0.080, laces: false, soleCol: null, point: 1.8, boot: true, gusset: true },
  zip:     { sole: 0.016, heel: 0.016, open: 0.42, collar: 0.140, toeH: 0.042, instep: 0.080, laces: false, soleCol: null, point: 1.8, boot: true },
  work:    { sole: 0.034, heel: 0.008, open: 0.42, collar: 0.150, toeH: 0.055, instep: 0.090, laces: true,  soleCol: 0x5a3b22, point: 2.6, boot: true, padded: true }
};
export function styleFor(product) {
  return STYLE_BY_SLUG[product.slug] || ({ loafers: "loafer", formals: "derby", sneakers: "sneaker", boots: "chelsea" }[product.category]) || "loafer";
}

// half-width of the footprint at u (0 = heel, 1 = toe), as a fraction of half the breadth
export function footprint(u, point) {
  if (u < 0.12) return 0.78 * Math.sqrt(Math.max(0, u / 0.12)) + 0.02;
  if (u < 0.45) return lerp(0.80, 0.88, (u - 0.12) / 0.33);
  if (u < 0.72) return lerp(0.88, 1.0, smooth((u - 0.45) / 0.27));
  const t = (u - 0.72) / 0.28;
  return Math.max(0.02, Math.pow(Math.max(0, 1 - Math.pow(t, point)), 1 / point));
}

function buildShoe(THREE, stIn, Lm, Bm, upperHex, gloss) {
  const g = new THREE.Group();
  const st = stIn.boot ? { ...stIn, boot: false, collarBoot: stIn.collar, collar: 0.075, open: 0.44 } : stIn;
  const N = 72, K = 14;                                // outline points, rings up the upper
  // outline loop: right side heel->toe, then left side toe->heel (x right, z forward)
  const outline = [];
  for (let i = 0; i < N; i++) {
    const t = i / N, side = t < 0.5 ? 1 : -1;
    const u = t < 0.5 ? t * 2 : (1 - t) * 2;
    const uu = 0.5 - 0.5 * Math.cos(Math.PI * u);       // denser at heel and toe
    outline.push({ u: uu, x: side * footprint(uu, st.point) * Bm / 2, z: uu * Lm });
  }
  // ---- sole (extruded footprint) ----
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x * 1.04, p.z * 1.0 - 0.004)));
  const soleGeo = new THREE.ExtrudeGeometry(shape, { depth: st.sole, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2, curveSegments: 4 });
  soleGeo.rotateX(Math.PI / 2); soleGeo.translate(0, st.sole + st.heel, 0);
  const soleCol = st.soleCol ?? 0x151515;
  const soleMat = new THREE.MeshStandardMaterial({ color: soleCol, roughness: 0.75 });
  const sole = new THREE.Mesh(soleGeo, soleMat); sole.castShadow = true; sole.receiveShadow = true; g.add(sole);
  if (st.heel > 0) {                                   // stacked heel block
    const hs = new THREE.Shape(outline.filter((p) => p.u < 0.26).map((p) => new THREE.Vector2(p.x * 1.0, p.z)));
    const hg = new THREE.ExtrudeGeometry(hs, { depth: st.heel, bevelEnabled: false });
    hg.rotateX(Math.PI / 2); hg.translate(0, st.heel, 0);
    const heel = new THREE.Mesh(hg, soleMat); heel.castShadow = true; g.add(heel);
  }
  // ---- upper: rings from the sole edge up to the top line, closing over the toe/vamp ----
  const base = st.sole + st.heel * 1.0;
  const topH = (u) => {
    const vamp = lerp(st.toeH, st.instep, smooth((1 - u) / (1 - st.open)));       // toe -> instep
    if (st.boot) return u < st.open + 0.12 ? st.collar : lerp(st.collar, vamp, smooth((u - st.open - 0.12) / 0.2));
    if (u < st.open) return st.collar - 0.008 * Math.sin(Math.PI * clamp(u / st.open, 0, 1));   // dips at the sides
    return vamp;
  };
  const closure = (u) => smooth((u - st.open - (st.boot ? 0.08 : 0)) / 0.07);  // 0 = open collar walls, 1 = closed toe box
  const heelLift = (u) => st.heel * (1 - smooth((u - 0.2) / 0.35));                       // sole rises under the heel
  const pos = [], col = [], idx = [];
  const baseC = new THREE.Color(upperHex);
  const gusset = new THREE.Color(upperHex).multiplyScalar(0.55);
  for (let k = 0; k <= K; k++) {
    const v = k / K;
    for (let i = 0; i < N; i++) {
      const p = outline[i], c = closure(p.u);
      const h = topH(p.u) - st.sole;                  // height of the upper above the sole
      const ang = v * Math.PI / 2;
      // walls rise straight (slight taper); closed region curls over in a quarter circle
      const inward = st.boot ? lerp(0.2 * smooth(v), 1 - Math.cos(ang), c) : lerp(0.18 * smooth(v), 1 - Math.cos(ang) * 0.98, c);
      const lift = lerp(v, Math.sin(ang), c);
      const x = p.x * (1 - inward);
      const y = base - st.heel + heelLift(p.u) + h * lift + 0.001;
      const z = p.z + (st.boot ? -0.012 * v * (1 - c) * (p.u < 0.15 ? 1 : 0.3) : 0);
      pos.push(x, y, z);
      let cc = baseC;
      if (st.gusset && c < 0.2 && v > 0.32 && p.u > 0.2 && p.u < 0.36) cc = gusset;   // Chelsea elastic panel
      if (st.padded && c < 0.2 && v > 0.86) cc = new THREE.Color(0x2b1a10);              // padded collar
      col.push(cc.r, cc.g, cc.b);
    }
  }
  for (let k = 0; k < K; k++) for (let i = 0; i < N; i++) {
    const a = k * N + i, b = k * N + (i + 1) % N, c2 = (k + 1) * N + i, d = (k + 1) * N + (i + 1) % N;
    idx.push(a, b, d, a, d, c2);
  }
  const ug = new THREE.BufferGeometry();
  ug.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  ug.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  ug.setIndex(idx); ug.computeVertexNormals();
  const upperMat = gloss
    ? new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, side: THREE.DoubleSide });
  const upper = new THREE.Mesh(ug, upperMat); upper.castShadow = true; upper.receiveShadow = true; g.add(upper);
  // dark lining visible through the opening
  // boot shaft: an elliptical tube around the ankle, from inside the shoe body up to the collar
  if (stIn.boot) {
    const H = stIn.collar - 0.035, rx = Bm * 0.40, rz = Lm * 0.165;
    const tube = new THREE.CylinderGeometry(1, 1.06, H, 48, 6, true);
    const tc = [], tp = tube.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i), y = tp.getY(i), side = Math.abs(x) > 0.75 && y > -H * 0.25;
      const cc = stIn.gusset && side ? gusset : (stIn.padded && y > H * 0.38 ? new THREE.Color(0x2b1a10) : baseC);
      tc.push(cc.r, cc.g, cc.b);
    }
    tube.setAttribute("color", new THREE.Float32BufferAttribute(tc, 3));
    tube.scale(rx, 1, rz); tube.computeVertexNormals();
    const shaft = new THREE.Mesh(tube, upperMat);
    shaft.position.set(0, 0.035 + H / 2 + st.sole * 0.5, Lm * 0.235);
    shaft.castShadow = true; g.add(shaft);
    if (stIn.padded) {
      const roll = new THREE.Mesh(new THREE.TorusGeometry(1, 0.11, 10, 48), new THREE.MeshStandardMaterial({ color: 0x2b1a10, roughness: 0.6 }));
      roll.rotation.x = Math.PI / 2; roll.scale.set(rx, rz, 0.12); roll.position.set(0, shaft.position.y + H / 2, shaft.position.z); g.add(roll);
    }
    if (stIn.laces) {                                   // laces up the front of the shaft
      const laceMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.7 });
      for (let j = 0; j < 4; j++) {
        const y = shaft.position.y - H / 2 + (j + 0.6) * H / 4.4;
        const lace = new THREE.Mesh(new THREE.BoxGeometry(rx * 0.9, 0.0035, 0.004), laceMat);
        lace.position.set(0, y, shaft.position.z + rz * 1.02); lace.rotation.z = (j % 2 ? 1 : -1) * 0.15; g.add(lace);
      }
    }
  }
  const lining = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }));
  lining.rotation.x = -Math.PI / 2; lining.scale.set(Bm * 0.36, Lm * 0.26, 1); lining.position.set(0, base + 0.004, Lm * 0.26); g.add(lining);
  // laces
  if (st.laces) {
    const laceMat = new THREE.MeshStandardMaterial({ color: st.soleCol === 0xf2f2f2 && baseC.getHSL({}).l < 0.5 ? 0xf5f5f5 : 0x111111, roughness: 0.7 });
    const n = st.boot ? 7 : 5;
    for (let j = 0; j < n; j++) {
      const u = lerp(st.open + 0.09, st.open + (st.boot ? 0.3 : 0.24), j / (n - 1));
      const w = footprint(u, st.point) * Bm / 2 * 0.5;
      const lace = new THREE.Mesh(new THREE.BoxGeometry(w * 2, 0.0035, 0.004), laceMat);
      lace.position.set(0, base - st.heel + heelLift(u) + (topH(u) - st.sole) - 0.001, u * Lm); lace.rotation.z = (j % 2 ? 1 : -1) * 0.12;
      g.add(lace);
    }
  }
  return g;
}

/* ---------------- materials helpers ---------------- */
// Upper colour from the product photo: median of the darker/saturated pixels in the upper part
export function sampleUpperColour(img) {
  try {
    const W = 120, Hh = Math.max(1, Math.round(120 * img.height / img.width));
    const c = document.createElement("canvas"); c.width = W; c.height = Hh;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, W, Hh);
    const d = g.getImageData(0, 0, W, Hh).data;
    let minY = Hh, maxY = 0;
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 200) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const rs = [], gs = [], bs = [];
    for (let y = minY; y < minY + (maxY - minY) * 0.6; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4; if (d[i + 3] < 220) continue;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (l > 235) continue;                           // skip white soles / highlights
      rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    }
    if (rs.length < 30) return 0xeeeeee;
    const med = (a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
    return (med(rs) << 16) | (med(gs) << 8) | med(bs);
  } catch { return 0x222222; }
}

/* ---------------- scene ---------------- */
/* ---------------- scene: a sculpted fashion mannequin, dressed, in studio light ----------------
   The body is a smooth signed-distance sculpture (ellipsoids and tapered capsules for each muscle
   group, blended with a smooth union), meshed with surface nets. Everything is in units of
   stature H, so height scales the whole figure. Weight drives one build factor s: every girth is
   multiplied by s^e (e = how much that region gains with weight: waist and belly most, wrists and
   head least), and s is solved by bisection so the mesh's measured volume equals
   V = weight / 1010 kg/m³.
   Clothes are sculpted around the body the same way: an oversized boxy tee that hangs from the
   chest (not the waist) with drop-shoulder sleeves, gravity folds and true-size prints, and
   wide-leg trousers with vertical drape and a break at the hem. Studio image-based lighting plus a
   soft shadow-mapped key light give the fabric real shading and contact shadows. */

const ADDONS = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/";
const PRINT_FRONT = "/assets/img/apparel/phool-front.png";
const PRINT_BACK = "/assets/img/apparel/phool-back.png";

export async function createFit3D(container) {
  try { return await createFit3DUnsafe(container); }
  catch (e) { console.info("3D try-on unavailable:", e?.message || e); container.querySelector("canvas.fit3d-canvas")?.remove(); return null; }
}

async function createFit3DUnsafe(container) {
  try { const t = document.createElement("canvas"); if (!(t.getContext("webgl2") || t.getContext("webgl"))) return null; } catch { return null; }
  const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
  const [THREE, { RoomEnvironment }] = await timeout(Promise.all([import(THREE_URL), import(ADDONS + "environments/RoomEnvironment.js")]), 12000);
  const loadImage = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  const printsP = Promise.all([loadImage(PRINT_FRONT), loadImage(PRINT_BACK)]);

  // ---------- renderer & studio ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = "fit3d-canvas";
  canvas.setAttribute("role", "img");
  container.prepend(canvas);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.environmentIntensity = 0.3;
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);

  const key = new THREE.DirectionalLight(0xfffaf2, 3.4);
  key.position.set(2.8, 3.2, 1.1);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -0.8, right: 0.8, top: 2.2, bottom: -0.2, near: 0.5, far: 8 });
  key.shadow.bias = -0.0003; key.shadow.normalBias = 0.015; key.shadow.radius = 5;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 1.2); rim.position.set(-2.4, 2.4, -2.6); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xf2f5ff, 0.45); fill.position.set(-2.5, 1.2, 2); scene.add(fill);

  const ground = new THREE.Mesh(new THREE.CircleGeometry(2.2, 64), new THREE.ShadowMaterial({ opacity: 0.3 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const aoC = document.createElement("canvas"); aoC.width = aoC.height = 128;
  { const g = aoC.getContext("2d"), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, "rgba(0,0,0,.42)"); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); }
  const ao = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.55), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(aoC), transparent: true, depthWrite: false }));
  ao.rotation.x = -Math.PI / 2; ao.position.y = 0.002; scene.add(ao);

  // ---------- materials ----------
  function knitNormal(scale) {
    const c = document.createElement("canvas"); c.width = c.height = 256; const g = c.getContext("2d");
    const img = g.createImageData(256, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4, wale = Math.sin(x * Math.PI / 4) * 0.6, course = Math.sin(y * Math.PI / 3 + Math.sin(x * Math.PI / 8)) * 0.4, n = (Math.random() - 0.5) * 0.35;
      img.data[i] = 128 + (wale + n) * 40 * scale; img.data[i + 1] = 128 + (course + n) * 40 * scale; img.data[i + 2] = 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  }
  const bodyMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.22 });
  const teeCanvas = document.createElement("canvas"); teeCanvas.width = 2048; teeCanvas.height = 1024;
  const teeTex = new THREE.CanvasTexture(teeCanvas); teeTex.colorSpace = THREE.SRGBColorSpace; teeTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const teeKnit = knitNormal(1); teeKnit.repeat.set(160, 80);
  const teeMat = new THREE.MeshPhysicalMaterial({ map: teeTex, vertexColors: true, roughness: 0.92, sheen: 0.15, sheenRoughness: 0.9, sheenColor: new THREE.Color(0xffffff), normalMap: teeKnit, normalScale: new THREE.Vector2(0.25, 0.25), side: THREE.DoubleSide });
  const pantsKnit = knitNormal(0.8); pantsKnit.repeat.set(60, 60);
  const pantsMat = new THREE.MeshPhysicalMaterial({ color: 0x6f6f6c, roughness: 0.85, sheen: 0.5, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xcfcfcf), normalMap: pantsKnit, normalScale: new THREE.Vector2(0.3, 0.3), side: THREE.DoubleSide });

  const figure = new THREE.Group(); scene.add(figure);
  const meshes = { body: null, tee: null, pants: null };
  const shoes = [];

  function setMesh(name, { P, N, I, col, uv }, mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(P, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    if (col) g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    if (uv) g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(I, 1));
    g.computeBoundingSphere();
    if (meshes[name]) { figure.remove(meshes[name]); meshes[name].geometry.dispose(); }
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
    figure.add(m); meshes[name] = m;
  }

  function paintTee(front, back) {
    const g = teeCanvas.getContext("2d"), W = teeCanvas.width, Hc = teeCanvas.height;
    g.fillStyle = "#e2e2de"; g.fillRect(0, 0, W, Hc);
    const pxPerM = 1024 / 0.8;
    const place = (img, uCentre, belowTopM, widthM) => {
      if (!img) return;
      const w = widthM * pxPerM, h = w * img.height / img.width;
      g.drawImage(img, uCentre * W - w / 2, belowTopM * pxPerM, w, h);
    };
    place(front, 0.25, 0.115, 0.105);      // chest logo, 10.5 cm wide
    place(back, 0.75, 0.10, 0.31);         // back artwork, 31 cm wide
    teeTex.needsUpdate = true;
  }
  printsP.then(([f, b]) => paintTee(f, b));
  paintTee(null, null);

  // ---------- build for a customer ----------
  let buildCount = 0;
  // geometry is built in a worker (fit3d-geom.js), then dressed here
  let worker = null, seq = 0, inFlight = false, queued = null;
  try { worker = new Worker(new URL("./fit3d-worker.js?v=10", import.meta.url), { type: "module" }); } catch { worker = null; }
  let geomLocal = null;
  async function buildGeometry(opts) {
    if (worker) {
      const id = ++seq;
      const r = await new Promise((res, rej) => {
        const on = (e) => { if (e.data.id !== id) return; worker.removeEventListener("message", on); e.data.error ? rej(new Error(e.data.error)) : res(e.data.r); };
        worker.addEventListener("message", on);
        worker.postMessage({ id, opts });
      }).catch(() => null);
      if (r) return r;
      worker = null;                                              // worker failed: build on this thread from now on
    }
    geomLocal ||= await import("./fit3d-geom.js?v=10");
    return geomLocal.buildFigure(opts);
  }

  // ---------- the real product: 3D scans of our shoes ----------
  // assets/models/shoes/manifest.json maps a product slug to its scanned model, e.g.
  //   { "series-005": { "file": "/assets/models/shoes/series-005.glb", "toe": "+z", "side": "right",
  //                     "colours": { "black": "/assets/models/shoes/series-005-black.glb" } } }
  // A scan is scaled to the exact outside length of the customer's EU size, stood on the floor,
  // and mirrored for the other foot. Styles without a scan use the generic modelled shoe.
  let manifestP = null;
  const scanCache = new Map();
  const slugify = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  async function scannedShoe(slug, colourName) {
    if (!slug) return null;
    manifestP ||= fetch("/assets/models/shoes/manifest.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    const m = (await manifestP)[slug];
    if (!m) return null;
    const file = m.colours?.[slugify(colourName)] || m.file;
    if (!scanCache.has(file)) {
      scanCache.set(file, (async () => {
        const { GLTFLoader } = await import(ADDONS + "loaders/GLTFLoader.js");
        const gltf = await new GLTFLoader().loadAsync(file);
        gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        return { scene: gltf.scene, toe: m.toe || "+z", side: m.side || "right" };
      })().catch((e) => { console.info("Shoe scan failed to load:", file, e?.message || e); return null; }));
    }
    return scanCache.get(file);
  }
  function placeScan(scan, Lm, side) {
    const inner = new THREE.Group(), wrap = new THREE.Group();
    inner.add(scan.scene.clone(true));
    inner.rotation.y = { "+z": 0, "-z": Math.PI, "+x": -Math.PI / 2, "-x": Math.PI / 2 }[scan.toe] ?? 0;
    wrap.add(inner);
    wrap.updateMatrixWorld(true);
    let bb = new THREE.Box3().setFromObject(wrap, true);
    if (bb.max.x - bb.min.x > bb.max.z - bb.min.z) {                            // length must run along z
      inner.rotation.y += Math.PI / 2; wrap.updateMatrixWorld(true); bb = new THREE.Box3().setFromObject(wrap, true);
      console.info("Shoe scan is sideways: set its \"toe\" to \"+x\" or \"-x\" in manifest.json");
    }
    inner.scale.setScalar(Lm / Math.max(1e-6, bb.max.z - bb.min.z));          // true length for this EU size
    wrap.updateMatrixWorld(true);
    bb = new THREE.Box3().setFromObject(wrap, true);
    inner.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -bb.min.z);       // heel at z = 0, sole on the floor
    if (scan.side !== side) wrap.scale.x = -1;
    wrap.userData.scan = true;                                                   // shared geometry: don't dispose
    return wrap;
  }

  const sCache = new Map();
  async function rebuild({ heightCm, weightKg, fit, style, colour, gloss, slug, colourName }, draft = false) {
    const st = STYLES[style] || STYLES.loafer;
    const key = `${heightCm}|${weightKg}|${fit.footCm}|${fit.breadthCm}`;
    const g = await buildGeometry({ heightCm, weightKg, fit, draft, sKnown: sCache.get(key) || null, st: { sole: st.sole, heel: st.heel, collar: st.collar, boot: !!st.boot } });
    sCache.set(key, g.s);
    const { H, lift, heelZ } = g;
    setMesh("body", g.body, bodyMat);
    setMesh("tee", g.tee, teeMat);
    setMesh("pants", g.pants, pantsMat); meshes.pants.visible = !xray;
    // ---- shoes ----
    const scan = await scannedShoe(slug, colourName);
    shoes.forEach((o) => { figure.parent.remove(o); if (!o.userData.scan) o.traverse((m) => { m.geometry?.dispose(); m.material?.dispose?.(); }); });
    shoes.length = 0;
    const Lm = fit.outerCm / 100, Bm = (fit.breadthCm + 1.0) / 100;
    for (const sx of [1, -1]) {
      const o = scan ? placeScan(scan, Lm, sx > 0 ? "left" : "right") : buildShoe(THREE, st, Lm, Bm, colour, gloss);
      o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      o.position.set(0.052 * sx * H, 0, heelZ);
      if (sx < 0 && !scan) o.scale.x = -1;
      scene.add(o); shoes.push(o);
    }
    applyXray();
    figure.position.y = lift;
    target.H = H;
    buildCount++;
    canvas.dataset.built = String(buildCount);
    return { s: g.s, bmi: g.bmi, targetL: g.targetL, volumeL: g.volumeL };
  }

  // ---------- orbit camera ----------
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const target = { H: 1.75 }, cam = { az: 0.5, el: 0.08, dist: 4, focusY: 0.9, auto: true };
  const want = { dist: 4, focusY: 0.9, el: 0.08 };
  let mode = "full";
  // feet close-up: see-through shoes and trousers, so the foot inside the shoe is visible
  let xray = false;
  function applyXray() {
    if (meshes.pants) meshes.pants.visible = !xray;
    for (const o of shoes) o.traverse((m) => { if (!m.isMesh) return; m.material.transparent = xray; m.material.opacity = xray ? 0.42 : 1; m.material.depthWrite = !xray; m.material.needsUpdate = true; m.castShadow = !xray; });
  }
  function preset(m, keepX) {
    mode = m;
    if (!keepX) { xray = m === "feet"; applyXray(); }
    if (m === "feet") { want.dist = 1.05; want.focusY = 0.05; want.el = 0.78; cam.az = 0.55; cam.auto = false; }
    else if (m === "top") { want.dist = 1.5; want.focusY = target.H * 0.72; want.el = 0.04; }
    else { want.dist = target.H * 2.25; want.focusY = target.H * 0.52; want.el = 0.08; }
  }
  const ptrs = new Map(); let lx = 0, ly = 0, pinch0 = 0;
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, e); lx = e.clientX; ly = e.clientY; cam.auto = false; });
  canvas.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, e);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); if (pinch0) want.dist = clamp(want.dist * pinch0 / d, 0.5, 6); pinch0 = d; return; }
    cam.az -= (e.clientX - lx) * 0.009; want.el = clamp(want.el + (e.clientY - ly) * 0.005, -0.2, 1.2); lx = e.clientX; ly = e.clientY;
  });
  const up = (e) => { ptrs.delete(e.pointerId); pinch0 = 0; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); want.dist = clamp(want.dist * (1 + Math.sign(e.deltaY) * 0.1), 0.5, 6); cam.auto = false; }, { passive: false });

  function resize() { const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(container); resize();
  let visible = true; new IntersectionObserver(([en]) => { visible = en.isIntersecting; }).observe(container);
  let last = performance.now(), t = 0;
  (function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (visible && !document.hidden) {
      t += dt;
      if (cam.auto && !reduceMotion) cam.az += dt * 0.3;
      // breathing: a few millimetres of chest rise
      if (!reduceMotion && meshes.tee) { const b = 1 + Math.sin(t * 1.3) * 0.004; meshes.tee.scale.set(b, 1, b); }
      const kk = 1 - Math.pow(0.002, dt);
      cam.dist += (want.dist - cam.dist) * kk; cam.focusY += (want.focusY - cam.focusY) * kk; cam.el += (want.el - cam.el) * kk;
      camera.position.set(Math.sin(cam.az) * Math.cos(cam.el) * cam.dist, cam.focusY + Math.sin(cam.el) * cam.dist, Math.cos(cam.az) * Math.cos(cam.el) * cam.dist);
      camera.lookAt(0, cam.focusY, 0);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  })(last);

  // rebuilding takes a moment, so slider drags are coalesced: one build at a time, latest wins
  let lastResult = null;
  let fullDone = true;
  async function pump() {
    if (inFlight) return;
    if (!queued && fullDone) return;
    inFlight = true;
    let opts, draft;
    if (queued) { opts = queued; queued = null; draft = true; fullDone = false; lastOpts = opts; }
    else { opts = lastOpts; draft = false; fullDone = true; }
    try { lastResult = await rebuild(opts, draft); if (mode === "full" && draft) preset("full", true); }
    catch (e) { console.info("3D try-on build failed:", e?.message || e); }
    inFlight = false;
    // wait a beat before the full-quality pass, so a slider drag stays on quick drafts
    if (!queued && !fullDone) setTimeout(pump, 250); else pump();
  }
  let lastOpts = null;
  return {
    THREE, scene,
    setAzimuth(a) { cam.az = a; cam.auto = false; },
    update(opts) {
      queued = opts; pump();
      canvas.setAttribute("aria-label", `3D mannequin, ${opts.heightCm} cm and ${opts.weightKg} kg, wearing EU ${opts.fit.eu}. Drag to rotate.`);
      return lastResult;
    },
    whenBuilt() { return new Promise((res) => { const t = setInterval(() => { if (!inFlight && !queued && fullDone && lastResult) { clearInterval(t); res(lastResult); } }, 50); }); },
    preset,
    resetView() { cam.auto = true; preset(mode); }
  };
}
