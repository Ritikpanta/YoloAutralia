// Customer accounts, kept in the "Customers" tab of the stock sheet (one row per customer).
// The password column holds a scrypt hash, never the password.
import { readTab, appendRows, writeRow, ensureTab, readOrders } from "./sheets.js";
import { normEmail } from "./auth.js";

export const CUSTOMERS_TAB = "Customers";
const H = ["Email", "Name", "Phone", "Address", "Password hash", "Google ID", "Joined (Sydney)", "Last sign-in (Sydney)"];
const sydney = () => new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney", hour12: false });
const toObj = (r) => ({ row: r._row, email: normEmail(r.Email), name: String(r.Name || ""), phone: String(r.Phone || ""), address: String(r.Address || ""),
  hash: String(r["Password hash"] || ""), google: String(r["Google ID"] || ""), joined: String(r["Joined (Sydney)"] || ""), lastSeen: String(r["Last sign-in (Sydney)"] || "") });
const toRow = (c) => [c.email, c.name, c.phone, c.address, c.hash, c.google, c.joined, c.lastSeen];

export async function listCustomers() { return (await readTab(CUSTOMERS_TAB, H)).map(toObj).filter((c) => c.email); }
export async function findCustomer(email) { return (await listCustomers()).find((c) => c.email === normEmail(email)) || null; }
export async function createCustomer(c) {
  await ensureTab(CUSTOMERS_TAB, H);
  const rec = { name: "", phone: "", address: "", hash: "", google: "", ...c, email: normEmail(c.email), joined: sydney(), lastSeen: sydney() };
  await appendRows(CUSTOMERS_TAB, [toRow(rec)]);
  return rec;
}
export async function saveCustomer(c) { await writeRow(CUSTOMERS_TAB, c.row, toRow(c)); }
export async function touchCustomer(c) { c.lastSeen = sydney(); await saveCustomer(c); }

// Web Orders rows for this email (newest first)
export async function ordersFor(email) {
  const e = normEmail(email);
  return (await readOrders()).filter((o) => normEmail(o.Email) === e && o["Stripe session"] && !String(o["Stripe session"]).includes("(stock)"))
    .map((o) => ({ date: String(o["Date (Sydney)"] || ""), items: String(o.Items || ""), total: Number(o["Total (AUD)"]) || 0, shipTo: String(o["Ship to"] || "") }))
    .reverse();
}
