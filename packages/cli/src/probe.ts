import { MAX_CONTROL_PLANE_RESPONSE_BYTES, readLimitedText } from "@x402/core/http";
import type { Method, PreflightResult, ProbeResult } from "./types.ts";

/**
 * Sent on the browser-like probe and the preflight only. The plain probes go without it,
 * because a server may refuse browser origins on a paid route (x402 v2 HTTP transport).
 */
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
  bodyError?: string;
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
  const headers = { "user-agent": `op8x-cli/${opts.version} (+https://op8x.com)`, ...init.headers };

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
    // Read like @x402/fetch does (1 MiB limit, stream errors thrown). A failure here keeps status and headers,
    // except our own timeout: @x402/fetch has none, so it is the CLI's limit and counts as a request error.
    try {
      const bodyText = await readLimitedText(res, MAX_CONTROL_PLANE_RESPONSE_BYTES);
      return { status: res.status, headers: responseHeaders, bodyText, ms: elapsed() };
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") throw e;
      return { status: res.status, headers: responseHeaders, bodyText: "", ms: elapsed(), bodyError: failure(e) };
    }
  } catch (e) {
    return { headers: {}, bodyText: "", ms: elapsed(), error: failure(e) };
  }

  function failure(e: unknown): string {
    const err = e instanceof Error ? e : new Error(String(e));
    return err.name === "TimeoutError" ? `Timed out after ${opts.timeoutMs / 1000} s` : describe(err);
  }
}

/** An unpaid request; with `browser`, sent with an Origin header as a web app would. */
export async function probe(url: string, method: Method, opts: ProbeOptions, browser = false): Promise<ProbeResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method === "POST") headers["content-type"] = "application/json";
  if (browser) headers.origin = ORIGIN;
  const r = await send(url, { method, headers, body: method === "POST" ? "{}" : undefined }, opts);
  return { method, url, ...r, ...(browser ? { origin: ORIGIN } : {}) };
}

export async function preflight(
  url: string,
  requestMethod: Method,
  requestHeaders: string,
  opts: ProbeOptions,
): Promise<PreflightResult> {
  const headers = {
    origin: ORIGIN,
    "access-control-request-method": requestMethod,
    "access-control-request-headers": requestHeaders,
  };
  const { bodyText: _bodyText, bodyError: _bodyError, ...r } = await send(url, { method: "OPTIONS", headers }, opts);
  return { method: "OPTIONS", url, requestMethod, requestHeaders, ...r };
}

function describe(err: Error): string {
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) return `${err.message} (${cause.code})`;
  if (cause?.message) return `${err.message}: ${cause.message}`;
  return err.message;
}
