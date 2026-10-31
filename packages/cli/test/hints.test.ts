import { test } from "node:test";
import assert from "node:assert/strict";
import { hintRules, isJsonRpcError, postNeedsBody, sameUrl } from "../src/hints.ts";
import { extract } from "../src/extract.ts";
import { b64, pr, v1, v1main, v2, v2main } from "./fixtures.ts";
import type { Finding } from "../src/types.ts";

const NS = { "cache-control": "no-store" };
const CALLED = "https://api.example.com/weather";
const STAGING = "This is expected when you check a staging copy with production settings.";

// A challenge as a client reads it: v2 in the header, v1 in the body.
const at = (challenge: unknown, status = 402) =>
  extract(pr("GET", status, { ...NS, "payment-required": b64(challenge) }, {}));
const atBody = (challenge: unknown, status = 402) => extract(pr("GET", status, NS, challenge));
const ids = (fs: Finding[]) => fs.map((f) => f.id);
const find = (fs: Finding[], id: string) => fs.find((f) => f.id === id);
const entry = (network: string, extra: Record<string, unknown> = {}) => ({ ...v2.accepts[0], network, ...extra });
const withAccepts = (accepts: unknown[]) => ({ ...v2, accepts });

// Gate

test("gate: a mainnet challenge on 402 gives no hints", () => {
  assert.deepEqual(hintRules(at(v2main), CALLED), []);
  assert.deepEqual(hintRules(atBody(v1main), CALLED), []);
});

test("gate: a 412 permit2_allowance_required answer gives no hints", () => {
  assert.deepEqual(hintRules(at({ ...v2, error: "permit2_allowance_required" }, 412), CALLED), []);
});

test("gate: a 200 with a challenge-shaped body gives no hints", () => {
  assert.deepEqual(hintRules(atBody(v1, 200), CALLED), []);
  assert.deepEqual(hintRules(at(v2, 200), CALLED), []);
});

test("gate: a challenge without x402Version gives no hints", () => {
  const { x402Version: _, ...noVersion } = v2;
  assert.deepEqual(hintRules(at(noVersion), CALLED), []);
});

test("gate: empty or invalid accepts entries give no hints", () => {
  assert.deepEqual(hintRules(at(withAccepts([])), CALLED), []);
  assert.deepEqual(hintRules(at({ ...v2, accepts: "x" }), CALLED), []);
  assert.deepEqual(hintRules(at(withAccepts([null, "x", 5, { network: 5, payTo: "a" }, { network: "eip155:84532" }])), CALLED), []);
});

// testnet-only

test("testnet-only: a v2 challenge on Base Sepolia only", () => {
  const fs = hintRules(at(v2), CALLED);
  assert.deepEqual(ids(fs), ["testnet-only"]);
  assert.deepEqual(fs[0], {
    id: "testnet-only",
    level: "warn",
    method: "GET",
    title: "Only test networks offered",
    detail:
      "Every payment option is on a test network: eip155:84532. Buyers that pay on mainnet find no option they can use. Ignore this if the endpoint is meant for testing.",
    fix: "Add a mainnet option next to the test one, for example eip155:8453 (v1: base) with USDC.",
  });
});

test("testnet-only: a v1 name in a v1 challenge fires, in a v2 challenge it stays silent", () => {
  assert.match(find(hintRules(atBody(v1), CALLED), "testnet-only")?.detail ?? "", /test network: base-sepolia\. /);
  assert.equal(find(hintRules(at(withAccepts([entry("base-sepolia")])), CALLED), "testnet-only"), undefined);
});

test("testnet-only: mixed mainnet and testnet entries stay silent", () => {
  const c = withAccepts([entry("eip155:84532"), v2main.accepts[0]]);
  assert.equal(find(hintRules(at(c), CALLED), "testnet-only"), undefined);
});

test("testnet-only: an unknown network stays silent", () => {
  assert.equal(find(hintRules(at(withAccepts([entry("eip155:999999")])), CALLED), "testnet-only"), undefined);
  assert.equal(find(hintRules(at(withAccepts([entry("eip155:84532"), entry("eip155:421614")])), CALLED), "testnet-only"), undefined);
});

test("testnet-only: invalid entries are skipped, valid test entries still fire", () => {
  const c = withAccepts([null, { network: "eip155:8453" }, entry("eip155:84532")]);
  assert.match(find(hintRules(at(c), CALLED), "testnet-only")?.detail ?? "", /test network: eip155:84532\. /);
});

