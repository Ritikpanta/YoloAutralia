/* Geometry for the 3D try-on: a sculpted unisex mannequin, an oversized tee and wide-leg
   trousers, all built from signed-distance fields and meshed with surface nets.
   Pure maths, no three.js, so it runs in a Web Worker and the page stays smooth while it builds.

   Body: ellipsoids and tapered capsules for each muscle group, blended with a smooth union, in
   units of stature H. Weight drives one build factor s: every girth is multiplied by s^e
   (e = how much that region gains with weight: waist and belly most, wrists and head least) and s
   is solved by bisection so the mesh's measured volume equals V = weight / 1010 kg/m³.
   Clothes are sculpted around the body: a boxy tee that hangs from the chest, drop-shoulder
   sleeves, gravity folds and drag lines; wide-leg trousers with vertical drape and a hem break. */

export const RHO = 1010;                       // kg/m³, average whole-body density
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ---------- signed-distance primitives (iq) ----------
const smax = (a, b, k) => -smin(-a, -b, k);
const smin = (a, b, k) => { if (k <= 0) return Math.min(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
function sdEll(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const qx = px / rx, qy = py / ry, qz = pz / rz;
  const k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  return k0 * (k0 - 1) / Math.max(k1, 1e-9);
}
function sdRoundCone(x, y, z, a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const pax = x - a[0], pay = y - a[1], paz = z - a[2];
  const yy = pax * bax + pay * bay + paz * baz, zz = yy - l2;
  const xvx = pax * l2 - bax * yy, xvy = pay * l2 - bay * yy, xvz = paz * l2 - baz * yy;
  const x2 = xvx * xvx + xvy * xvy + xvz * xvz, y2 = yy * yy * l2, z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}
function sdCappedCone(x, y, z, a, b, ra, rb) {
  const rba = rb - ra, bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const baba = bax * bax + bay * bay + baz * baz;
  const pax = x - a[0], pay = y - a[1], paz = z - a[2];
  const papa = pax * pax + pay * pay + paz * paz, paba = (pax * bax + pay * bay + paz * baz) / baba;
  const xx = Math.sqrt(Math.max(0, papa - paba * paba * baba));
  const cax = Math.max(0, xx - (paba < 0.5 ? ra : rb)), cay = Math.abs(paba - 0.5) - 0.5;
  const k = rba * rba + baba, f = clamp((rba * (xx - ra) + paba * baba) / k, 0, 1);
  const cbx = xx - ra - f * rba, cby = paba - f;
  const s = cbx < 0 && cay < 0 ? -1 : 1;
  return s * Math.sqrt(Math.min(cax * cax + cay * cay * baba, cbx * cbx + cby * cby * baba));
}

// a primitive with a bounding sphere, so far-away parts are skipped quickly
const ell = (c, r, k) => ({ k, cx: c[0], cy: c[1], cz: c[2], R: Math.max(r[0], r[1], r[2]), f: (x, y, z) => sdEll(x, y, z, c[0], c[1], c[2], r[0], r[1], r[2]) });
const cone = (a, b, r1, r2, k) => {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return { k, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, cz: (a[2] + b[2]) / 2, R: L / 2 + Math.max(r1, r2), f: (x, y, z) => sdRoundCone(x, y, z, a, b, r1, r2) };
};
function evalPrims(prims, x, y, z) {
  let d = 1e9;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i], dx = x - p.cx, dy = y - p.cy, dz = z - p.cz;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R > d + p.k) continue;
    d = smin(d, p.f(x, y, z), p.k);
  }
  return d;
}

/* The unisex body, stature = 1. x = the figure's left, y up, z forward.
   Landmarks (fractions of stature): hip joint 0.505, knee 0.285, ankle 0.04, elbow 0.632,
   wrist 0.49, shoulder joint 0.78, chin 0.87. */
