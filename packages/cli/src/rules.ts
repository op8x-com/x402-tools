import { PaymentRequiredV1Schema, PaymentRequiredV2Schema } from "@x402/core/schemas";
import { officialClientCanRead } from "./extract.ts";
import type { Extracted, Finding, Level, Method, PreflightResult } from "./types.ts";

// Hint map for v2 endpoints still using v1 network names (EVM networks only).
const LEGACY_TO_CAIP2: Record<string, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
  polygon: "eip155:137",
  "polygon-amoy": "eip155:80002",
  avalanche: "eip155:43114",
  "avalanche-fuji": "eip155:43113",
};

// Flows defined in core spec v2, section 6.1. Clients must skip any other value.
const PAYMENT_FLOWS: unknown[] = ["authorization", "upfront", "escrow"];

// Mechanisms whose default flow is not "authorization" (specs/schemes in x402 at 4241d56).
function defaultFlow(scheme: unknown, network: unknown): string {
  const namespace = typeof network === "string" ? network.split(":")[0] : "";
  if (scheme === "auth-capture") return "escrow";
  if (scheme === "upto" && namespace === "solana") return "escrow";
  if (scheme === "exact" && namespace === "lnbtc") return "upfront";
  return "authorization";
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function is402(e: Extracted): boolean {
  if (e.status === 402) return true;
  return e.status === 412 && isObj(e.challenge) && e.challenge.error === "permit2_allowance_required";
}

export function diffPaths(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  const container = (v: unknown): v is Obj => typeof v === "object" && v !== null;
  if (!container(a) || !container(b) || Array.isArray(a) !== Array.isArray(b)) return [path || "(root)"];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diffPaths(a[k], b[k], path ? `${path}.${k}` : k));
}

function statusHint(status: number | undefined): string {
  if (status === 200) return "The resource is served without payment (not paywalled).";
  if (status === 401 || status === 403) return "Authentication or a firewall (WAF) blocks the request before x402 runs.";
  if (status === 404) return "Wrong path: the resource was not found.";
  if (status !== undefined && status >= 500) return "The server failed; check its logs.";
  return "Return 402 with a challenge for unpaid requests.";
}

