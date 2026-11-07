import { neutralize, printEscaped } from "../extract.ts";
import { textTime } from "./output.ts";

// The terminal view of an op8x.metrics/1 document (op8x report without --json). It computes
// nothing; it only labels the numbers op8x sent. The document comes from the network, so every
// value is checked before it is printed:
// - strings under `data` (routes, error texts, asset addresses) are untrusted text from events
//   and go out only through printEscaped: in double quotes, escaped, at most 100 characters;
// - other strings print as they are only if they match the form the format gives them (a day,
//   a time, an id, an amount); anything else is printed escaped in the same way;
// - hint texts are op8x's own fixed sentences: printed in full, control and format characters
//   escaped;
// - a status, reason or code this version does not know is shown raw and escaped, and fields it
//   does not know are left out, so a newer document never breaks the view;
// - a value that is no string is never converted to text or serialized: where no number or
//   string of the expected form stands, only its type is printed, e.g. (object).

/** The documentation site; the definitions are at /metrics/, each finding at /findings/<id>/. */
export const DOCS_BASE = "https://docs.op8x.com";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Where values start in a row, where a block's status starts, and the width text is wrapped to. */
const VALUE_COLUMN = 29;
const STATUS_COLUMN = 56;
const WIDTH = 80;

const MISSING = "(missing)";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const AMOUNT = /^\d{1,30}(\.\d{1,30})?$/;
const SYMBOL = /^[A-Za-z0-9.]{1,16}$/;
const HINT_ID = /^[a-z][a-z0-9_]{0,31}(\.[a-z0-9_]{1,32}){1,3}$/;
const PARAM = /^[A-Za-z0-9._:-]{1,64}$/;

// --- values -----------------------------------------------------------------------------------

/** Any value of the document printed escaped: a string through printEscaped, anything else as its type only. */
function raw(v: unknown): string {
  if (v === undefined) return MISSING;
  if (typeof v === "string") return printEscaped(v);
  if (v === null) return "(null)";
  if (Array.isArray(v)) return "(array)";
  return `(${typeof v})`;
}

/** A string that matches `form` as it is; anything else escaped. */
function formed(v: unknown, form: RegExp): string {
  return typeof v === "string" && form.test(v) ? v : raw(v);
}

/** A count with thousands separators (1,380); anything but a non-negative integer escaped. */
function count(v: unknown): string {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return raw(v);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A percentage or a rate with one decimal. */
function decimal(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) : raw(v);
}

const day = (v: unknown) => formed(v, DAY);
const time = (v: unknown) => (v === null ? "never" : typeof v === "string" && TIME.test(v) ? textTime(v) : raw(v));

/** The untrusted string of `key` in a `data` map, escaped; a key without a string is named as such. */
function ref(map: unknown, key: unknown): string {
  const m = obj(map);
  if (typeof key === "string" && Object.hasOwn(m, key) && typeof m[key] === "string") return printEscaped(m[key]);
  return `(not in the report: ${raw(key)})`;
}

/**
 * The label of a status: `texts[status]`, or `texts["status/reason"]` when a reason is given. A
 * status this version does not know shows raw (`status "new_value"`), an unknown reason in brackets.
 */
function stateText(status: unknown, reason: unknown, texts: Record<string, string>): string {
  const why = reason === undefined ? "" : ` (reason ${raw(reason)})`;
  if (typeof status !== "string" || !Object.hasOwn(texts, status)) return `status ${raw(status)}${why}`;
  const plain = texts[status] as string;
  if (reason === undefined) return plain;
  if (typeof reason === "string" && Object.hasOwn(texts, `${status}/${reason}`)) return texts[`${status}/${reason}`] as string;
  return `${plain}${why}`;
}

// --- layout -----------------------------------------------------------------------------------

/** A label and its value at the value column (further values below it). */
function row(indent: number, label: string, value: string, more: string[] = []): string[] {
  const head = `${" ".repeat(indent)}${label}`;
  const first = head.length < VALUE_COLUMN ? head.padEnd(VALUE_COLUMN) + value : `${head} ${value}`;
  return [first, ...more.map((v) => " ".repeat(VALUE_COLUMN) + v)];
}

/** A block's title, with its status at the status column. */
function title(text: string, status: string | null): string {
  if (status === null) return text;
  return text.length < STATUS_COLUMN ? text.padEnd(STATUS_COLUMN) + status : `${text}  ${status}`;
}

