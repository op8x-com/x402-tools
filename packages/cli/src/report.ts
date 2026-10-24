import type { Finding, Level, ProbeResult } from "./types.ts";

export interface Report {
  tool: "op8x";
  version: string;
  url: string;
  checkedAt: string;
  requests: { method: string; status?: number; ms: number; error?: string }[];
  findings: Finding[];
  summary: { errors: number; warnings: number };
}

const ORDER: Level[] = ["error", "warn", "info", "pass"];
const SYMBOL: Record<Level, string> = { error: "✖", warn: "!", info: "i", pass: "✓" };
const COLOR: Record<Level, string> = { error: "31", warn: "33", info: "36", pass: "32" };

export function buildReport(
  url: string,
  version: string,
  probes: ProbeResult[],
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

export function renderText(r: Report, color: boolean): string {
  const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lines: string[] = [`op8x check ${r.url}`, ""];

  for (const q of r.requests) {
    lines.push(`  ${q.method.padEnd(4)} ${q.error ? `failed (${q.error})` : String(q.status)}  ${q.ms} ms`);
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
    lines.push(
      q.method === "POST"
        ? `  curl -i -X POST -H 'Content-Type: application/json' -d '{}' ${quote(r.url)}`
        : `  curl -i -X ${q.method} ${quote(r.url)}`,
    );
  }
  lines.push(
    "",
    `Summary: ${r.summary.errors} error(s), ${r.summary.warnings} warning(s)`,
    `Listing, CORS and Bazaar checks: npx x402-listing-check ${r.url}`,
    "op8x · https://op8x.com",
  );
  return `${lines.join("\n")}\n`;
}