function bodyPrims(s, foot) {
  const g = (e) => Math.pow(s, e);
  const belly = 0.012 * Math.max(0, s - 1);                    // the belly moves forward with weight
  const P = [
    ell([0, 0.535, -0.01], [0.088 * g(1.3), 0.07, 0.068 * g(1.3)], 0.03),            // pelvis
    ell([0, 0.615, 0.002 + belly], [0.078 * g(1.5), 0.075, 0.062 * g(1.6)], 0.04),   // abdomen / waist
    ell([0, 0.705, -0.004], [0.092 * g(1.1), 0.1, 0.066 * g(1.15)], 0.04),           // ribcage
    ell([0, 0.772, -0.012], [0.098 * g(1.0), 0.04, 0.055 * g(1.0)], 0.03),           // upper chest / shoulder girdle
    cone([0, 0.79, -0.014], [0, 0.872, 0.0], 0.034 * g(0.6), 0.029 * g(0.5), 0.022), // neck
    ell([0, 0.937, 0.004], [0.05, 0.064, 0.058], 0.022),                              // cranium
    ell([0, 0.896, 0.017], [0.041, 0.037, 0.043], 0.026)                              // jaw
  ];
  for (const sx of [1, -1]) {
    const X = (v) => v * sx;
    P.push(
      ell([X(0.04), 0.505, -0.03], [0.054 * g(1.3), 0.062, 0.05 * g(1.35)], 0.025),               // glute
      cone([X(0.03), 0.818, -0.022], [X(0.1), 0.8, -0.012], 0.03 * g(0.9), 0.028 * g(0.9), 0.03), // trapezius
      ell([X(0.104), 0.783, -0.006], [0.031 * g(1.0), 0.042, 0.037 * g(1.0)], 0.022),             // deltoid
      cone([X(0.11), 0.78, -0.006], [X(0.143), 0.632, -0.012], 0.032 * g(1.05), 0.024 * g(0.9), 0.012), // upper arm
      ell([X(0.128), 0.705, 0.004], [0.027 * g(1.05), 0.052, 0.03 * g(1.05)], 0.016),             // biceps
      cone([X(0.143), 0.632, -0.012], [X(0.157), 0.545, 0.008], 0.024 * g(0.9), 0.025 * g(0.75), 0.016), // forearm (muscle)
      cone([X(0.157), 0.545, 0.008], [X(0.165), 0.49, 0.018], 0.025 * g(0.75), 0.016 * g(0.5), 0.016),  // forearm (wrist)
      ell([X(0.169), 0.452, 0.022], [0.012 * g(0.3), 0.034, 0.028 * g(0.3)], 0.014),              // palm
      cone([X(0.169), 0.44, 0.024], [X(0.166), 0.398, 0.02], 0.011, 0.008, 0.012),               // fingers
      cone([X(0.165), 0.472, 0.042], [X(0.162), 0.444, 0.052], 0.009, 0.007, 0.01),               // thumb
      cone([X(0.05), 0.505, 0.0], [X(0.05), 0.29, 0.004], 0.054 * g(1.2), 0.035 * g(0.9), 0.03),   // thigh
      ell([X(0.062), 0.42, 0.004], [0.05 * g(1.2), 0.1, 0.055 * g(1.15)], 0.03),                  // quadriceps
      ell([X(0.051), 0.284, 0.012], [0.034 * g(0.9), 0.03, 0.031 * g(0.9)], 0.015),               // knee
      cone([X(0.051), 0.28, -0.002], [X(0.052), 0.045, -0.008], 0.033 * g(0.85), 0.017 * g(0.6), 0.02), // shin
      ell([X(0.053), 0.205, -0.016], [0.034 * g(0.85), 0.075, 0.032 * g(0.85)], 0.02),            // calf
      ell([X(0.052), foot.cy, foot.cz], [foot.rx, foot.ry, foot.rz], 0.018)                         // foot (inside the shoe)
    );
  }
  return P;
}