/** Words (or list items) joined by spaces and wrapped to the width; `first` and `next` start the lines. */
function wrap(words: string[], first: string, next: string): string[] {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const w of words) {
    if (!empty && line.length + 1 + w.length > WIDTH) {
      lines.push(line);
      line = next + w;
    } else {
      line = empty ? line + w : `${line} ${w}`;
    }
    empty = false;
  }
  lines.push(line);
  return lines;
}

// --- labels -----------------------------------------------------------------------------------

const LIVENESS: Record<string, string> = {
  ok: "ok",
  silent: "silent (no events in 24 hours)",
  quiet: "quiet (fewer active days)",
  test_only: "test events only",
  none: "no events yet",
};

const COPIES = "partial: too many copies to check";
const FUNNEL: Record<string, string> = { partial: "partial", "partial/too_many_copies": COPIES };
const RATIO: Record<string, string> = {
  ok: "ok",
  insufficient_data: "not enough data",
  partial: "partial",
  "partial/too_many_copies": COPIES,
};
const REVENUE: Record<string, string> = {
  ok: "ok",
  insufficient_data: "not enough data",
  "insufficient_data/no_paid_payments": "no paid payments yet",
  partial: "partial",
  "partial/unsummed_payments": "partial: some payments are not in the sum",
  "partial/too_many_copies": COPIES,
};
const walletTexts = (since: unknown): Record<string, string> => ({
  ok: "ok",
  insufficient_data: "not enough data",
  "insufficient_data/no_paid_payments": "no paid payments yet",
  unavailable: "unavailable",
  "unavailable/no_salt": "unavailable: no salt set (run npx @op8x/cli init)",
  "unavailable/too_many_payers": "unavailable: too many wallets to count",
  partial: "partial",
  "partial/salt_changed": `partial: salt changed on ${day(since)}`,
  "partial/too_many_copies": COPIES,
});
const DATA_BASIS: Record<string, string> = { no_known_gaps: "no known gaps", known_gaps: "known gaps" };
const NETWORK: Record<string, string> = { mainnet: "mainnet", testnet: "testnet", unknown: "unknown network" };
const INCOMPLETE: Record<string, string> = { daily_cap: "daily cap", retention: "older than retention" };
const NOT_VISIBLE: Record<string, string> = {
  key_refused_401: "refused keys (401)",
  overload_503: "overload (503)",
  aborted: "aborted requests",
  oversize_413: "oversize (413)",
  disk_guard_429: "disk guard (429)",
  restart_counter_loss: "counter loss on restart",
  collector_downtime: "op8x outages are not included",
  module_without_key: "modules without key",
  module_timeouts: "module timeouts",
};

/** A known code's label, or the code raw and escaped. */
const label = (texts: Record<string, string>, v: unknown) => (typeof v === "string" && Object.hasOwn(texts, v) ? (texts[v] as string) : raw(v));

/** A ratio {value, numerator, denominator} with its status; `paid` is paid per 100 offers, else a share in percent. */
function ratio(v: unknown, kind: "paid" | "share"): string {
  const r = obj(v);
  const n = count(r.numerator);
  const d = count(r.denominator);
  if (kind === "paid" && r.status === "insufficient_data") {
    const few = `too few offers (${d} of 20 needed)`;
    return r.reason === undefined || r.reason === "denominator_below_20" ? few : `${few} (reason ${raw(r.reason)})`;
  }
  let text: string;
  if (kind === "paid") text = typeof r.value === "number" ? `${decimal(r.value)} (${n} of ${d})` : `${n} of ${d}`;
  else text = typeof r.value === "number" ? `${decimal(r.value)} % (${n} of ${d})` : `${n} of ${d} (too few for a percentage)`;
  if (r.status === undefined || (r.status === "ok" && r.reason === undefined)) return text;
  return `${text} · ${stateText(r.status, r.reason, RATIO)}`;
}

// --- blocks -----------------------------------------------------------------------------------

interface Finding {
  hint: Obj;
  /** The route a finding belongs to, as printed. */
  where: string | null;
}

function header(doc: Obj): string {
  const w = obj(doc.window);
  const days = typeof w.days === "number" && Number.isSafeInteger(w.days) ? (w.days === 1 ? "last 1 day" : `last ${w.days} days`) : `last ${raw(w.days)} days`;
  const today = w.partial_today === true ? ", today so far" : "";
  return `op8x report · ${days} (${day(w.from)} to ${day(w.to)}, ${formed(w.timezone, /^UTC$/)}${today})`;
}

