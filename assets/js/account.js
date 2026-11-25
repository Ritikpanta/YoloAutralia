/* Customer account page: sign in / create account (email + password, or Google), then orders and saved details.
   No admin anything here: the store admin lives on a separate, unlinked page with Google-only sign-in. */
const root = document.getElementById("account-root");
const title = document.querySelector('[data-o="title"]');
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const aud = (n) => "A$" + Number(n || 0).toFixed(2).replace(/\.00$/, "");
const api = async (a, body) => {
  const res = await fetch(`/api/account?a=${a}`, body === undefined ? { credentials: "same-origin" } :
    { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
};

let cfg = { google: null, ready: false };

async function boot() {
  try { cfg = await api("config"); } catch {}
  const me = await api("me").catch(() => ({ user: null }));
  me.user ? showAccount(me.user) : showSignIn("login");
}

function googleButton(host) {
  if (!cfg.google) return;
  const draw = () => {
    window.google.accounts.id.initialize({
      client_id: cfg.google, ux_mode: "popup",
      callback: async ({ credential }) => {
        try { const d = await api("google", { credential }); showAccount(d.user); } catch (e) { setMsg(e.message); }
      }
    });
    window.google.accounts.id.renderButton(host, { theme: "outline", size: "large", shape: "pill", text: "continue_with", width: 320 });
  };
  if (window.google?.accounts?.id) return draw();
  const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = draw;
  document.head.append(s);
}
let setMsg = () => {};

function showSignIn(mode) {
  title.textContent = mode === "login" ? "Sign in" : "Create an account";
  document.title = `${title.textContent} — YOLO Australia`;
  if (!cfg.ready) {
    root.innerHTML = `<div class="acct-card"><p class="lede">Accounts are coming soon. You can still order as a guest: everything works without an account.</p><a class="btn btn-primary" href="/shop">Shop all</a></div>`;
    return;
  }
  root.innerHTML = `
    <div class="acct-grid">
      <form class="form acct-card" novalidate>
        <div class="acct-tabs" role="tablist">
          <button type="button" role="tab" aria-selected="${mode === "login"}" data-m="login">Sign in</button>
          <button type="button" role="tab" aria-selected="${mode === "signup"}" data-m="signup">Create account</button>
        </div>
        ${cfg.google ? `<div class="acct-google" data-o="g"></div><p class="acct-or"><span>or with email</span></p>` : ""}
        ${mode === "signup" ? `<label>Name <input name="name" autocomplete="name" required></label>` : ""}
        <label>Email <input name="email" type="email" autocomplete="email" required></label>
        <label>Password <input name="password" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="10" required></label>
        ${mode === "signup" ? `<p class="fineprint">At least 10 characters. A short phrase is easy to remember and hard to guess.</p>` : ""}
        <p class="acct-msg" role="alert" data-o="msg"></p>
        <button class="btn btn-primary btn-block" type="submit">${mode === "login" ? "Sign in" : "Create account"}</button>
        ${mode === "login" ? `<p class="fineprint">Forgot your password? <a href="/contact">Message us</a> and we'll send you a temporary one, or use Continue with Google if your account uses a Google email.</p>` : `<p class="fineprint">We keep your name, email and saved address to make checkout faster and show your orders. We never see your card details.</p>`}
      </form>
      <div class="acct-side">
        <h3>Why an account?</h3>
        <ul><li>See your orders in one place</li><li>Save your phone and delivery address</li><li>Your email is filled in at checkout</li></ul>
        <p class="fineprint">You don't need an account to buy. Guest checkout works the same.</p>
      </div>
    </div>`;
  const form = root.querySelector("form"), msg = root.querySelector('[data-o="msg"]');
  setMsg = (t) => { msg.textContent = t; };
  root.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => showSignIn(b.dataset.m)));
  const g = root.querySelector('[data-o="g"]'); if (g) googleButton(g);
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); setMsg("");
    const f = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
    try { const d = await api(mode, f); showAccount(d.user); }
    catch (err) { setMsg(err.message); }
    finally { btn.disabled = false; }
  });
}

async function showAccount(user) {
  title.textContent = user.name ? `Hi ${user.name.split(" ")[0]}` : "Your account";
  document.title = "Your account — YOLO Australia";
  const label = document.querySelector('[data-o="acct"]'); if (label) label.textContent = (user.name || "").split(" ")[0] || "Account";
  root.innerHTML = `
    <div class="acct-grid">
      <section class="acct-card">
        <h2 class="acct-h">Your orders</h2>
        <div data-o="orders"><p class="fineprint">Loading your orders…</p></div>
      </section>
      <form class="form acct-card" novalidate>
        <h2 class="acct-h">Your details</h2>
        <label>Name <input name="name" autocomplete="name" value="${esc(user.name)}"></label>
        <label>Email <input value="${esc(user.email)}" disabled></label>
        <label>Phone <input name="phone" type="tel" autocomplete="tel" value="${esc(user.phone)}"></label>
        <label>Delivery address <textarea name="address" autocomplete="street-address" rows="3">${esc(user.address)}</textarea></label>
        <details class="acct-pw"><summary>${user.hasPassword ? "Change password" : "Add a password"}</summary>
          ${user.hasPassword ? `<label>Current password <input name="currentPassword" type="password" autocomplete="current-password"></label>` : ""}
          <label>New password <input name="newPassword" type="password" autocomplete="new-password" minlength="10"></label>
        </details>
        <p class="acct-msg" role="status" data-o="msg"></p>
        <div class="acct-actions"><button class="btn btn-primary" type="submit">Save details</button><button class="btn" type="button" data-a="out">Sign out</button></div>
      </form>
    </div>`;
  const form = root.querySelector("form"), msg = root.querySelector('[data-o="msg"]');
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); msg.textContent = "";
    try { const d = await api("profile", Object.fromEntries(new FormData(form))); msg.textContent = "Saved."; form.querySelectorAll('[type="password"]').forEach((i) => { i.value = ""; }); title.textContent = d.user.name ? `Hi ${d.user.name.split(" ")[0]}` : "Your account"; }
    catch (err) { msg.textContent = err.message; }
  });
  root.querySelector('[data-a="out"]').addEventListener("click", async () => {
    await api("logout", {}).catch(() => {});
    window.google?.accounts?.id?.disableAutoSelect?.();
    const label = document.querySelector('[data-o="acct"]'); if (label) label.textContent = "Sign in";
    showSignIn("login");
  });
  const box = root.querySelector('[data-o="orders"]');
  try {
    const { orders } = await api("orders");
    box.innerHTML = orders.length ? `<ul class="acct-orders">${orders.map((o) => `
      <li><div><strong>${esc(o.date.split(",")[0])}</strong><span>${esc(o.items)}</span></div><b>${aud(o.total)}</b></li>`).join("")}</ul>`
      : `<p class="fineprint">No orders yet. Orders made with ${esc(user.email)} show up here, including ones you placed as a guest.</p><a class="btn" href="/shop">Shop all</a>`;
  } catch (e) { box.innerHTML = `<p class="fineprint">${esc(e.message)}</p>`; }
}

boot();