// ---------- meshing: surface nets on a signed-distance field ----------
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = []; for (let c = 0; c < 8; c++) for (const bit of [1, 2, 4]) if (!(c & bit)) EDGES.push([c, c | bit]);
function surfaceNets(f, lo, hi, step) {
  const nx = Math.ceil((hi[0] - lo[0]) / step) + 1, ny = Math.ceil((hi[1] - lo[1]) / step) + 1, nz = Math.ceil((hi[2] - lo[2]) / step) + 1;
  const sxy = nx * ny, F = new Float32Array(nx * ny * nz);
  // coarse pass, then evaluate exactly only near the surface
  const C = 4, cnx = Math.floor((nx - 1) / C) + 1, cny = Math.floor((ny - 1) / C) + 1, cnz = Math.floor((nz - 1) / C) + 1;
  const G = new Float32Array(cnx * cny * cnz);
  for (let k = 0; k < cnz; k++) for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++)
    G[i + j * cnx + k * cnx * cny] = f(lo[0] + i * C * step, lo[1] + j * C * step, lo[2] + k * C * step);
  const thr = C * step * 2.6;
  for (let k = 0; k < nz; k++) {
    const ck = Math.min(cnz - 1, Math.round(k / C)), z = lo[2] + k * step;
    for (let j = 0; j < ny; j++) {
      const cj = Math.min(cny - 1, Math.round(j / C)), y = lo[1] + j * step;
      for (let i = 0; i < nx; i++) {
        const gv = G[Math.min(cnx - 1, Math.round(i / C)) + cj * cnx + ck * cnx * cny];
        F[i + j * nx + k * sxy] = Math.abs(gv) > thr ? gv : f(lo[0] + i * step, y, z);
      }
    }
  }
  const cxn = nx - 1, cyn = ny - 1, cell = (i, j, k) => i + j * cxn + k * cxn * cyn;
  const vid = new Int32Array(cxn * cyn * (nz - 1)).fill(-1);
  const pos = [], v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const o = CORNERS[c]; v[c] = F[(i + o[0]) + (j + o[1]) * nx + (k + o[2]) * sxy]; if (v[c] < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let ax = 0, ay = 0, az = 0, n = 0;
    for (const [a, b] of EDGES) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]), A = CORNERS[a], B = CORNERS[b];
      ax += A[0] + (B[0] - A[0]) * t; ay += A[1] + (B[1] - A[1]) * t; az += A[2] + (B[2] - A[2]) * t; n++;
    }
    vid[cell(i, j, k)] = pos.length / 3;
    pos.push(lo[0] + (i + ax / n) * step, lo[1] + (j + ay / n) * step, lo[2] + (k + az / n) * step);
  }
  const idx = [];
  const quad = (a, b, c, d) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; idx.push(a, b, c, a, c, d); };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v0 = F[i + j * nx + k * sxy] < 0;
    if (v0 !== (F[i + 1 + j * nx + k * sxy] < 0)) quad(vid[cell(i, j - 1, k - 1)], vid[cell(i, j, k - 1)], vid[cell(i, j, k)], vid[cell(i, j - 1, k)]);
    if (v0 !== (F[i + (j + 1) * nx + k * sxy] < 0)) quad(vid[cell(i - 1, j, k - 1)], vid[cell(i - 1, j, k)], vid[cell(i, j, k)], vid[cell(i, j, k - 1)]);
    if (v0 !== (F[i + j * nx + (k + 1) * sxy] < 0)) quad(vid[cell(i - 1, j - 1, k)], vid[cell(i, j - 1, k)], vid[cell(i, j, k)], vid[cell(i - 1, j, k)]);
  }
  // project vertices onto the surface; normals from the field's gradient; fix triangle winding
  const P = new Float32Array(pos), N = new Float32Array(P.length), e = step * 0.35;
  const grad = (x, y, z, out) => {
    const a = f(x + e, y - e, z - e), b = f(x - e, y - e, z + e), c = f(x - e, y + e, z - e), d = f(x + e, y + e, z + e);
    out[0] = a - b - c + d; out[1] = -a - b + c + d; out[2] = -a + b - c + d;
    const l = Math.hypot(out[0], out[1], out[2]) || 1; out[0] /= l; out[1] /= l; out[2] /= l;
  };
  const gv = [0, 0, 0];
  for (let i = 0; i < P.length; i += 3) {
    grad(P[i], P[i + 1], P[i + 2], gv);
    const d = clamp(f(P[i], P[i + 1], P[i + 2]), -step, step);
    P[i] -= gv[0] * d; P[i + 1] -= gv[1] * d; P[i + 2] -= gv[2] * d;
    grad(P[i], P[i + 1], P[i + 2], gv); N[i] = gv[0]; N[i + 1] = gv[1]; N[i + 2] = gv[2];
  }
  // drop tiny disconnected fragments (union-find over triangle vertices)
  const parent = new Int32Array(P.length / 3).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < idx.length; t += 3) { const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]); parent[b] = a; parent[find(c)] = a; }
  const size = new Int32Array(parent.length); for (let i = 0; i < parent.length; i++) size[find(i)]++;
  const keep = []; for (let t = 0; t < idx.length; t += 3) if (size[find(idx[t])] > 300) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  const I = new Uint32Array(keep);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx2 = uy * vz - uz * vy, ny2 = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
    if (nx2 * (N[a] + N[b] + N[c]) + ny2 * (N[a + 1] + N[b + 1] + N[c + 1]) + nz2 * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) { const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp; }
  }
  return { P, N, I };
}

