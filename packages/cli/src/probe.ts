import type { Method, PreflightResult, ProbeResult } from "./types.ts";

const MAX_BODY_BYTES = 256 * 1024;

/** Sent on every request so CORS-aware servers answer as they would to a browser. */
export const ORIGIN = "https://op8x.com";

export interface ProbeOptions {
  timeoutMs: number;
  version: string;
  fetchImpl?: typeof fetch;
}

interface Sent {
  status?: number;
  headers: Record<string, string>;
  bodyText: string;
  ms: number;
  error?: string;
}

async function send(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  opts: ProbeOptions,
): Promise<Sent> {
  const doFetch = opts.fetchImpl ?? fetch;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const headers = { "user-agent": `op8x-cli/${opts.version} (+https://op8x.com)`, origin: ORIGIN, ...init.headers };

  try {
    const res = await doFetch(url, {
      method: init.method,
      headers,
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    const bodyText = await readCapped(res, MAX_BODY_BYTES);
    return { status: res.status, headers: responseHeaders, bodyText, ms: elapsed() };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const message = err.name === "TimeoutError" ? `Timed out after ${opts.timeoutMs / 1000} s` : describe(err);
    return { headers: {}, bodyText: "", ms: elapsed(), error: message };
  }
}

export async function probe(url: string, method: Method, opts: ProbeOptions): Promise<ProbeResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method === "POST") headers["content-type"] = "application/json";
  const r = await send(url, { method, headers, body: method === "POST" ? "{}" : undefined }, opts);
  return { method, url, ...r };
}

export async function preflight(
  url: string,
  requestMethod: Method,
  requestHeaders: string,
  opts: ProbeOptions,
): Promise<PreflightResult> {
  const headers = {
    "access-control-request-method": requestMethod,
    "access-control-request-headers": requestHeaders,
  };
  const { bodyText: _bodyText, ...r } = await send(url, { method: "OPTIONS", headers }, opts);
  return { method: "OPTIONS", url, requestMethod, requestHeaders, ...r };
}

function describe(err: Error): string {
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) return `${err.message} (${cause.code})`;
  if (cause?.message) return `${err.message}: ${cause.message}`;
  return err.message;
}

async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}
