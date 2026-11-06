import { posix, win32 } from "node:path";
import type { Deps, ExecOptions } from "../cli.ts";
import { isCollectorLink } from "./api.ts";
import type { Api, ApiError } from "./api.ts";
import { generateKey, keyFingerprint, keyHash } from "./keys.ts";
import type { Output } from "./output.ts";
import { systemRootOf } from "./store.ts";

// The device login: make D, R (and K for init), POST device/start, show the link
// and the words, open the browser, then poll device/token with Bearer D at the server's interval
// until the human allows or denies, the server says expired, or 20 minutes pass. The collector
// extends a flow to 15 minutes once the code mail is out, so the start answer's expires_at is never
// a local deadline. 503 busy is retried by the API client (every 10 s, at most 2 minutes).

/** D and R, and K for init (null for login). Replaced in place on a key_conflict at start. */
export interface DeviceKeys {
  device: string;
  read: string;
  write: string | null;
}

export function deviceKeys(withWrite: boolean): DeviceKeys {
  return { device: generateKey("d"), read: generateKey("r"), write: withWrite ? generateKey("w") : null };
}

export type DeviceFailure = ApiError | { state: "denied" | "expired" | "no_account" | "terms_draft" | "granted_lost" };

export type DeviceOutcome =
  | {
      ok: true;
      account: string;
      /** Null after a granted_lost recovery: this computer does not know the address. */
      contactHint: string | null;
      /** Null after a recovery (GET /tenant does not say). */
      newAccount: boolean | null;
      serverKey: "accepted" | "ignored";
      recovered: boolean;
    }
  | { ok: false; fail: DeviceFailure };

export interface DeviceOptions {
  deps: Deps;
  api: Api;
  /** The step "browser" is the caller's; this adds the link event and the notice contact_unknown. */
  out: Output;
  mode: "init" | "login";
  keys: DeviceKeys;
}

const MAX_POLL_MS = 20 * 60_000;
/** Network errors in a row that the polling sits out before it ends with network_error. */
const MAX_NETWORK_ERRORS = 3;
/** How long the opener may take to start; its exit is never awaited. */
const OPEN_TIMEOUT_MS = 5_000;

/** Environment names xdg-open needs to find the desktop session; nothing of op8x. */
const XDG_ENV = [
  "HOME",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "DESKTOP_SESSION",
  "BROWSER",
  "LANG",
  "LC_ALL",
];

export interface Opener {
  file: string;
  args: string[];
  opts: ExecOptions;
}

/**
 * How to open `url` in the browser without a shell, or null (then the link stays in the terminal
 * only). Only the collector's checked link is opened, so no other address or file can be handed
 * to the system's opener. Windows: rundll32 by absolute path from SystemRoot (a bare name is
 * looked up in the current folder first, the seller's project); macOS: /usr/bin/open; else
 * xdg-open from PATH, with only the absolute PATH entries, so an empty or relative entry cannot
 * pick a program from the project. The child gets a minimal environment and is started detached:
 * xdg-open may wait until the browser closes, and the login must not wait for that.
 */
export function openerFor(deps: Pick<Deps, "platform" | "env">, url: string): Opener | null {
  if (!isCollectorLink(url)) return null;
  if (deps.platform === "win32") {
    const root = systemRootOf(deps.env);
    if (root === undefined) return null;
    return {
      file: win32.join(root, "System32", "rundll32.exe"),
      args: ["url.dll,FileProtocolHandler", url],
      opts: { cwd: root, env: { SystemRoot: root }, timeoutMs: OPEN_TIMEOUT_MS, detach: true },
    };
  }
  if (deps.platform === "darwin") {
    const env: Record<string, string> = {};
    if (deps.env.HOME !== undefined) env.HOME = deps.env.HOME;
    return { file: "/usr/bin/open", args: [url], opts: { cwd: "/", env, timeoutMs: OPEN_TIMEOUT_MS, detach: true } };
  }
  const path = (deps.env.PATH ?? "")
    .split(":")
    .filter((p) => p !== "" && posix.isAbsolute(p))
    .join(":");
  if (path === "") return null;
  const env: Record<string, string> = { PATH: path };
  for (const name of XDG_ENV) {
    const v = deps.env[name];
    if (v !== undefined) env[name] = v;
  }
  return { file: "xdg-open", args: [url], opts: { cwd: "/", env, timeoutMs: OPEN_TIMEOUT_MS, detach: true } };
}