test("testnet-only: 1,000 test entries name at most 3 networks, deduplicated in order", () => {
  const nets = ["eip155:84532", "eip155:11155111", "eip155:43113", "eip155:80002", "eip155:1328"];
  const c = withAccepts(Array.from({ length: 1000 }, (_, i) => entry(nets[i % nets.length])));
  const d = find(hintRules(at(c), CALLED), "testnet-only")?.detail ?? "";
  assert.match(d, /^Every payment option is on a test network: eip155:84532, eip155:11155111, eip155:43113 and 2 more\. Buyers/);
});

// extensions-placement

const EXT = { bazaar: { discoverable: true } };
const EXT_TITLE = "extensions inside accepts[]";

test("extensions-placement: extensions only inside accepts[0]", () => {
  const f = find(hintRules(at(withAccepts([entry("eip155:8453", { extensions: EXT })])), CALLED), "extensions-placement");
  assert.deepEqual(f, {
    id: "extensions-placement",
    level: "warn",
    method: "GET",
    title: EXT_TITLE,
    detail:
      "accepts[0] has an extensions field and the challenge has none at the top level. In x402 v2, extensions such as bazaar belong at the top level next to accepts; the @x402/core schema drops them inside an offer, so the Bazaar does not see them.",
    fix: "Move extensions to the top level of the challenge, next to accepts. @x402/core puts them there when you declare extensions on the route.",
  });
});

test("extensions-placement: names the first such index", () => {
  const c = withAccepts([entry("eip155:8453"), entry("eip155:8453", { extensions: EXT }), entry("eip155:8453", { extensions: EXT })]);
  assert.match(find(hintRules(at(c), CALLED), "extensions-placement")?.detail ?? "", /^accepts\[1\] has/);
});

test("extensions-placement: silent at top level, in both places, and in v1", () => {
  assert.equal(find(hintRules(at({ ...v2main, extensions: EXT }), CALLED), "extensions-placement"), undefined);
  const both = { ...withAccepts([entry("eip155:8453", { extensions: EXT })]), extensions: EXT };
  assert.equal(find(hintRules(at(both), CALLED), "extensions-placement"), undefined);
  const inV1 = { ...v1main, accepts: [{ ...v1main.accepts[0], extensions: EXT }] };
  assert.equal(find(hintRules(atBody(inV1), CALLED), "extensions-placement"), undefined);
});

// resource-url-mismatch

const withUrl = (url: unknown) => ({ ...v2main, resource: { ...v2main.resource, url } });
const urlHint = (url: unknown, called = CALLED) => find(hintRules(at(withUrl(url)), called), "resource-url-mismatch");

test("resource-url-mismatch: http behind a proxy", () => {
  assert.deepEqual(urlHint("http://api.example.com/weather"), {
    id: "resource-url-mismatch",
    level: "info",
    method: "GET",
    title: "resource.url differs from the URL checked",
    detail: `resource.url is http://api.example.com/weather; the URL checked is https://api.example.com/weather. Differs in: scheme. The server likely sees http behind a proxy that ends TLS. ${STAGING}`,
    fix: "Set the route's resource to the public URL, or let the server trust the forwarded scheme and host from the proxy. The Bazaar lists the URL from resource.url.",
  });
});

test("resource-url-mismatch: other host, other path, all three", () => {
  assert.equal(
    urlHint("https://staging.example.com/weather")?.detail,
    `resource.url is https://staging.example.com/weather; the URL checked is https://api.example.com/weather. Differs in: host. ${STAGING}`,
  );
  assert.equal(urlHint("https://api.example.com:8443/weather")?.detail.includes("Differs in: host."), true);
  assert.equal(
    urlHint("https://api.example.com/forecast")?.detail,
    `resource.url is https://api.example.com/forecast; the URL checked is https://api.example.com/weather. Differs in: path. If this route serves many paths on purpose, you can ignore this. ${STAGING}`,
  );
  assert.match(
    urlHint("http://other.example.com/x")?.detail ?? "",
    /Differs in: scheme, host, path\. The server likely sees http behind a proxy that ends TLS\. If this route serves many paths on purpose, you can ignore this\. This is expected/,
  );
});

test("resource-url-mismatch: https vs http in the other direction names the scheme, not the proxy", () => {
  const d = urlHint("https://api.example.com/weather", "http://api.example.com/weather")?.detail ?? "";
  assert.match(d, /Differs in: scheme\. This is expected/);
});

test("resource-url-mismatch: one trailing slash and the query are ignored", () => {
  assert.equal(urlHint("https://api.example.com/weather/"), undefined);
  assert.equal(urlHint("https://api.example.com/weather?city=berlin"), undefined);
  assert.equal(urlHint("https://API.example.com:443/weather"), undefined);
  assert.equal(urlHint("https://api.example.com/weather", `${CALLED}/?x=1`), undefined);
});

test("resource-url-mismatch: a relative resource.url fires", () => {
  assert.equal(urlHint("/weather")?.detail, `resource.url is not an absolute URL: /weather. ${STAGING}`);
});

