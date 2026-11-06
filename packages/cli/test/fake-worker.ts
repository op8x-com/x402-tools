import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeCollector } from "./fake-collector.ts";

// A fake seller worker with the op8x module (not a test file itself, like fixtures.ts). A request
// with the header op8x-test is reported to the fake collector with the worker's K, as the module
// does, so the collector marks the nonce as seen. The worker's K comes from a function (the last
// `secret put` of the fake wrangler, or the env file), so the test proves that K reached the worker.

export interface WorkerRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

/** module: reports the nonce; no_module: answers without reporting; redirect: answers 302 elsewhere. */
export type WorkerMode = "module" | "no_module" | "redirect";

export interface FakeWorker {
  /** http://127.0.0.1:<port> (no path). */
  origin: string;
  requests: WorkerRequest[];
  mode: WorkerMode;
  close: () => Promise<void>;
}

export async function startFakeWorker(o: { collector: FakeCollector; key: () => string | null; mode?: WorkerMode }): Promise<FakeWorker> {
  const requests: WorkerRequest[] = [];
  const worker: FakeWorker = { origin: "", requests, mode: o.mode ?? "module", close: async () => {} };
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", path: req.url ?? "", headers: { ...req.headers } });
    req.resume();
    if (worker.mode === "redirect") {
      res.writeHead(302, { location: `${worker.origin}/elsewhere` });
      res.end();
      return;
    }
    const nonce = req.headers["op8x-test"];
    const key = o.key();
    if (worker.mode === "module" && key !== null) o.collector.ingest(key, typeof nonce === "string" ? nonce : undefined);
    res.writeHead(402, { "content-type": "application/json" });
    res.end('{"x402Version":2,"accepts":[]}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  worker.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  worker.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return worker;
}
