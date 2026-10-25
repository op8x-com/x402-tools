import type { UaClass } from "./types.ts";

const RULES: Array<[string[], UaClass]> = [
  [["op8x"], "op8x"],
  [["x402"], "x402-client"],
  [["axios"], "axios"],
  [["python"], "python"],
  [["go-http-client"], "go"],
  [["curl"], "curl"],
  [["mozilla"], "browser"],
  [["node", "undici"], "node"],
];

/** Maps a User-Agent header to a coarse class. The raw value is never kept. */
export function uaClass(header: string | null | undefined): UaClass {
  const ua = (header ?? "").trim().toLowerCase();
  if (ua === "") return "none";
  for (const [needles, cls] of RULES) {
    if (needles.some((n) => ua.includes(n))) return cls;
  }
  return "other";
}
