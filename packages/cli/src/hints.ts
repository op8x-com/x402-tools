import { caip2, isTestNetwork, sameAddress } from "./assets.ts";
import { isObject, printFull } from "./extract.ts";
import type { Extracted, Finding } from "./types.ts";

// Challenge hints (docs/designs/2026-10-31-cli-challenge-hints-design.md): mistakes that are visible in
// the unpaid response but not in the seller's own logs. Server strings are printed only through printFull.

interface Entry {
  index: number;
  network: string;
  payTo: string;
  raw: Record<string, unknown>;
}

// Entries that are not objects, or whose network or payTo is not a string, are skipped.
function entriesOf(accepts: unknown[]): Entry[] {
  const out: Entry[] = [];
  accepts.forEach((a: unknown, index: number) => {
    if (!isObject(a) || typeof a.network !== "string" || typeof a.payTo !== "string") return;
    out.push({ index, network: a.network, payTo: a.payTo, raw: a });
  });
  return out;
}

const MAX_NETWORKS = 3;

function testnetOnly(entries: Entry[], version: 1 | 2): Omit<Finding, "method"> | undefined {
  if (entries.length === 0 || !entries.every((x) => isTestNetwork(x.network, version))) return undefined;
  const names = [...new Set(entries.map((x) => x.network))];
  let list = names.slice(0, MAX_NETWORKS).map(printFull).join(", ");
  if (names.length > MAX_NETWORKS) list += ` and ${names.length - MAX_NETWORKS} more`;
  return {
    id: "testnet-only",
    level: "warn",
    title: "Only test networks offered",
    detail: `Every payment option is on a test network: ${list}. Buyers that pay on mainnet find no option they can use. Ignore this if the endpoint is meant for testing.`,
    fix: "Add a mainnet option next to the test one, for example eip155:8453 (v1: base) with USDC.",
  };
}

function extensionsPlacement(challenge: Record<string, unknown>, entries: Entry[]): Omit<Finding, "method"> | undefined {
  if (Object.hasOwn(challenge, "extensions")) return undefined;
  const first = entries.find((x) => Object.hasOwn(x.raw, "extensions"));
  if (!first) return undefined;
  return {
    id: "extensions-placement",
    level: "warn",
    title: "extensions inside accepts[]",
    detail: `accepts[${first.index}] has an extensions field and the challenge has none at the top level. In x402 v2, extensions such as bazaar belong at the top level next to accepts; the @x402/core schema drops them inside an offer, so the Bazaar does not see them.`,
    fix: "Move extensions to the top level of the challenge, next to accepts. @x402/core puts them there when you declare extensions on the route.",
  };
}

type UrlPart = "scheme" | "host" | "path";

const trimSlash = (path: string) => (path.endsWith("/") ? path.slice(0, -1) : path);

/** The parts in which two URLs differ: scheme, host (with port), path without one trailing slash; the query is ignored. */
export function sameUrl(a: URL, b: URL): UrlPart[] {
  const parts: UrlPart[] = [];
  if (a.protocol !== b.protocol) parts.push("scheme");
  if (a.host !== b.host) parts.push("host");
  if (trimSlash(a.pathname) !== trimSlash(b.pathname)) parts.push("path");
  return parts;
}

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

const STAGING = "This is expected when you check a staging copy with production settings.";

function resourceUrlMismatch(challenge: Record<string, unknown>, url: string): Omit<Finding, "method"> | undefined {
  const resource = challenge.resource;
  if (!isObject(resource) || typeof resource.url !== "string" || resource.url === "") return undefined;
  // The "<url>" placeholder of unit tests does not parse: nothing to compare with.
  const called = parseUrl(url);
  if (!called) return undefined;
  const shown = printFull(resource.url);
  const parsed = parseUrl(resource.url);
  let detail: string;
  if (!parsed) {
    detail = `resource.url is not an absolute URL: ${shown}. ${STAGING}`;
  } else {
    const parts = sameUrl(parsed, called);
    if (parts.length === 0) return undefined;
    const notes = [
      ...(parsed.protocol === "http:" && called.protocol === "https:" ? ["The server likely sees http behind a proxy that ends TLS."] : []),
      ...(parts.includes("path") ? ["If this route serves many paths on purpose, you can ignore this."] : []),
      STAGING,
    ];
    detail = `resource.url is ${shown}; the URL checked is ${called.href}. Differs in: ${parts.join(", ")}. ${notes.join(" ")}`;
  }
  return {
    id: "resource-url-mismatch",
    level: "info",
    title: "resource.url differs from the URL checked",
    detail,
    fix: "Set the route's resource to the public URL, or let the server trust the forwarded scheme and host from the proxy. The Bazaar lists the URL from resource.url.",
  };
}

function selfPayment(entries: Entry[], version: 1 | 2, payer: string): Omit<Finding, "method"> | undefined {
  const match = entries.find((x) => sameAddress(payer, x.payTo, caip2(x.network, version)));
  if (!match) return undefined;
  return {
    id: "self-payment",
    level: "warn",
    title: "Payer is the payTo address",
    detail: `The address given with --payer is the payTo of accepts[${match.index}] (${printFull(match.network)}). Payer and receiver are the same; some facilitators reject such a payment.`,
    fix: "Test with a second wallet that is not the payTo.",
  };
}

/**
 * Hints on a 402 challenge: testnet-only, extensions-placement, resource-url-mismatch and, with a payer,
 * self-payment. Same gate as the spend rules: clients pay only on 402, so a 412 is left out.
 */
export function hintRules(e: Extracted, url: string, payer?: string): Finding[] {
  const c = e.challenge;
  if (e.status !== 402 || (e.version !== 1 && e.version !== 2) || !isObject(c)) return [];
  if (!Array.isArray(c.accepts) || c.accepts.length === 0) return [];
  const version = e.version;
  const entries = entriesOf(c.accepts);
  const found = [
    testnetOnly(entries, version),
    version === 2 ? extensionsPlacement(c, entries) : undefined,
    version === 2 ? resourceUrlMismatch(c, url) : undefined,
    payer ? selfPayment(entries, version, payer) : undefined,
  ];
  return found.filter((f) => f !== undefined).map((f) => ({ ...f, method: e.method }));
}

/** A JSON-RPC 2.0 error object, as MCP servers answer requests they reject. */
export function isJsonRpcError(body: unknown): boolean {
  return isObject(body) && body.jsonrpc === "2.0" && isObject(body.error) && Number.isInteger(body.error.code) && !("result" in body);
}

const BODY_STATUSES = [400, 409, 422];

/**
 * The POST probe (body {}) answered like body validation before the paywall. The caller skips this
 * when the responses are an MCP endpoint.
 */
export function postNeedsBody(post: Extracted, get: Extracted | undefined): Finding | undefined {
  if (post.error || post.status === undefined || !BODY_STATUSES.includes(post.status)) return undefined;
  if (post.location !== "none" || isJsonRpcError(post.body)) return undefined;
  if (get && !get.error && get.status === post.status) return undefined;
  return {
    id: "post-needs-body",
    level: "info",
    method: "POST",
    title: "POST without a usable body gets no price",
    detail: `POST with the body {} returned ${post.status} instead of 402. Likely cause: the endpoint checks the request body before asking for payment. Buyers that ask for the price with no body or an empty one (some agent wallets, and the Bazaar when no example input is declared) then never see the price.`,
    fix: "Run the payment middleware before body validation. If the route needs a body, also declare an example input so the Bazaar's probe passes.",
  };
}
