/* Size maths for the fit panel: foot length (measured, or estimated from height) -> EU size, shoe inside
   length and toe room; the footprint outline used by the to-scale foot drawing. No 3D, no dependencies. */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export const bmiOf = (heightCm, weightKg) => weightKg / Math.pow(heightCm / 100, 2);

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

const STYLE_BY_SLUG = {
  "axel-penny": "loafer", "retro-vegan": "loafer", "vegan-penny-loafer": "loafer", "monarch-loafers": "loafer", "duke": "loafer",
  "polo-horsebit-loafers": "loafer", "pattern-penny": "loafer",
  "eden": "derby", "volt": "derby", "eton": "derby", "hampton": "derby", "odin": "derby",
  "capri": "sneaker", "vista": "sneaker", "essential-vegan": "sneaker", "series-001": "sneaker", "series-003": "sneaker", "series-005": "sneaker",
  "monaco": "slipon", "summerset": "slipon", "heritage": "slipon", "amber": "slipon", "monks": "slipon", "series-006": "slipon",
  "atlas-chelseaboots": "chelsea", "zane-zipper-boot": "zip", "builder-boots": "work"
};
// how pointed each style's toe is (footprint exponent)
const POINT = { loafer: 1.7, derby: 1.55, sneaker: 2.2, slipon: 2.2, chelsea: 1.8, zip: 1.8, work: 2.6 };
export function styleFor(product) {
  return STYLE_BY_SLUG[product.slug] || ({ loafers: "loafer", formals: "derby", sneakers: "sneaker", boots: "chelsea" }[product.category]) || "loafer";
}
export const toePoint = (product) => POINT[styleFor(product)] || 1.8;

// half-width of the footprint at u (0 = heel, 1 = toe), as a fraction of half the breadth
export function footprint(u, point) {
  if (u < 0.12) return 0.78 * Math.sqrt(Math.max(0, u / 0.12)) + 0.02;
  if (u < 0.45) return lerp(0.80, 0.88, (u - 0.12) / 0.33);
  if (u < 0.72) return lerp(0.88, 1.0, smooth((u - 0.45) / 0.27));
  const t = (u - 0.72) / 0.28;
  return Math.max(0.02, Math.pow(Math.max(0, 1 - Math.pow(t, point)), 1 / point));
}