test("resource-url-mismatch: non-string or empty resource.url, or no resource object, stays silent", () => {
  assert.equal(urlHint(42), undefined);
  assert.equal(urlHint(""), undefined);
  assert.equal(find(hintRules(at({ ...v2main, resource: "x" }), CALLED), "resource-url-mismatch"), undefined);
});

test("resource-url-mismatch: the placeholder called URL stays silent", () => {
  assert.equal(urlHint("http://other.example.com/x", "<url>"), undefined);
});

test("resource-url-mismatch: v1 stays silent", () => {
  const c = { ...v1main, resource: { url: "http://other.example.com/x" } };
  assert.equal(find(hintRules(atBody(c), CALLED), "resource-url-mismatch"), undefined);
});

test("resource-url-mismatch: control characters are escaped and a 10,000-character URL is capped", () => {
  const d = urlHint(`https://evil.example.com/\u001b[31m\u202e${"a".repeat(10000)}`)?.detail ?? "";
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u202e]/.test(d), false);
  const printed = d.slice("resource.url is ".length, d.indexOf("; the URL checked"));
  assert.ok(printed.endsWith("\u2026"));
  assert.ok(Array.from(printed).length <= 101);
  assert.match(d, /Differs in: host, path\./);
});

test("resource-url-mismatch: a trailing no-break space is printed escaped, not trimmed", () => {
  assert.equal(
    urlHint(`${CALLED}\u00A0`)?.detail,
    `resource.url is https://api.example.com/weather\\u{00A0}; the URL checked is https://api.example.com/weather. Differs in: path. If this route serves many paths on purpose, you can ignore this. ${STAGING}`,
  );
});

test("resource-url-mismatch: a zero-width space in the path is printed escaped, not removed", () => {
  assert.equal(
    urlHint("https://api.example.com/wea\u200Bther")?.detail,
    `resource.url is https://api.example.com/wea\\u{200B}ther; the URL checked is https://api.example.com/weather. Differs in: path. If this route serves many paths on purpose, you can ignore this. ${STAGING}`,
  );
});

test("resource-url-mismatch: a resource.url of format characters only is printed escaped, not as (empty)", () => {
  assert.equal(urlHint("\u200B\u2060")?.detail, `resource.url is not an absolute URL: \\u{200B}\\u{2060}. ${STAGING}`);
});

test("resource-url-mismatch: a Cyrillic look-alike host is printed escaped and named as host", () => {
  const d = urlHint("https://\u0430pi.example.com/weather")?.detail ?? "";
  assert.ok(d.startsWith("resource.url is https://\\u{0430}pi.example.com/weather; "));
  assert.match(d, /Differs in: host\. This is expected/);
});

test("resource-url-mismatch: a difference only after character 100 is named as path", () => {
  const called = `https://api.example.com/${"a".repeat(120)}`;
  const d = urlHint(`${called}b`, called)?.detail ?? "";
  assert.match(d, /Differs in: path\. If this route/);
});

test("sameUrl lists the differing parts in order", () => {
  const u = (s: string) => new URL(s);
  assert.deepEqual(sameUrl(u("https://a.example/x"), u("https://a.example/x/")), []);
  assert.deepEqual(sameUrl(u("http://b.example/y"), u("https://a.example/x")), ["scheme", "host", "path"]);
  assert.deepEqual(sameUrl(u("https://a.example:8443/x"), u("https://a.example/x")), ["host"]);
  assert.deepEqual(sameUrl(u("https://a.example/"), u("https://a.example")), []);
});

// self-payment

const PAYTO = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_PAYTO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const selfPay = (e: ReturnType<typeof at>, payer?: string) => find(hintRules(e, CALLED, payer), "self-payment");

test("self-payment: payer equal to payTo with other letter case on eip155:8453", () => {
  const c = withAccepts([entry("eip155:8453", { asset: v2main.accepts[0].asset, payTo: PAYTO })]);
  assert.deepEqual(selfPay(at(c), PAYTO.toLowerCase()), {
    id: "self-payment",
    level: "warn",
    method: "GET",
    title: "Payer is the payTo address",
    detail:
      "The address given with --payer is the payTo of accepts[0] (eip155:8453). Payer and receiver are the same; some facilitators reject such a payment.",
    fix: "Test with a second wallet that is not the payTo.",
  });
});

test("self-payment: v1 name base compares EVM addresses without case", () => {
  const c = { ...v1main, accepts: [{ ...v1main.accepts[0], payTo: PAYTO }] };
  assert.match(selfPay(atBody(c), PAYTO.toUpperCase().replace("0X", "0x"))?.detail ?? "", /payTo of accepts\[0\] \(base\)\. /);
});