function liveness(doc: Obj, findings: Finding[]): string[] {
  const l = obj(doc.liveness);
  for (const h of arr(l.hints)) findings.push({ hint: obj(h), where: null });
  return [
    title("Is my API sending data?", stateText(l.status, l.reason, LIVENESS)),
    ...row(2, "Last event", time(l.last_event_at)),
    ...row(2, "Events today", count(l.events_today)),
    ...row(2, "Events last 24 hours", count(l.events_last_24h)),
    ...row(2, "Active days (previous 7)", `${count(l.active_days_prev_7)} of 7`),
  ];
}

function attempts(byNetwork: unknown): string[] {
  const nets = arr(byNetwork).map(obj);
  if (nets.length === 0) return row(4, "Payment attempts", "none");
  const lines = row(4, "Payment attempts", nets.map((n) => `${label(NETWORK, n.kind)} ${count(n.attempts)}`).join(" · "));
  for (const n of nets) {
    const head = `      ${label(NETWORK, n.kind)}: `;
    const marker = n.attempts_with_test_marker;
    const marked = marker === undefined || marker === 0 ? "" : ` · marked as test ${count(marker)}`;
    lines.push(
      `${head}paid ${count(n.paid)} · possibly paid ${count(n.possibly_paid)} · rejected ${count(n.rejected)} · no confirmation ${count(n.no_confirmation)} (with a new price offer: ${count(n.no_confirmation_402)})`,
      `${" ".repeat(head.length)}delivered ${count(n.delivered)} · not delivered ${count(n.not_delivered)} · delivery unknown ${count(n.delivery_unknown)}${marked}`,
    );
  }
  return lines;
}

function route(v: unknown, data: Obj, findings: Finding[]): string[] {
  const r = obj(v);
  const name = ref(data.routes, r.route_ref);
  for (const h of arr(r.hints)) findings.push({ hint: obj(h), where: name });
  const lines = [
    `  ${name}`,
    ...row(4, "Unpaid requests", count(r.requests_unpaid)),
    ...row(4, "Price offers (402)", `${count(r.offers)}   from x402 clients: ${ratio(r.offers_x402_ua, "share")}`),
    ...attempts(r.by_network),
    ...row(4, "Paid per 100 offers", ratio(r.paid_per_100_offers, "paid")),
  ];
  const texts = arr(r.text_refs).map((t) => ref(data.texts, t));
  if (texts.length > 0) lines.push(...row(4, "Error texts", texts[0] as string, texts.slice(1)));
  return lines;
}

function funnel(doc: Obj, data: Obj, findings: Finding[]): string[] {
  const f = obj(doc.funnel);
  const routes = arr(f.routes);
  const lines = [title("Buyers on the way to paying (per route)", f.status === undefined ? null : stateText(f.status, f.reason, FUNNEL))];
  if (routes.length === 0) lines.push(...row(2, "Routes", "none yet"));
  for (const r of routes) lines.push(...route(r, data, findings));
  lines.push(...row(2, "Other requests", count(f.other_requests)), ...row(2, "More routes not shown", count(f.routes_truncated)));
  return lines;
}

function wallets(doc: Obj, findings: Finding[]): string[] {
  const w = obj(doc.wallets);
  for (const h of arr(w.hints)) findings.push({ hint: obj(h), where: null });
  return [
    title("Wallets", w.status === "ok" ? null : stateText(w.status, w.reason, walletTexts(w.since))),
    ...row(2, "Paying wallets", `${count(w.paying)} since ${day(w.since)}`),
    ...row(2, "Payments", `${count(w.payments)} (without wallet id: ${count(w.payments_without_payer)})`),
    ...row(2, "Returning wallets", ratio(w.returning, "share")),
  ];
}

