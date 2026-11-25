// /api/account?a=...  Customer sign-in. Email + password, or "Continue with Google".
//   GET  config            -> { google: clientId|null, ready }
//   GET  me                -> { user } or { user: null }
//   POST signup {name,email,password}     POST login {email,password}     POST google {credential}
//   POST logout            POST profile {name,phone,address}               GET orders
import { CUSTOMER_COOKIE, authConfigured, makeSession, customerFrom, cookie, clearCookie, sameOrigin, hashPassword, verifyPassword,
  passwordProblem, validEmail, normEmail, verifyGoogleIdToken, tooManyTries, noteTry, clearTries } from "../lib/auth.js";
import { sheetsConfigured } from "../lib/sheets.js";
import { findCustomer, createCustomer, saveCustomer, touchCustomer, ordersFor } from "../lib/customers.js";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const pub = (c) => ({ email: c.email, name: c.name, phone: c.phone, address: c.address, google: Boolean(c.google), hasPassword: Boolean(c.hash) });
const signIn = (c) => { const s = makeSession({ email: c.email, name: c.name }, "customer"); return json({ user: pub(c) }, 200, { "Set-Cookie": cookie(CUSTOMER_COOKIE, s.value, s.age) }); };
const ready = () => authConfigured() && sheetsConfigured();
const NOT_READY = "Accounts aren't switched on yet. You can still check out as a guest.";
const SAME_ANSWER = "That email and password don't match. Check them and try again.";

export async function GET(request) {
  const a = new URL(request.url).searchParams.get("a");
  if (a === "config") return json({ google: process.env.GOOGLE_CLIENT_ID || null, ready: ready() });
  const me = customerFrom(request);
  if (a === "me") {
    if (!me || !ready()) return json({ user: null });
    const c = await findCustomer(me.email).catch(() => null);
    return json({ user: c ? pub(c) : null });
  }
  if (a === "orders") {
    if (!me) return json({ error: "Please sign in." }, 401);
    try { return json({ orders: await ordersFor(me.email) }); } catch (e) { console.error(e); return json({ error: "We couldn't load your orders just now." }, 503); }
  }
  return json({ error: "Not found" }, 404);
}

export async function POST(request) {
  const a = new URL(request.url).searchParams.get("a");
  if (!sameOrigin(request)) return json({ error: "Please use the YOLO website to sign in." }, 403);
  if (a === "logout") return json({ ok: true }, 200, { "Set-Cookie": clearCookie(CUSTOMER_COOKIE) });
  if (!ready()) return json({ error: NOT_READY }, 503);
  let b = {}; try { b = await request.json(); } catch {}
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";
  try {
    if (a === "signup") {
      const email = normEmail(b.email), name = String(b.name || "").trim().slice(0, 80);
      if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
      const bad = passwordProblem(b.password); if (bad) return json({ error: bad }, 400);
      if (tooManyTries("su:" + ip, 10)) return json({ error: "Too many attempts. Please wait a few minutes." }, 429);
      noteTry("su:" + ip);
      if (await findCustomer(email)) return json({ error: "There's already an account with that email. Sign in instead." }, 409);
      return signIn(await createCustomer({ email, name, hash: hashPassword(b.password) }));
    }
    if (a === "login") {
      const email = normEmail(b.email); const key = "li:" + email;
      if (tooManyTries(key) || tooManyTries("ip:" + ip, 30)) return json({ error: "Too many attempts. Please wait 15 minutes and try again." }, 429);
      noteTry(key); noteTry("ip:" + ip);
      const c = await findCustomer(email);
      if (!c || !c.hash) { if (!c) hashPassword("timing-pad"); return json({ error: c && c.google ? "This account uses Google. Choose Continue with Google." : SAME_ANSWER }, 401); }
      if (!verifyPassword(b.password, c.hash)) return json({ error: SAME_ANSWER }, 401);
      clearTries(key); await touchCustomer(c);
      return signIn(c);
    }
    if (a === "google") {
      const g = await verifyGoogleIdToken(b.credential);
      if (!g) return json({ error: "Google sign-in didn't go through. Please try again." }, 401);
      let c = await findCustomer(g.email);
      if (!c) c = await createCustomer({ email: g.email, name: g.name, google: g.sub });
      else { if (!c.google) c.google = g.sub; if (!c.name) c.name = g.name; await touchCustomer(c); }
      return signIn(c);
    }
    if (a === "profile") {
      const me = customerFrom(request); if (!me) return json({ error: "Please sign in." }, 401);
      const c = await findCustomer(me.email); if (!c) return json({ error: "Account not found." }, 404);
      c.name = String(b.name ?? c.name).trim().slice(0, 80); c.phone = String(b.phone ?? c.phone).trim().slice(0, 30); c.address = String(b.address ?? c.address).trim().slice(0, 300);
      if (b.newPassword) {
        const bad = passwordProblem(b.newPassword); if (bad) return json({ error: bad }, 400);
        if (c.hash && !verifyPassword(b.currentPassword, c.hash)) return json({ error: "Your current password isn't right." }, 401);
        c.hash = hashPassword(b.newPassword);
      }
      await saveCustomer(c);
      return json({ user: pub(c) });
    }
  } catch (e) {
    console.error("account", a, e);
    return json({ error: "Something went wrong on our side. Please try again in a minute." }, 503);
  }
  return json({ error: "Not found" }, 404);
}
