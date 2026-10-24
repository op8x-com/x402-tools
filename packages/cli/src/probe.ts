import type { Method, ProbeResult } from "./types.ts";

const MAX_BODY_BYTES = 256 * 1024;

export interface ProbeOptions {
  timeoutMs: number;
  version: string;
  fetchImpl?: typeof fetch;
}

export async function probe(url: string, method: Method, opts: ProbeOptions): Promise<ProbeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": `op8x-cli/${opts.version} (+https://op8x.com)`,
  };
  if (method === "POST") headers["content-type"] = "application/json";

  try {
    const res = await doFetch(url, {
      method,
      headers,
      body: method === "POST" ? "{}" : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    const bodyText = await readCapped(res, MAX_BODY_BYTES);
    return { method, url, status: res.status, headers: responseHeaders, bodyText, ms: elapsed() };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const message = err.name === "TimeoutError" ? `Timed out after ${opts.timeoutMs / 1000} s` : describe(err);
    return { method, url, headers: {}, bodyText: "", ms: elapsed(), error: message };
  }
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
