import { PaymentRequiredV1Schema, PaymentRequiredV2Schema } from "@x402/core/schemas";
import { officialClientCanRead } from "./extract.ts";
import type { Extracted, Finding, Level } from "./types.ts";

// Hint map for v2 endpoints still using v1 network names (EVM networks only).
const LEGACY_TO_CAIP2: Record<string, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
  polygon: "eip155:137",
  "polygon-amoy": "eip155:80002",
  avalanche: "eip155:43114",
  "avalanche-fuji": "eip155:43113",
};

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

export function runRules(results: Extracted[]): Finding[] {
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
  return merge(all);
}