// volume enclosed by the field (voxel count), in units of stature³
function fieldVolume(f, lo, hi, step) {
  let n = 0;
  for (let z = lo[2] + step / 2; z < hi[2]; z += step) for (let y = lo[1] + step / 2; y < hi[1]; y += step) for (let x = lo[0] + step / 2; x < hi[0]; x += step) if (f(x, y, z) < 0) n++;
  return n * step * step * step;
}

// Scale every vertex from stature units to metres.
function toMetres(m, H) { for (let i = 0; i < m.P.length; i++) m.P[i] *= H; return m; }

/* opts: { heightCm, weightKg, fit (from footAndShoe), st (shoe style: sole, heel, collar, boot) }
   returns the build factor, volumes, placement values and three meshes in metres. */
export function buildFigure({ heightCm, weightKg, fit, st, draft = false, sKnown = null }) {
    const H = heightCm / 100;
    // foot, in stature units, from the measured / estimated foot (slightly slimmer than the shoe)
    const fL = fit.footCm / 100 / H, fB = fit.breadthCm / 100 / H;
    const foot = { rx: fB * 0.36, ry: 0.011, rz: fL * 0.42, cy: 0.013, cz: -0.022 + fL * 0.42 };

    // build factor: bisection on the measured volume of the body field
    const lo = [-0.22, -0.01, -0.14], hi = [0.22, 1.01, 0.16];
    const targetV = weightKg / RHO / (H * H * H);
    const volAt = (s) => { const pr = bodyPrims(s, foot); return fieldVolume((x, y, z) => evalPrims(pr, x, y, z), lo, hi, draft ? 0.024 : 0.0145); };
    let s = sKnown;
    if (!s) {
    // start from a bracket around the BMI-based guess, then bisect
    const guess = Math.pow(weightKg / (H * H) / 22, 0.62) * 0.93;
    let a = clamp(guess - 0.12, 0.72, 1.9), b = clamp(guess + 0.12, 0.72, 1.9);
    if (volAt(a) > targetV) a = 0.72; if (volAt(b) < targetV) b = 1.9;
    for (let i = 0; i < (draft ? 6 : 8); i++) { const m = (a + b) / 2; if (volAt(m) < targetV) a = m; else b = m; }
      s = (a + b) / 2;
    }
    const prims = bodyPrims(s, foot);
    const B = (x, y, z) => evalPrims(prims, x, y, z);
    const g = (e) => Math.pow(s, e);
    const step = draft ? 0.0085 : 0.0048;

    // ---- body ----
    const body = surfaceNets(B, [-0.2 - 0.02 * (s - 1), -0.005, -0.13 - 0.03 * (s - 1)], [0.2 + 0.02 * (s - 1), 1.008, 0.15 + 0.04 * (s - 1)], step);
    {
      const P = body.P, col = new Float32Array(P.length);
      for (let i = 0; i < P.length; i += 3) {
        const x = Math.abs(P[i]), y = P[i + 1], z = P[i + 2];
        const hand = smooth((x - 0.15) / 0.012) * smooth((0.5 - y) / 0.012);
        const face = smooth((y - 0.868) / 0.01) * smooth((z - 0.004) / 0.012);
        const c = lerp(0.56, 0.035, Math.max(hand, face));
        col[i] = c; col[i + 1] = c; col[i + 2] = c * 1.01;
      }
      body.col = col;
    }

    // ---- oversized tee ----
    const hem = 0.468, ex = 0.092 * g(1.1) + 0.042, ez = 0.066 * g(1.15) + 0.034 + 0.6 * 0.012 * Math.max(0, s - 1), cz = 0.0;
    const sleeve = [1, -1].map((sx) => ({ a: [0.088 * sx, 0.786, -0.008], b: [0.133 * sx, 0.668, -0.004], r: 0.03 * g(1.05) + 0.016 }));
    const Tee = (x, y, z) => {
      let d = Math.abs(x) > 0.155 ? 1 : Math.max(B(x, y, z) - 0.011, Math.min(Math.abs(x) - 0.113, Math.max(0.745 - y, Math.abs(x) - 0.15)));     // torso, plus the shoulder caps
      // crew neck opening, a little lower at the front
      const neckY = 0.792 - 0.016 * smooth((z + 0.005) / 0.04);
      d = smax(d, -smax(Math.hypot(x, z + 0.006) - 0.049, neckY - y, 0.012), 0.01);
      // boxy body: hangs straight from the chest, slight flare to the hem
      const fl = 1 + Math.max(0, 0.69 - y) * 0.1;
      const q = Math.hypot(x / (ex * fl), (z - cz) / (ez * fl));
      const tube = smax((q - 1) * Math.min(ex, ez) * fl, y - 0.75, 0.07);
      d = smin(d, tube, 0.045);
      // drop-shoulder short sleeves
      for (const sl of sleeve) {
        const cyl = sdCappedCone(x, y, z, sl.a, sl.b, sl.r - 0.005, sl.r - 0.002) - 0.005;   // rounded sleeve hem
        d = smin(d, cyl, 0.03);
      }
      d = smax(d, hem - y, 0.008);
      // folds: gravity folds below the chest, drag lines from the armpits, soft creases on the sleeves
      const th = Math.atan2(z - cz, x);
      // a few long, soft vertical folds that relax toward the hem
      d += 0.0022 * Math.sin(th * 5 + 0.7 * Math.sin(y * 14)) * smooth((0.7 - y) / 0.12);
      // rib collar: a rounded band around the neckline
      { const nr = Math.hypot(x, z + 0.006) - 0.051, ny = y - (0.792 - 0.016 * smooth((z + 0.005) / 0.04)) - 0.004;
        d = smin(d, Math.hypot(nr, ny) - 0.007, 0.007); }
      // hem band: the last 2 cm sit slightly proud, with a crisp edge
      d -= 0.0012 * smooth((hem + 0.021 - y) / 0.003);
      const ax = Math.abs(x) - 0.088, ay = y - 0.71;
      d += 0.0009 * Math.sin((y + Math.abs(x) * 0.9) * 110) * Math.exp(-(ax * ax + ay * ay) / 0.0012);
      d += 0.0006 * Math.sin(y * 140 + Math.abs(x) * 40) * smooth((Math.abs(x) - 0.105) / 0.02) * smooth((y - 0.66) / 0.02);
      return d;
    };
    const tee = surfaceNets(Tee, [-0.215 - 0.03 * (s - 1), hem - 0.008, -0.13 - 0.03 * (s - 1)], [0.215 + 0.03 * (s - 1), 0.85, 0.15 + 0.05 * (s - 1)], step);
    const topM = 0.792 * H + 0.02;
    {
      const P = tee.P, N = tee.N;
      // print mapping: front & back halves of a 2048×1024 canvas = 0.8 m × 0.8 m each
      const uv = new Float32Array(P.length / 3 * 2);
      for (let i = 0, j = 0; i < P.length; i += 3, j += 2) {
        const um = (P[i] * H) / 0.8, vm = (P[i + 1] * H - topM) / 0.8;
        uv[j] = N[i + 2] >= 0 ? 0.25 + um * 0.5 : 0.75 - um * 0.5; uv[j + 1] = 1 + vm;
      }
      tee.uv = uv;
      // soft occlusion: under the arms, inside the sleeves' shadow, and just above the hem
      const col = new Float32Array(P.length);
      for (let i = 0; i < P.length; i += 3) {
        const x = Math.abs(P[i]), y = P[i + 1];
        const pit = Math.exp(-(((x - 0.095) ** 2) + ((y - 0.69) ** 2)) / 0.0011);
        const side = smooth((x - 0.1) / 0.03) * smooth((0.66 - y) / 0.05);
        const c = 1 - 0.32 * pit - 0.12 * side - 0.08 * smooth((hem + 0.02 - y) / 0.02);
        col[i] = col[i + 1] = col[i + 2] = c;
      }
      tee.col = col;
    }

    // ---- wide-leg trousers ----
    const lift = st.sole + st.heel * 0.7 - 0.003 * H;                     // metres: stand on the insole
    const hemGround = st.boot ? 0.075 : Math.max(0.05, st.collar * 0.95);  // trouser hem height above the floor (m)
    const pHem = clamp((hemGround - lift) / H, 0.012, 0.08);
    const legTop = 0.054 * g(1.2) + 0.016, legHem = 0.046 + 0.006 * Math.max(0, s - 1);
    const Pants = (x, y, z) => {
      let seat = y < 0.37 || y > 0.65 || Math.abs(x) > 0.16 ? 1 : B(x, y, z) - 0.0105;
      seat = smax(smax(Math.max(seat, Math.abs(x) - 0.128), y - 0.618, 0.01), 0.4 - y, 0.03);
      let legs = 1e9;
      for (const sx of [1, -1]) {
        let L = sdCappedCone(x, y, z, [0.058 * sx, 0.5, -0.006], [0.062 * sx, pHem - 0.01, 0.006], legTop, legHem);
        L = Math.max(L, -sx * x);
        legs = Math.min(legs, L);
      }
      let d = smin(seat, legs, 0.03);
      d = smax(d, pHem - y, 0.008);
      // vertical drape folds, and a soft break where the hem meets the shoe
      const sx = x >= 0 ? 1 : -1, th = Math.atan2(z, x - 0.06 * sx);
      d += 0.0014 * Math.sin(th * 4 + 1.5 * Math.sin(y * 12 + sx)) * smooth((0.42 - y) / 0.3);
      // pressed crease down the front of each leg
      { const da = th - Math.PI / 2; d -= 0.0016 * Math.exp(-(da * da) / 0.012) * smooth((0.47 - y) / 0.05); }
      // a gentle break where the hem rests on the shoe
      d -= 0.0018 * Math.exp(-(((y - pHem - 0.03) / 0.012) ** 2)) * Math.max(0, Math.sin(th));
      d += 0.0006 * Math.sin((y - Math.abs(x) * 0.6) * 160) * smooth((y - 0.44) / 0.02) * smooth((0.5 - y) / 0.03); // crotch whiskers
      return d;
    };
    const pants = surfaceNets(Pants, [-0.15 - 0.03 * (s - 1), pHem - 0.006, -0.13 - 0.03 * (s - 1)], [0.15 + 0.03 * (s - 1), 0.63, 0.14 + 0.04 * (s - 1)], step);


    const Lm = fit.outerCm / 100;
    const heelZ = (foot.cz - foot.rz) * H - (Lm - fit.footCm / 100) * 0.35;
    return {
      s, lift, heelZ, H,
      bmi: weightKg / (H * H), targetL: weightKg / RHO * 1000, volumeL: volAt(s) * H * H * H * 1000,
      body: toMetres(body, H), tee: toMetres(tee, H), pants: toMetres(pants, H)
    };
}