test("self-payment: Solana addresses compare exactly", () => {
  const c = withAccepts([entry(SOL, { payTo: SOL_PAYTO })]);
  assert.match(selfPay(at(c), SOL_PAYTO)?.detail ?? "", /payTo of accepts\[0\] \(solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp\)\. /);
  assert.equal(selfPay(at(c), SOL_PAYTO.toLowerCase()), undefined);
});

test("self-payment: a different payer or no payer stays silent", () => {
  const c = withAccepts([entry("eip155:8453", { payTo: PAYTO })]);
  assert.equal(selfPay(at(c), "0x2222222222222222222222222222222222222222"), undefined);
  assert.equal(selfPay(at(c)), undefined);
  assert.equal(selfPay(at(c), ""), undefined);
});

test("self-payment: one finding at most, naming the first matching index", () => {
  const c = withAccepts([entry("eip155:8453"), entry("eip155:8453", { payTo: PAYTO }), entry("eip155:1", { payTo: PAYTO })]);
  const fs = hintRules(at(c), CALLED, PAYTO).filter((f) => f.id === "self-payment");
  assert.equal(fs.length, 1);
  assert.match(fs[0].detail, /payTo of accepts\[1\] \(eip155:8453\)\. /);
});

// post-needs-body

const post = (status: number, body?: unknown, headers: Record<string, string> = {}) => extract(pr("POST", status, headers, body));
const get = (status: number, body?: unknown) => extract(pr("GET", status, {}, body));
const failedGet = () => extract({ method: "GET", url: "u", headers: {}, bodyText: "", ms: 1, error: "fetch failed (ETIMEDOUT)" });
const rpcError = { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null };

test("post-needs-body: POST 422 plain JSON with GET 405", () => {
  assert.deepEqual(postNeedsBody(post(422, { error: "query is required" }), get(405)), {
    id: "post-needs-body",
    level: "info",
    method: "POST",
    title: "POST without a usable body gets no price",
    detail:
      "POST with the body {} returned 422 instead of 402. Likely cause: the endpoint checks the request body before asking for payment. Buyers that ask for the price with no body or an empty one (some agent wallets, and the Bazaar when no example input is declared) then never see the price.",
    fix: "Run the payment middleware before body validation. If the route needs a body, also declare an example input so the Bazaar's probe passes.",
  });
});

test("post-needs-body: 400 and 409 fire too, other statuses do not", () => {
  assert.match(postNeedsBody(post(400, { error: "bad" }), get(405))?.detail ?? "", /returned 400 instead/);
  assert.match(postNeedsBody(post(409), get(405))?.detail ?? "", /returned 409 instead/);
  for (const s of [401, 403, 404, 405, 406, 415, 500]) assert.equal(postNeedsBody(post(s), undefined), undefined, String(s));
});

test("post-needs-body: GET failed at network level or not probed still fires", () => {
  assert.ok(postNeedsBody(post(422, { error: "x" }), failedGet()));
  assert.ok(postNeedsBody(post(422, { error: "x" }), undefined));
});

test("post-needs-body: GET with the same status stays silent", () => {
  assert.equal(postNeedsBody(post(422, { error: "x" }), get(422)), undefined);
});

test("post-needs-body: GET 402 still fires (the verb-mismatch case)", () => {
  assert.ok(postNeedsBody(post(422), at(v2main)));
});

test("post-needs-body: POST 400 with a challenge stays silent", () => {
  assert.equal(postNeedsBody(post(400, {}, { ...NS, "payment-required": b64(v2main) }), get(405)), undefined);
  assert.equal(postNeedsBody(post(400, v1main), get(405)), undefined);
});

test("post-needs-body: POST 400 JSON-RPC error stays silent", () => {
  assert.equal(postNeedsBody(post(400, rpcError), get(405)), undefined);
});

test("post-needs-body: a failed POST stays silent", () => {
  const failed = extract({ method: "POST", url: "u", headers: {}, bodyText: "", ms: 1, error: "fetch failed" });
  assert.equal(postNeedsBody(failed, get(405)), undefined);
});

test("isJsonRpcError: only a JSON-RPC 2.0 error object", () => {
  assert.equal(isJsonRpcError(rpcError), true);
  assert.equal(isJsonRpcError({ ...rpcError, id: 7 }), true);
  assert.equal(isJsonRpcError({ ...rpcError, jsonrpc: "1.0" }), false);
  assert.equal(isJsonRpcError({ ...rpcError, error: { code: 1.5 } }), false);
  assert.equal(isJsonRpcError({ ...rpcError, result: {} }), false);
  assert.equal(isJsonRpcError([rpcError]), false);
  assert.equal(isJsonRpcError(undefined), false);
});