function revenue(doc: Obj, data: Obj, findings: Finding[]): string[] {
  const r = obj(doc.revenue_reported);
  for (const h of arr(r.hints)) findings.push({ hint: obj(h), where: null });
  const lines = [title("Revenue (as reported by payments)", r.status === "ok" ? null : stateText(r.status, r.reason, REVENUE))];
  const assets = arr(r.by_asset);
  if (assets.length === 0) lines.push(...row(2, "Amounts", "none"));
  for (const v of assets) {
    const a = obj(v);
    const payments = a.payments === 1 ? "payment" : "payments";
    lines.push(
      ...row(2, formed(a.symbol, SYMBOL), `${formed(a.amount, AMOUNT)} from ${count(a.payments)} ${payments}   declared test amount ${formed(a.declared_test_amount, AMOUNT)}`),
    );
  }
  lines.push(
    `  Without amount ${count(r.payments_without_amount)} · unknown asset ${count(r.payments_unknown_asset)} · unknown network ${count(r.payments_unknown_network)} · testnet ${count(r.payments_testnet)}`,
  );
  const unknown = arr(r.unknown_asset_refs).map((a) => ref(data.assets, a));
  if (unknown.length > 0) lines.push(...row(2, "Unknown assets", unknown[0] as string, unknown.slice(1)));
  return lines;
}

function dataBasis(doc: Obj, findings: Finding[]): string[] {
  const b = obj(doc.data_basis);
  for (const h of arr(b.hints)) findings.push({ hint: obj(h), where: null });
  const ex = obj(b.excluded_events);
  const days = arr(b.incomplete_days).map((v) => {
    const d = obj(v);
    return `${day(d.day)} (${label(INCOMPLETE, d.reason)})`;
  });
  const lines = [
    title("Data basis", stateText(b.status, b.reason, DATA_BASIS)),
    ...row(2, "Left out as tests", `${count(ex.total)} (op8x checks ${count(ex.op8x_marker)} · declared tests ${count(ex.purchase_class)})`),
    ...row(2, "Attempts marked as test", count(b.attempts_with_test_marker)),
    ...row(2, "Incomplete days", days.length === 0 ? "none" : (days[0] as string), days.slice(1)),
    `  Dropped (daily cap) ${count(b.discarded_cap)} · dropped (invalid) ${count(b.discarded_invalid)} · unreadable ${count(b.undecodable)} · odd timestamps ${count(b.out_of_range_timestamps)}`,
  ];
  if (b.copies_not_removed === true) lines.push("  Copies not removed (too many to check)");
  const items = arr(b.not_visible).map((c) => label(NOT_VISIBLE, c));
  const listed = items.map((t, i) => (i < items.length - 1 ? `${t},` : t));
  const first = "  Not visible to op8x".padEnd(VALUE_COLUMN);
  lines.push(...(listed.length === 0 ? row(2, "Not visible to op8x", "none listed") : wrap(listed, first, " ".repeat(VALUE_COLUMN))));
  return lines;
}

/** A hint's fixed text in full, its {params} filled in; control and format characters escaped. */
function hintText(h: Obj): string {
  const params = obj(h.params);
  const text = typeof h.text === "string" ? neutralize(h.text) : raw(h.text);
  return text.replace(/\{([a-z_]{1,32})\}/g, (m, k: string) => (Object.hasOwn(params, k) ? formed(params[k], PARAM) : m));
}

function findingLines(findings: Finding[]): string[] {
  if (findings.length === 0) return ["Findings", "  none"];
  const lines = ["Findings"];
  findings.forEach(({ hint, where }, i) => {
    if (i > 0) lines.push("");
    const plain = typeof hint.hint_id === "string" && HINT_ID.test(hint.hint_id);
    const id = plain ? (hint.hint_id as string) : raw(hint.hint_id);
    lines.push(`  ! ${id}${where === null ? "" : `  ${where}`}`);
    lines.push(...wrap(hintText(hint).split(" ").filter((w) => w !== ""), "    ", "    "));
    if (plain) lines.push(`    ${DOCS_BASE}/findings/${id}/`);
  });
  return lines;
}

/** The terminal view of an op8x.metrics/1 document, ending with a newline. */
export function renderReportView(doc: Record<string, unknown>): string {
  const data = obj(doc.data);
  const findings: Finding[] = [];
  const blocks = [
    [header(doc)],
    liveness(doc, findings),
    funnel(doc, data, findings),
    wallets(doc, findings),
    revenue(doc, data, findings),
    dataBasis(doc, findings),
    findingLines(findings),
    [`Definitions: ${DOCS_BASE}/metrics/ (definitions ${day(doc.definitions_version)})`],
  ];
  return `${blocks.map((b) => b.join("\n")).join("\n\n")}\n`;
}
