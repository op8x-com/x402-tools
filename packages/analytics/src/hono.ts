import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { hashPayer } from "./hash.ts";
import { buildRecord } from "./record.ts";
import type { RecordInput } from "./record.ts";
import { createTransport } from "./transport.ts";
import type { Transport } from "./transport.ts";
import type { AnalyticsOptions } from "./types.ts";

export type { AnalyticsOptions } from "./types.ts";

/** Maximum bytes copied from a 402 response body. */
const BODY_CAP = 64 * 1024;

/** Read at most BODY_CAP bytes of a cloned body, then cancel the rest. Never throws. */
async function readCapped(res: Response): Promise<string | undefined> {
  const stream = res.body;
  if (stream === null) return undefined;
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  try {
    reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let total = 0;
    while (total < BODY_CAP) {
      const { done, value } = await reader.read();
      if (done) {
        reader = undefined;
        break;
      }
      // isView instead of instanceof: chunks may come from another realm.
      if (!ArrayBuffer.isView(value)) continue;
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

/**
 * Hono middleware that records request metadata for x402 sellers.
 * Place it before the payment middleware. It never changes, breaks or delays the response.
 */
export function analytics(options: AnalyticsOptions = {}): MiddlewareHandler {
  let transport: Transport | undefined;
  let hash: ((address: string) => Promise<string>) | undefined;
  let blankSalt = false;
  try {
    transport = createTransport(options ?? {});
    const salt = options?.salt;
    if (typeof salt === "string" && salt.trim() !== "") {
      hash = (address) => hashPayer(salt, address);
    } else if (salt !== undefined) {
      blankSalt = true;
    }
  } catch {
    transport = undefined;
    try {
      console.warn("op8x.analytics: setup failed, analytics disabled");
    } catch {
      // ignore
    }
  }

  return async (c, next) => {
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
      if (transport === undefined || requestHeaders === undefined) return;
      const res = c.res;
      const status = res.status;
      const responseHeaders = new Headers(res.headers);
      const ms = Date.now() - startMs;
      let route = "";
      try {
        // A pattern only for a real route handler after this middleware: the last matched route
        // past our own index whose method is not "ALL" (app.use / catch-all middleware); else "".
        const routes = matchedRoutes(c);
        for (let i = routes.length - 1; i > entryIndex; i--) {
          const r = routes[i];
          if (r !== undefined && r.method !== "ALL") {
            route = r.path;
            break;
          }
        }
      } catch {
        route = "";
      }
      let clone: Response | undefined;
      if (status === 402) {
        try {
          clone = res.clone();
        } catch {
          clone = undefined;
        }
      }
      const warnSalt = blankSalt;
      blankSalt = false;
      const send = transport;
      const reqHeaders = requestHeaders;

      const task = (async (): Promise<void> => {
        try {
          // Yield first so no record work runs synchronously in the request path.
          await Promise.resolve();
          // Read the clone first: an unread tee branch would buffer the whole body.
          const body = clone !== undefined ? await readCapped(clone) : undefined;
          if (warnSalt) {
            try {
              console.warn("op8x.analytics: empty salt, payer hashing disabled");
            } catch {
              // ignore
            }
          }
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
          const record = await buildRecord(input, hash);
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