function methodRules(e: Extracted): Finding[] {
  const out: Finding[] = [];
  const add = (id: string, level: Level, title: string, detail: string, fix?: string) => {
    out.push({ id, level, method: e.method, title, detail, ...(fix ? { fix } : {}) });
  };

  if (e.error) {
    add("request-failed", "error", "Request failed", e.error, "Check that the URL is reachable from the public internet.");
    return out;
  }
  if (e.status !== undefined && e.status >= 300 && e.status < 400) {
    add(
      "redirect",
      "warn",
      `Redirect (${e.status})`,
      `Location: ${e.redirectTo ?? "(none)"}`,
      "Serve the 402 challenge at the final URL; many clients do not follow redirects before paying.",
    );
    return out;
  }
  if (!is402(e)) return out;

  if (e.headerError === "not-base64") {
    add(
      "header-not-base64",
      "error",
      "PAYMENT-REQUIRED header is not standard base64",
      `Value starts with: ${(e.headerRaw ?? "").slice(0, 40)}`,
      "Encode the JSON challenge with standard base64 (A-Z a-z 0-9 + / =): no base64url, no whitespace.",
    );
  }
  if (e.headerError === "not-json") {
    add(
      "header-not-json",
      "error",
      "PAYMENT-REQUIRED header does not decode to JSON",
      "The header is valid base64, but the decoded text is not JSON.",
      "The header must be base64 of the JSON challenge object.",
    );
  }
  if (e.headerRaw === undefined && isObj(e.bodyChallenge) && e.bodyChallenge.x402Version === 2) {
    add(
      "v2-body-only",
      "error",
      "v2 challenge only in the response body",
      "The body contains an x402Version 2 challenge, but the PAYMENT-REQUIRED header is missing. The official v2 client reads v2 challenges only from the header and fails before signing.",
      "Send the challenge in the PAYMENT-REQUIRED header (base64 JSON). A body copy is optional.",
    );
  }
  if (e.location === "none") {
    add(
      "no-challenge",
      "error",
      "402 without a readable challenge",
      "Neither a PAYMENT-REQUIRED header nor a JSON challenge in the body was found.",
      "v2: send the challenge in the PAYMENT-REQUIRED header. v1: send it as JSON in the body.",
    );
  }
  if (e.location === "both" && e.header !== undefined && e.bodyChallenge !== undefined) {
    const paths = diffPaths(e.header, e.bodyChallenge);
    if (paths.length > 0) {
      add(
        "header-body-drift",
        "error",
        "Header and body challenges differ",
        `Differing fields: ${paths.slice(0, 10).join(", ")}`,
        "Generate header and body from the same object, or drop the body copy.",
      );
    }
  }

  const c = e.challenge;
  if (isObj(c)) {
    const v = c.x402Version;
    if (v !== 1 && v !== 2) {
      add(
        "version-missing",
        "error",
        "x402Version missing or invalid",
        v === undefined ? "x402Version is not set." : `x402Version is ${JSON.stringify(v)} (${typeof v}).`,
        "Set x402Version to the number 1 or 2.",
      );
    } else {
      const covered = new Set<string>();
      const accepts = Array.isArray(c.accepts) ? c.accepts : [];
      accepts.forEach((a: unknown, i: number) => {
        if (!isObj(a)) return;
        const net = a.network;
        if (v === 2 && typeof net === "string" && !net.includes(":")) {
          covered.add(`accepts.${i}.network`);
          const hint = LEGACY_TO_CAIP2[net];
          add(
            "v2-legacy-network",
            "error",
            `v2 uses legacy network name "${net}"`,
            `accepts[${i}].network is "${net}"; v2 requires CAIP-2.`,
            hint ? `Use "${hint}".` : 'Use the CAIP-2 identifier, e.g. "eip155:8453" for Base.',
          );
        }
        if (v === 1 && typeof net === "string" && net.includes(":")) {
          add(
            "v1-caip2-network",
            "warn",
            `v1 uses CAIP-2 network "${net}"`,
            `accepts[${i}].network is "${net}"; v1 clients expect legacy names.`,
            'Use a legacy name such as "base-sepolia", or move to v2.',
          );
        }
        if (v === 2 && ("maxAmountRequired" in a || typeof a.resource === "string")) {
          covered.add(`accepts.${i}.amount`);
          add(
            "mixed-dialect",
            "error",
            "v2 challenge uses v1 fields",
            `accepts[${i}] contains ${"maxAmountRequired" in a ? "maxAmountRequired" : "a string resource"}.`,
            'In v2, the price field is "amount" and "resource" is a top-level object.',
          );
        }
        const flow = isObj(a.extra) ? a.extra.paymentFlow : undefined;
        if (v === 2 && flow !== undefined && !PAYMENT_FLOWS.includes(flow)) {
          add(
            "payment-flow",
            "error",
            `Unknown payment flow ${JSON.stringify(flow)}`,
            `accepts[${i}].extra.paymentFlow is ${JSON.stringify(flow)}. Clients must not pay for a flow they do not recognize and skip this entry.`,
            'Use "authorization", "upfront" or "escrow", or omit it for the scheme default.',
          );
        }
        const fallback = defaultFlow(a.scheme, net);
        if (v === 2 && flow === undefined && fallback !== "authorization") {
          add(
            "payment-flow",
            "warn",
            "Payment flow not declared",
            `accepts[${i}] (${String(a.scheme)} on ${String(net)}) defaults to the "${fallback}" flow, which settles before the resource runs. The spec requires extra.paymentFlow whenever the flow is not "authorization", so clients can tell without scheme-specific knowledge.`,
            `Set extra.paymentFlow to "${fallback}".`,
          );
        }
        if (v === 1 && "amount" in a && !("maxAmountRequired" in a)) {
          covered.add(`accepts.${i}.maxAmountRequired`);
          add(
            "mixed-dialect",
            "error",
            "v1 challenge uses v2 fields",
            `accepts[${i}] has "amount" instead of "maxAmountRequired".`,
            'In v1, the price field is "maxAmountRequired".',
          );
        }
      });

      const schema = v === 1 ? PaymentRequiredV1Schema : PaymentRequiredV2Schema;
      const parsed = schema.safeParse(c);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const p = issue.path.join(".");
          if (covered.has(p)) continue;
          add("schema", "error", `Invalid field: ${p || "(root)"}`, issue.message, "Fix the field to match the x402 specification.");
        }
      }
      if (v === 1) {
        add(
          "v1-legacy",
          "info",
          "Legacy v1 challenge",
          "v1 works with v1 clients. v2 is the current standard.",
          "Consider serving v2 (PAYMENT-REQUIRED header) for current clients.",
        );
      }
    }
  }

  if (!(e.cacheControl ?? "").toLowerCase().includes("no-store")) {
    add(
      "cache-control",
      "warn",
      "Challenge may be cached",
      `Cache-Control is ${e.cacheControl ? `"${e.cacheControl}"` : "not set"}.`,
      'Send "Cache-Control: no-store" with 402 responses.',
    );
  }
  if (officialClientCanRead(e)) {
    add("official-client", "pass", "Official x402 client can read the challenge", "The challenge is where the official client looks for it.");
  } else {
    add(
      "official-client",
      "error",
      "Official x402 client cannot read the challenge",
      "The official client would fail before signing; see the other findings.",
    );
  }
  return out;
}