/** Starts the opener; false if there is none or it could not start (never an error of the command). */
export async function openBrowser(deps: Pick<Deps, "platform" | "env" | "exec">, url: string): Promise<boolean> {
  const o = openerFor(deps, url);
  if (o === null) return false;
  try {
    const r = await deps.exec(o.file, o.args, o.opts);
    return r.code === 0;
  } catch {
    return false;
  }
}

export async function deviceLogin(o: DeviceOptions): Promise<DeviceOutcome> {
  const { deps, api, out, mode, keys } = o;
  const started = deps.now();
  const token = deps.env.OP8X_TEST_TOKEN;
  const start = () =>
    api.deviceStart({
      mode,
      deviceHash: keyHash(keys.device),
      readHash: keyHash(keys.read),
      ...(keys.write === null ? {} : { writeHash: keyHash(keys.write) }),
      ...(token === undefined || token === "" ? {} : { testToken: token }),
    });

  let begun = await start();
  if (!begun.ok && begun.error.state === "key_conflict") {
    // Someone holds one of these hashes: new keys, once.
    Object.assign(keys, deviceKeys(keys.write !== null));
    begun = await start();
  }
  if (!begun.ok) return { ok: false, fail: begun.error };
  const flow = begun.value;

  out.link({ link: flow.link, words: flow.words, expires_at: flow.expires_at });
  if (out.stopped) return { ok: false, fail: { state: "internal_error" } };
  await openBrowser(deps, flow.link);

  let interval = flow.interval_s;
  let networkErrors = 0;
  for (;;) {
    if (deps.now() - started + interval * 1000 > MAX_POLL_MS) return { ok: false, fail: { state: "expired" } };
    await deps.sleep(interval * 1000);
    const polled = await api.deviceToken(keys.device);
    if (!polled.ok) {
      const e = polled.error;
      if (e.state === "network_error") {
        networkErrors += 1;
        if (networkErrors >= MAX_NETWORK_ERRORS) return { ok: false, fail: e };
        continue;
      }
      // 401 after a lost answer: the grant may have been handed out on the way (granted_lost).
      if (e.state === "key_auth") return networkErrors > 0 ? recover(o) : { ok: false, fail: { state: "unexpected_response", status: 401, code: "key_auth" } };
      return { ok: false, fail: e };
    }
    networkErrors = 0;
    const v = polled.value;
    switch (v.state) {
      case "pending":
        continue;
      case "slow_down":
        interval = v.interval_s;
        continue;
      case "granted":
        return { ok: true, account: v.account, contactHint: v.contact_hint, newAccount: v.new_account, serverKey: v.server_key, recovered: false };
      default:
        return { ok: false, fail: { state: v.state } };
    }
  }
}

/** GET /tenant with the new R: the account, and whether K is the account's current key. */
async function recover(o: DeviceOptions): Promise<DeviceOutcome> {
  const r = await o.api.tenant(o.keys.read);
  if (!r.ok) return { ok: false, fail: { state: "granted_lost" } };
  const current = r.value.keys.find((k) => k.kind === "write" && k.slot === "current");
  const accepted = o.keys.write !== null && current !== undefined && current.fingerprint === keyFingerprint(o.keys.write);
  o.out.notice("contact_unknown");
  if (o.out.stopped) return { ok: false, fail: { state: "internal_error" } };
  return { ok: true, account: r.value.tenant, contactHint: null, newAccount: null, serverKey: accepted ? "accepted" : "ignored", recovered: true };
}
