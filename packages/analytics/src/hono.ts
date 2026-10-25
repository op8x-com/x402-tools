import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { hashPayer } from "./hash.ts";
import { buildRecord } from "./record.ts";
import type { RecordInput } from "./record.ts";
import { clampTimeout, createTransport } from "./transport.ts";
import type { Transport } from "./transport.ts";
import type { AnalyticsOptions } from "./types.ts";

export type { AnalyticsOptions } from "./types.ts";

/** Maximum bytes copied from a 402 response body. */
const BODY_CAP = 64 * 1024;

function warnOnce(message: string): void {
  try {
    console.warn(message);
  } catch {
    // ignore
  }
}

/**
 * Read at most BODY_CAP bytes of a cloned body within deadlineMs, then cancel the rest.
 * On expiry it returns what was read so far. Never throws.
 */
async function readCapped(res: Response, deadlineMs: number): Promise<string | undefined> {
  const stream = res.body;
  if (stream === null) return undefined;
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = stream.getReader();
    const r = reader;
    // A stalled body must not keep this branch open: the source is only cancelled once
    // both tee branches are, so a client cancel of the seller's response would not reach it.
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), deadlineMs);
    });
    const decoder = new TextDecoder();
    let text = "";
    let total = 0;
    while (total < BODY_CAP) {
      const next = await Promise.race([r.read(), expired]);
      if (next === "expired") break;
      const { done, value } = next;
      if (done) {
        reader = undefined;
        break;
      }
      // isView instead of instanceof: chunks may come from another realm.
      if (!ArrayBuffer.isView(value)) break;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const room = BODY_CAP - total;
      const part = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
      total += part.byteLength;
      text += decoder.decode(part, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    if (reader === undefined) {
      try {
        stream.cancel().catch(() => {});
      } catch {
        // ignore
      }
    }
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (reader !== undefined) {
      // Not awaited: cancelling one branch of a tee only resolves once the other
      // branch (the seller's response) is cancelled or fully read.
      try {
        reader.cancel().catch(() => {});
      } catch {
        // ignore
      }
    }
  }
}

function schedule(c: Context, task: Promise<void>): void {
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined; // Hono throws when there is no execution context
  }
  if (ctx !== undefined) {
    try {
      ctx.waitUntil(task);
      return;
    } catch {
      // fall through: keep the task running without waitUntil
    }
  }
  task.catch(() => {});
}

interface MatchedRoute {
  method: string;
  path: string;
}

/**
 * Matched routes of this request. `hono/route` reads a module-private Symbol, which fails when
 * the app uses a different hono copy; then the request's own (deprecated) getter is used.
 */
function routesOf(c: Context): MatchedRoute[] | undefined {
  try {
    const routes: unknown = matchedRoutes(c);
    if (Array.isArray(routes)) return routes as MatchedRoute[];
  } catch {
    // fall through
  }
  try {
    const routes: unknown = (c.req as { matchedRoutes?: unknown }).matchedRoutes;
    if (Array.isArray(routes)) return routes as MatchedRoute[];
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Hono middleware that records request metadata for x402 sellers.
 * Place it before the payment middleware. It never changes, breaks or delays the response.
 */
export function analytics(options: AnalyticsOptions = {}): MiddlewareHandler {
  let transport: Transport | undefined;
  let hash: ((address: string) => Promise<string>) | undefined;
  let badSalt = false;
  let idle = false;
  let readDeadlineMs = 0;
  let chainCheck = false;
  try {
    const opts = options ?? {};
    transport = createTransport(opts);
    idle = opts.endpoint === undefined && opts.log !== true;
    readDeadlineMs = clampTimeout(opts.timeoutMs);
    chainCheck = opts.chainCheck === true;
    const salt: unknown = opts.salt;
    if (typeof salt === "string" && salt.trim() !== "") {
      hash = (address) => hashPayer(salt, address);
    } else if (salt !== undefined) {
      badSalt = true;
    }
  } catch {
    transport = undefined;
    warnOnce("op8x.analytics: setup failed, analytics disabled");
  }
  let idleWarned = false;
  let routeWarned = false;

  return async (c, next) => {
    // Disabled: `await next()` and return nothing. Returning next()'s value would hand Hono the
    // Context object, which it assigns to c.res when the context is not finalized.
    if (transport === undefined) {
      await next();
      return;
    }
    if (idle) {
      if (!idleWarned) {
        idleWarned = true;
        warnOnce("op8x.analytics: no endpoint and log disabled, nothing is recorded");
      }
      await next();
      return;
    }

    let startMs = 0;
    let entryIndex = -1;
    let ts = "";
    let method = "";
    let requestHeaders: Headers | undefined;
    try {
      entryIndex = c.req.routeIndex;
      startMs = Date.now();
      ts = new Date(startMs).toISOString();
      method = c.req.method;
      requestHeaders = new Headers(c.req.raw.headers);
    } catch {
      requestHeaders = undefined;
    }

    // Outside any try/catch: seller errors behave exactly as without this middleware.
    await next();

    try {
      if (requestHeaders === undefined) return;
      // Reading c.res on a non-finalized context would create a response whose headers an
      // outer middleware's later `c.res = ...` merges in. Record nothing instead.
      if (!c.finalized) return;
      const res = c.res;
      const status = res.status;
      const responseHeaders = new Headers(res.headers);
      const ms = Date.now() - startMs;
      let route = "";
      // A pattern only for a real route handler after this middleware: the last matched route
      // past our own index whose method is not "ALL" (app.use / catch-all middleware); else "".
      const routes = routesOf(c);
      if (routes === undefined) {
        if (!routeWarned) {
          routeWarned = true;
          warnOnce("op8x.analytics: route unavailable (duplicate hono copy?)");
        }
      } else {
        for (let i = routes.length - 1; i > entryIndex; i--) {
          const r = routes[i];
          if (r !== undefined && r !== null && r.method !== "ALL" && typeof r.path === "string") {
            route = r.path;
            break;
          }
        }
      }
      let clone: Response | undefined;
      if (status === 402) {
        try {
          clone = res.clone();
        } catch {
          clone = undefined;
        }
      }
      const warnSalt = badSalt;
      badSalt = false;
      const send = transport;
      const reqHeaders = requestHeaders;

      const task = (async (): Promise<void> => {
        try {
          // Yield a macrotask first so no record work runs before the response is delivered.
          await new Promise((resolve) => setTimeout(resolve, 0));
          // Read the clone first: an unread tee branch would buffer the whole body.
          const body = clone !== undefined ? await readCapped(clone, readDeadlineMs) : undefined;
          if (warnSalt) warnOnce("op8x.analytics: salt must be a non-empty string, payer hashing disabled");
          const input: RecordInput = {
            id: crypto.randomUUID(),
            ts,
            ms,
            method,
            route,
            status,
            requestHeaders: reqHeaders,
            responseHeaders,
          };
          if (body !== undefined) input.body = body;
          const record = await buildRecord(input, hash, { chainCheck });
          await send.send(record);
        } catch {
          // fail open: nothing may escape
        }
      })();
      schedule(c, task);
    } catch {
      // fail open: the seller's response is already final
    }
  };
}
