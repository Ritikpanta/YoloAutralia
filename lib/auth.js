// Sign-in for customers and admins. No dependencies: node:crypto only.
// - Sessions are signed cookies (HMAC-SHA256 with SESSION_SECRET), HttpOnly, Secure, SameSite=Lax.
// - Customer passwords are hashed with scrypt (random salt per password); plain passwords are never stored.
// - "Continue with Google" ID tokens are verified against Google's published keys (aud = GOOGLE_CLIENT_ID).
// - Admins can only sign in with Google, and only with an email listed in ADMIN_EMAILS. The list is re-checked
//   on every admin request, so removing an email from Vercel locks that person out at once.
import crypto from "node:crypto";

export const CUSTOMER_COOKIE = "yolo_s";
export const ADMIN_COOKIE = "yolo_admin";
const CUSTOMER_AGE = 60 * 60 * 24 * 30;   // 30 days
const ADMIN_AGE = 60 * 60 * 10;           // 10 hours

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET is not set (needs at least 32 characters)");
  return s;
}
export const authConfigured = () => Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32);

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(e)) && normEmail(e).length <= 200;

export function adminEmails() {
  return String(process.env.ADMIN_EMAILS || "").split(/[,\s;]+/).map(normEmail).filter(Boolean);
}
export const isAdminEmail = (e) => adminEmails().includes(normEmail(e));

// ---------- passwords ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${b64u(salt)}$${b64u(hash)}`;
}
export function verifyPassword(pw, stored) {
  const [kind, n, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = unb64u(hash);
  const got = crypto.scryptSync(String(pw), unb64u(salt), want.length, { N: Number(n) || SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export function passwordProblem(pw) {
  pw = String(pw || "");
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That password is too long.";
  if (/^(.)\1+$/.test(pw) || /^(password|1234567890|qwertyuiop)/i.test(pw)) return "Please choose a less guessable password.";
  return null;
}

// ---------- sessions ----------
function sign(data) { return b64u(crypto.createHmac("sha256", secret()).update(data).digest()); }
export function makeSession(payload, role) {
  const age = role === "admin" ? ADMIN_AGE : CUSTOMER_AGE;
  const body = b64u(JSON.stringify({ ...payload, role, exp: Math.floor(Date.now() / 1000) + age }));
  return { value: `${body}.${sign(body)}`, age };
}
export function readSession(request, name) {
  if (!authConfigured()) return null;
  const raw = (request.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  if (!raw) return null;
  const [body, sig] = raw.slice(name.length + 1).split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body)); const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(unb64u(body).toString("utf8"));
    if (!s.exp || s.exp < Date.now() / 1000) return null;
    return s;
  } catch { return null; }
}
export function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export const clearCookie = (name) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// Admin session that is still valid AND whose email is still on the list
export function adminFrom(request) {
  const s = readSession(request, ADMIN_COOKIE);
  return s && s.role === "admin" && isAdminEmail(s.email) ? s : null;
}
export function customerFrom(request) {
  const s = readSession(request, CUSTOMER_COOKIE);
  return s && s.role === "customer" ? s : null;
}

// Changes must come from our own pages (blocks cross-site form posts on top of SameSite cookies)
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return request.method === "GET";
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

// ---------- Google ID tokens ----------
let jwks = { at: 0, keys: [] };
async function googleKeys() {
  if (jwks.keys.length && Date.now() - jwks.at < 3600_000) return jwks.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error("Couldn't fetch Google keys");
  jwks = { at: Date.now(), keys: (await res.json()).keys || [] };
  return jwks.keys;
}
export async function verifyGoogleIdToken(token) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not set");
  const [h, p, s] = String(token || "").split(".");
  if (!h || !p || !s) return null;
  let header, claims;
  try { header = JSON.parse(unb64u(h)); claims = JSON.parse(unb64u(p)); } catch { return null; }
  if (header.alg !== "RS256") return null;
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const ok = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(crypto.createPublicKey({ key: jwk, format: "jwk" }), unb64u(s));
  if (!ok) return null;
  const now = Date.now() / 1000;
  if (claims.aud !== clientId || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) return null;
  if (!(claims.exp > now - 30) || !claims.email || claims.email_verified !== true) return null;
  return { sub: claims.sub, email: normEmail(claims.email), name: claims.name || "" };
}

// ---------- simple brute-force brake (per server instance) ----------
const tries = new Map();
export function tooManyTries(key, max = 8, windowMs = 15 * 60_000) {
  const now = Date.now(); const t = (tries.get(key) || []).filter((x) => now - x < windowMs);
  tries.set(key, t);
  return t.length >= max;
}
export function noteTry(key) { const t = tries.get(key) || []; t.push(Date.now()); tries.set(key, t); }
export function clearTries(key) { tries.delete(key); }
