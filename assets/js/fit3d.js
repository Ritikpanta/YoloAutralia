/* 3D try-on: a unisex mannequin built from the customer's height, weight and foot length,
   wearing a 3D model of the chosen shoe. Drag to rotate, scroll / pinch to zoom.

   The maths
   ---------
   • Segment lengths: anthropometric ratios of stature H (Drillis & Contini, 1966), averaged
     between male and female values so the figure is unisex. e.g. shoulder 0.818H, hip joint 0.50H,
     knee 0.285H, ankle 0.045H, shoulder breadth 0.245H, foot length 0.152H.
   • Girths: every cross-section starts from a reference profile (fractions of H). One "build"
     factor s scales the radii, with region-specific exponents (waist and hips change most with
     weight, wrists and ankles least). s is solved by bisection so that the model's volume equals
     the customer's body volume:  V = weight / ρ,  ρ ≈ 1010 kg/m³ (average whole-body density).
   • Feet & shoes: foot length = input, or 0.152H if not given. Foot breadth ≈ 0.39 × length,
     widening slightly with BMI. EU size = 1.5 × (foot cm + 1.5) (Paris point = ⅔ cm), shoe
     inside length = EU / 1.5 cm, outer length ≈ inside + 1.2 cm.
   All units in metres. */

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
function footprint(u, point) {
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
export async function createFit3D(container) {
  try { return await createFit3DUnsafe(container); }
  catch (e) { console.info("3D try-on unavailable:", e?.message || e); container.querySelector("canvas.fit3d-canvas")?.remove(); return null; }
}
async function createFit3DUnsafe(container) {
  let THREE;
  try { THREE = await Promise.race([import(THREE_URL), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 8000))]); }
  catch (e) { return null; }
  try { const t = document.createElement("canvas"); if (!(t.getContext("webgl2") || t.getContext("webgl"))) return null; } catch { return null; }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = "fit3d-canvas";
  canvas.setAttribute("role", "img");
  container.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d8d8, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1.6, 3.2, 2.4); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -1.2; key.shadow.camera.right = 1.2; key.shadow.camera.top = 2.4; key.shadow.camera.bottom = -0.2; key.shadow.radius = 4;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.8); rim.position.set(-2, 2, -2.5); scene.add(rim);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(1.6, 64), new THREE.ShadowMaterial({ opacity: 0.16 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.553, 96), new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.15 }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.001; scene.add(ring);

  const skin = new THREE.MeshStandardMaterial({ color: 0xe9e7e4, roughness: 0.55, metalness: 0 });
  let figure = null;

  function limb(p0, p1, r0, r1, segs = 28) {
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y, (p1.z || 0) - (p0.z || 0));
    const geo = new THREE.CylinderGeometry(r1, r0, len, segs, 1, true);
    const m = new THREE.Mesh(geo, skin);
    const a = new THREE.Vector3(p0.x, p0.y, p0.z || 0), b = new THREE.Vector3(p1.x, p1.y, p1.z || 0);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.castShadow = true; return m;
  }
  function joint(p, r) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 18), skin); m.position.set(p.x, p.y, p.z || 0); m.castShadow = true; return m; }
  // lathe-like lofted torso with elliptical sections
  function torso(sections) {
    const N = 40, pos = [], idx = [];
    sections.forEach((s) => { for (let i = 0; i < N; i++) { const a = (i / N) * Math.PI * 2; pos.push(Math.cos(a) * s.rx, s.y, Math.sin(a) * s.rz + 0.004); } });
    for (let k = 0; k < sections.length - 1; k++) for (let i = 0; i < N; i++) {
      const a = k * N + i, b = k * N + (i + 1) % N, c = (k + 1) * N + i, d = (k + 1) * N + (i + 1) % N;
      idx.push(a, d, b, a, c, d);
    }
    // bottom cap
    const bc = pos.length / 3; pos.push(0, sections[0].y - 0.01, 0.004);
    for (let i = 0; i < N; i++) idx.push(bc, i, (i + 1) % N);
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, skin); m.castShadow = true; return m;
  }

  function build({ plan, shoe }) {
    if (figure) { scene.remove(figure); figure.traverse((o) => { o.geometry?.dispose(); if (o.material && o.material !== skin) o.material.dispose?.(); }); }
    figure = new THREE.Group();
    const b = plan;
    // legs (with a slight natural knee line), feet turned out ~7°
    for (const side of [-1, 1]) {
      const hip = { x: side * b.hip.x, y: b.hip.y }, knee = { x: side * b.knee.x, y: b.knee.y, z: 0.004 }, ankle = { x: side * b.ankle.x, y: b.ankle.y, z: 0 };
      figure.add(limb(hip, knee, b.r.thighTop, b.r.knee));
      figure.add(joint(knee, b.r.knee));
      const calfP = { x: lerp(knee.x, ankle.x, 0.3), y: lerp(knee.y, ankle.y, 0.3), z: -0.006 };
      figure.add(limb(knee, calfP, b.r.knee, b.r.calf));
      figure.add(joint(calfP, b.r.calf));
      figure.add(limb(calfP, ankle, b.r.calf, b.r.ankle));
      figure.add(joint(ankle, b.r.ankle));
      figure.add(joint({ x: hip.x, y: hip.y + 0.01 }, b.r.thighTop * 0.98));
      // arms in a relaxed A-pose
      const sh = { x: side * b.shoulder.x, y: b.shoulder.y }, el = { x: side * b.elbow.x, y: b.elbow.y, z: -0.01 }, wr = { x: side * b.wrist.x, y: b.wrist.y, z: 0.02 };
      figure.add(joint(sh, b.r.upperArm * 1.18));
      figure.add(limb(sh, el, b.r.upperArm, b.r.elbow));
      figure.add(joint(el, b.r.elbow));
      figure.add(limb(el, wr, b.r.forearm, b.r.wrist));
      figure.add(joint(wr, b.r.wrist));
      const hand = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), skin);
      hand.scale.set(b.hand.r * 0.55, b.hand.len * 0.5, b.hand.r * 1.05);
      hand.position.set(wr.x + side * 0.004, wr.y - b.hand.len * 0.45, 0.022); hand.castShadow = true; figure.add(hand);

      // shoe on this foot: heel ~28% of the shoe behind the ankle
      const shoeObj = buildShoe(THREE, shoe.style, shoe.L, shoe.B, shoe.colour, shoe.gloss);
      shoeObj.position.set(ankle.x + side * 0.004, 0, -shoe.L * 0.22);
      shoeObj.rotation.y = side * -0.11;
      if (side < 0) shoeObj.scale.x = -1;               // mirror the left shoe
      figure.add(shoeObj);
    }
    figure.add(torso(b.torso));
    figure.add(limb({ x: 0, y: 0.845 * b.H }, { x: 0, y: 0.895 * b.H }, b.r.neck, b.r.neck * 0.95));
    const head = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), skin);
    head.scale.set(b.head.rx, b.head.ry, b.head.rz); head.position.set(0, b.head.y, 0.006); head.castShadow = true;
    figure.add(head);
    scene.add(figure);
    target.H = b.H;
  }

  // ---------- orbit camera (drag to rotate, wheel/pinch to zoom, presets) ----------
  const target = { H: 1.75 }, cam = { az: 0.55, el: 0.1, dist: 1, focusY: 0.5, auto: true };
  const want = { dist: 1, focusY: 0.5, el: 0.1 };
  let mode = "full";
  function preset(m) {
    mode = m;
    if (m === "feet") { want.dist = 0.85; want.focusY = 0.07; want.el = 0.32; }
    else { want.dist = target.H * 2.15; want.focusY = target.H * 0.5; want.el = 0.1; }
  }
  let dragging = false, lx = 0, ly = 0; const ptrs = new Map(); let pinch0 = 0;
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, e); dragging = true; lx = e.clientX; ly = e.clientY; cam.auto = false; });
  canvas.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, e);
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch0) want.dist = clamp(want.dist * pinch0 / d, 0.45, 5); pinch0 = d; return;
    }
    cam.az -= (e.clientX - lx) * 0.009; want.el = clamp(want.el + (e.clientY - ly) * 0.005, -0.2, 1.2);
    lx = e.clientX; ly = e.clientY;
  });
  const up = (e) => { ptrs.delete(e.pointerId); pinch0 = 0; dragging = ptrs.size > 0; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); want.dist = clamp(want.dist * (1 + Math.sign(e.deltaY) * 0.1), 0.45, 5); cam.auto = false; }, { passive: false });

  function resize() {
    const w = container.clientWidth, h = container.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container); resize();
  let visible = true; new IntersectionObserver(([en]) => { visible = en.isIntersecting; }).observe(container);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let last = performance.now();
  (function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (visible && !document.hidden) {
      if (cam.auto && !reduce) cam.az += dt * 0.35;
      const k = 1 - Math.pow(0.002, dt);
      cam.dist += (want.dist - cam.dist) * k; cam.focusY += (want.focusY - cam.focusY) * k; cam.el += (want.el - cam.el) * k;
      camera.position.set(Math.sin(cam.az) * Math.cos(cam.el) * cam.dist, cam.focusY + Math.sin(cam.el) * cam.dist, Math.cos(cam.az) * Math.cos(cam.el) * cam.dist);
      camera.lookAt(0, cam.focusY, 0);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  })(last);

  return {
    THREE, scene, skin,
    update({ heightCm, weightKg, fit, style, colour, gloss }) {
      const body = solveBody(heightCm, weightKg);
      build({ plan: body.plan, shoe: { style: STYLES[style] || STYLES.loafer, L: fit.outerCm / 100, B: (fit.breadthCm + 1.0) / 100, colour, gloss } });
      if (mode === "full") preset("full");
      canvas.setAttribute("aria-label", `3D mannequin, ${heightCm} cm and ${weightKg} kg, wearing EU ${fit.eu}. Drag to rotate.`);
      return body;
    },
    preset,
    resetView() { cam.auto = true; preset(mode); }
  };
}