// Identical findings on GET and POST collapse into one with method "both".
function merge(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) {
    const twin = out.find(
      (o) => o.id === f.id && o.title === f.title && o.detail === f.detail && o.method !== f.method && o.method !== "both",
    );
    if (twin) twin.method = "both";
    else out.push({ ...f });
  }
  return out;
}

// CORS (x402 v2 HTTP transport, "Browser clients"). Warnings only: they affect browser clients.

const BROWSER_ONLY = "Affects browser clients only.";
const DISPLAY: Record<string, string> = {
  "payment-signature": "PAYMENT-SIGNATURE",
  "content-type": "Content-Type",
  "x-payment": "X-PAYMENT",
};

const headerNames = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// "*" is a wildcard only on requests without credentials; with them it is a literal name.
function missingNames(list: string | undefined, required: string[], credentialed: boolean): string[] {
  const have = headerNames(list);
  if (!credentialed && have.includes("*")) return [];
  return required.filter((n) => !have.includes(n.toLowerCase()));
}

const isCredentialed = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";
const starNote = (list: string | undefined, credentialed: boolean) =>
  credentialed && headerNames(list).includes("*") ? ' "*" does not cover credentialed requests.' : "";
const shown = (v: string | undefined) => (v === undefined ? "not set" : `"${v}"`);

function versionsSeen(results: Extracted[]): Set<number> {
  const out = new Set<number>();
  for (const e of results) {
    for (const c of [e.header, e.bodyChallenge]) {
      if (isObj(c) && (c.x402Version === 1 || c.x402Version === 2)) out.add(c.x402Version);
    }
  }
  return out;
}

const corsReady = (results: Extracted[]) => results.filter((e) => !e.error && is402(e) && e.allowOrigin !== undefined);

/** The preflight a browser sends before the paid retry; none if no 402 is CORS-enabled. */
export function preflightPlan(results: Extracted[]): { method: Method; headers: string } | undefined {
  const ready = corsReady(results);
  if (ready.length === 0) return undefined;
  const method: Method = ready.some((e) => e.method === "POST") ? "POST" : "GET";
  const versions = versionsSeen(ready);
  const headers = [
    ...(versions.has(2) || !versions.has(1) ? ["payment-signature"] : []),
    ...(method === "POST" ? ["content-type"] : []),
    ...(versions.has(1) ? ["x-payment"] : []),
  ];
  return { method, headers: headers.join(",") };
}

