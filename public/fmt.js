// Formatting, icons and channel identity — the vocabulary every view shares.
//
// Pure functions over values. No data access, no DOM writes, so these are the
// cheapest things here to reason about and the safest to reuse.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id, size = 16) =>
  `<svg class="icon" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
// Postgres numeric and bigint arrive over JSON as strings, so every figure is
// coerced before it is formatted. "0.1914" must not render as "0.1914%".
const pct = (x, dp = 1) => {
  if (x == null || x === "") return "—";
  const n = Number(x);
  return Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : "—";
};
const num = (v) => {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : "—";
};
const plural = (n, one, many = `${one}s`) => `${num(n)} ${Number(n) === 1 ? one : many}`;

const CHANNEL = {
  email: { icon: "mail", cls: "email", label: "Email", colour: "var(--ch-email)" },
  sms:   { icon: "sms",  cls: "sms",   label: "SMS",   colour: "var(--ch-sms)" },
};
const chan = (c) => CHANNEL[c] ?? { icon: "chat", cls: "", label: c ?? "—", colour: "var(--n-400)" };
const chanChip = (c) => {
  const k = chan(c);
  return `<span class="chip ${k.cls}">${icon(k.icon, 12)} ${esc(k.label)}</span>`;
};

function timeAgo(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const fmtTime = (iso) => iso
  ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
const fmtDay = (iso) => iso
  ? new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "—";
/** "08-20" from an ISO date string, without letting the local timezone shift it. */
const dayTick = (ymd) => String(ymd ?? "").slice(5);

/**
 * Undo JSON escaping that reached the database as literal text.
 *
 * 7 of the 142 stored inbound bodies contain the characters backslash-u-2-0-1-C
 * rather than a curly quote, and 7 contain a literal backslash-n rather than a
 * newline — the reply payload was stringified once too often on the way in. A
 * reader should not have to decode that by eye, so it is undone here.
 *
 * This is a rendering plaster, not the fix: the ingest path is where the
 * double-encoding happens and where it should be corrected. Decoding on read
 * is safe in the meantime because the output is inserted as text, never HTML.
 */
function decodeStored(text) {
  if (typeof text !== "string" || !text.includes("\\")) return text;
  // One pass, so an escaped backslash cannot be mistaken for the start of an
  // escape sequence.
  return text.replace(/\\(u[0-9a-fA-F]{4}|[nrtbf"'\/\\])/g, (m, g) => {
    if (g[0] === "u") return String.fromCharCode(parseInt(g.slice(1), 16));
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[g] ?? g;
  });
}

/** "converted_to_opp" -> "Converted to opp". The raw key stays alongside it, so
    nothing is lost by making the headline readable. */
const humanOutcome = (t) => {
  if (!t) return "outcome";
  const w = String(t).replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};

export {
  $, esc, icon, pct, num, plural, CHANNEL, chan, chanChip,
  timeAgo, fmtTime, fmtDay, dayTick, decodeStored, humanOutcome,
};
