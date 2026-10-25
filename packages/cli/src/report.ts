import { ORIGIN } from "./probe.ts";
import type { Finding, Level, PreflightResult, ProbeResult } from "./types.ts";

export interface Report {
  tool: "op8x";
  version: string;
  url: string;
  checkedAt: string;
  requests: {
    method: string;
    status?: number;
    ms: number;
    error?: string;
    origin?: string;
    requestHeaders?: Record<string, string>;
  }[];
  findings: Finding[];
  summary: { errors: number; warnings: number };
}

const ORDER: Level[] = ["error", "warn", "info", "pass"];
const SYMBOL: Record<Level, string> = { error: "✖", warn: "!", info: "i", pass: "✓" };
const COLOR: Record<Level, string> = { error: "31", warn: "33", info: "36", pass: "32" };

export function buildReport(
  url: string,
  version: string,
  probes: (ProbeResult | PreflightResult)[],
  findings: Finding[],
  now: Date = new Date(),
): Report {
  return {
    tool: "op8x",
    version,
    url,
    checkedAt: now.toISOString(),
    requests: probes.map((p) => ({
      method: p.method,
      ...(p.status !== undefined ? { status: p.status } : {}),
      ms: p.ms,
      ...(p.error ? { error: p.error } : {}),
      ...(p.method !== "OPTIONS" && p.origin ? { origin: p.origin } : {}),
      ...(p.method === "OPTIONS"
        ? {
            origin: ORIGIN,
            requestHeaders: {
              "access-control-request-method": p.requestMethod,
              "access-control-request-headers": p.requestHeaders,
            },
          }
        : {}),
    })),
    findings,
    summary: {
      errors: findings.filter((f) => f.level === "error").length,
      warnings: findings.filter((f) => f.level === "warn").length,
    },
  };
}

export function renderJson(r: Report): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function renderText(r: Report, color: boolean): string {
  const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lines: string[] = [`op8x check ${r.url}`, ""];

  for (const q of r.requests) {
    const as = q.method !== "OPTIONS" && q.origin ? "  (with Origin)" : "";
    lines.push(`  ${q.method.padEnd(4)} ${q.error ? `failed (${q.error})` : String(q.status)}  ${q.ms} ms${as}`);
  }
  lines.push("");

  const sorted = [...r.findings].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
  for (const f of sorted) {
    lines.push(`${paint(COLOR[f.level], `${SYMBOL[f.level]} ${f.level.padEnd(5)}`)} [${f.method}] ${f.title}`);
    lines.push(`        ${f.detail}`);
    if (f.fix) lines.push(`        Fix: ${f.fix}`);
  }

  lines.push("", "Reproduce:");
  for (const q of r.requests) {
    const origin = q.origin ? ` -H ${quote(`Origin: ${q.origin}`)}` : "";
    if (q.method === "POST") {
      lines.push(`  curl -i -X POST${origin} -H 'Content-Type: application/json' -d '{}' ${quote(r.url)}`);
    } else if (q.method === "OPTIONS" && q.requestHeaders) {
      const acr = q.requestHeaders;
      lines.push(
        `  curl -i -X OPTIONS${origin} -H ${quote(`Access-Control-Request-Method: ${acr["access-control-request-method"]}`)} -H ${quote(`Access-Control-Request-Headers: ${acr["access-control-request-headers"]}`)} ${quote(r.url)}`,
      );
    } else {
      lines.push(`  curl -i -X ${q.method}${origin} ${quote(r.url)}`);
    }
  }
  lines.push(
    "",
    `Summary: ${count(r.summary.errors, "error")}, ${count(r.summary.warnings, "warning")}`,
    `Listing and Bazaar checks: npx x402-listing-check ${r.url}`,
    "op8x · https://op8x.com",
  );
  return `${lines.join("\n")}\n`;
}
