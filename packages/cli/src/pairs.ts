import { isObject } from "./extract.ts";
import type { Extracted } from "./types.ts";

// Shared pairing of a method's plain challenge with its browser-like repeat. Options are grouped by
// scheme, network and asset; a rule supplies which value of an option to compare. Server strings
// are only compared and stored, never used as object keys.

export interface ChangedGroup {
  /** Index of the group's first option in the plain challenge's accepts[]. */
  index: number;
  scheme: string;
  network: string;
  asset: string;
  /** Values as returned by valueOf (first-seen order, deduplicated) only in the plain challenge. */
  plainOnly: string[];
  /** Values only in the repeat. */
  repeatOnly: string[];
}

export interface ChangedPair {
  method: Extracted["method"];
  x402Version: 1 | 2;
  /** All changed groups, ordered by first option index in the plain challenge. */
  groups: ChangedGroup[];
}

interface Group {
  index: number;
  scheme: string;
  network: string;
  asset: string;
  values: Set<string>;
}

type ValueOf = (entry: Record<string, unknown>, version: 1 | 2) => string | undefined;

function groupsOf(challenge: unknown, version: 1 | 2, valueOf: ValueOf): Map<string, Group> | undefined {
  if (!isObject(challenge) || !Array.isArray(challenge.accepts) || challenge.accepts.length === 0) return undefined;
  const groups = new Map<string, Group>();
  challenge.accepts.forEach((a: unknown, index: number) => {
    if (!isObject(a)) return;
    const { scheme, network, asset } = a;
    if (typeof scheme !== "string" || typeof network !== "string" || typeof asset !== "string") return;
    const value = valueOf(a, version);
    if (value === undefined) return;
    const key = JSON.stringify([scheme, network, asset]);
    const group = groups.get(key);
    if (group) group.values.add(value);
    else groups.set(key, { index, scheme, network, asset, values: new Set([value]) });
  });
  return groups;
}

/** The groups of a method's plain challenge whose value differs from its browser-like repeat, if any. */
export function changedGroups(e: Extracted, valueOf: ValueOf): ChangedPair | undefined {
  if (e.status !== 402 || e.originStatus !== 402) return undefined;
  // Relies on extract.ts deriving version and originVersion from the same challenges compared below.
  if (e.version === undefined || e.originVersion !== e.version) return undefined;
  const plain = groupsOf(e.challenge, e.version, valueOf);
  const repeat = groupsOf(e.originChallenge, e.version, valueOf);
  if (!plain || !repeat) return undefined;
  const groups: ChangedGroup[] = [];
  for (const [key, p] of plain) {
    const r = repeat.get(key);
    if (!r) continue;
    const plainOnly = [...p.values].filter((v) => !r.values.has(v));
    const repeatOnly = [...r.values].filter((v) => !p.values.has(v));
    if (plainOnly.length > 0 && repeatOnly.length > 0) {
      groups.push({ index: p.index, scheme: p.scheme, network: p.network, asset: p.asset, plainOnly, repeatOnly });
    }
  }
  if (groups.length === 0) return undefined;
  return { method: e.method, x402Version: e.version, groups };
}