function corsRules(results: Extracted[], pre: PreflightResult | undefined): Finding[] {
  const out: Finding[] = [];
  const add = (id: string, level: Level, method: Finding["method"], title: string, detail: string, fix: string) => {
    out.push({ id, level, method, title, detail, fix });
  };

  const paid = results.filter((e) => !e.error && is402(e));
  for (const e of paid.filter((x) => x.allowOrigin === undefined)) {
    add(
      "cors-allow-origin",
      "warn",
      e.method,
      "402 without Access-Control-Allow-Origin",
      `A browser hides the whole 402 from cross-origin pages, so a web app cannot read the price. ${BROWSER_ONLY}`,
      "If browser apps should pay this endpoint, send Access-Control-Allow-Origin on the 402 and on the preflight.",
    );
  }
  // Without Access-Control-Allow-Origin nothing else in CORS has any effect.
  const ready = corsReady(results);
  if (ready.length === 0) return out;

  const versions = versionsSeen(paid);
  const expose = [
    ...(versions.has(2) || !versions.has(1) ? ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] : []),
    ...(versions.has(1) ? ["X-PAYMENT-RESPONSE"] : []),
  ];
  for (const e of ready) {
    const credentialed = isCredentialed(e.allowCredentials);
    const missing = missingNames(e.exposeHeaders, expose, credentialed);
    if (missing.length === 0) continue;
    add(
      "cors-expose-headers",
      "warn",
      e.method,
      "Payment headers not exposed to browsers",
      `Access-Control-Expose-Headers is ${shown(e.exposeHeaders)}; missing: ${missing.join(", ")}.${starNote(e.exposeHeaders, credentialed)} The browser hides them and the client reports an empty challenge or receipt. ${BROWSER_ONLY}`,
      `Add ${missing.join(", ")} to Access-Control-Expose-Headers, merged with any value already present.`,
    );
  }
  if (!pre) return out;

  const asked = `OPTIONS for ${pre.requestMethod} with ${pre.requestHeaders}`;
  const refused = (title: string, detail: string, fix: string) =>
    add("cors-preflight", "warn", "OPTIONS", title, `${detail} The browser refuses the paid retry with a network error. ${BROWSER_ONLY}`, fix);
  if (pre.error) {
    refused("Preflight request failed", `${asked}: ${pre.error}.`, "Answer OPTIONS preflights for this URL.");
    return out;
  }
  if (pre.status === 402) {
    refused(
      "Preflight requires payment",
      `${asked} returned 402.`,
      "Answer the preflight OPTIONS without requiring payment, with a non-trivial Access-Control-Max-Age.",
    );
    return out;
  }
  if (pre.status === undefined || pre.status < 200 || pre.status > 299) {
    refused(
      `Preflight rejected (${pre.status})`,
      `${asked} returned ${pre.status}; browsers need a 2xx.`,
      "Answer the preflight OPTIONS with 204 and the CORS headers.",
    );
    return out;
  }
  if (pre.headers["access-control-allow-origin"] === undefined) {
    refused(
      "Preflight without Access-Control-Allow-Origin",
      `${asked} returned ${pre.status} without Access-Control-Allow-Origin.`,
      "Send Access-Control-Allow-Origin on the preflight too.",
    );
    return out;
  }

  const allow = pre.headers["access-control-allow-headers"];
  const credentialed = isCredentialed(pre.headers["access-control-allow-credentials"]);
  const required = headerNames(pre.requestHeaders).map((n) => DISPLAY[n] ?? n);
  const missing = missingNames(allow, required, credentialed);
  if (missing.length > 0) {
    add(
      "cors-allow-headers",
      "warn",
      "OPTIONS",
      "Preflight does not allow the payment headers",
      `Access-Control-Allow-Headers is ${shown(allow)}; missing: ${missing.join(", ")}.${starNote(allow, credentialed)} The browser refuses the paid retry with a network error. ${BROWSER_ONLY}`,
      `Add ${missing.join(", ")} to Access-Control-Allow-Headers.`,
    );
  }
  if (missingNames(allow, ["Access-Control-Expose-Headers"], credentialed).length > 0) {
    add(
      "cors-client-retry",
      "info",
      "OPTIONS",
      "SDK retry sends Access-Control-Expose-Headers",
      "@x402/fetch and @x402/axios 2.28.0 send Access-Control-Expose-Headers on the paid retry (fix pending in x402-foundation/x402#3478), so an allow list naming only the protocol headers refuses that retry.",
      "Until the fix ships, add Access-Control-Expose-Headers to Access-Control-Allow-Headers.",
    );
  }
  return out;
}

export function runRules(results: Extracted[], preflight?: PreflightResult): Finding[] {
  const all = results.flatMap(methodRules);
  const ok = results.filter((e) => !e.error);

  if (ok.length > 0 && !ok.some(is402)) {
    all.unshift({
      id: "no-402",
      level: "error",
      method: ok.length === 2 ? "both" : ok[0].method,
      title: "No 402 challenge",
      detail: ok.map((e) => `${e.method} → ${e.status}`).join(", "),
      fix: statusHint(ok[0].status),
    });
  }
  if (ok.length === 2 && ok.filter(is402).length === 1) {
    const yes = ok.find(is402)!;
    const no = ok.find((e) => !is402(e))!;
    all.push({
      id: "verb-mismatch",
      level: "warn",
      method: "both",
      title: `${no.method} does not return 402`,
      detail: `${yes.method} → ${yes.status}, ${no.method} → ${no.status}`,
      fix: `Clients often probe with GET first. Issue the challenge on ${no.method} too, or document the supported method.`,
    });
  }
  all.push(...corsRules(results, preflight));
  return merge(all);
}
