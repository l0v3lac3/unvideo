/**
 * Source registry. Add a new upstream site here (and a matching entry to
 * the frontend registry in `src/lib/sources.ts`).
 */

import { HttpError } from "../proxy";
import { nineOneSource } from "./91porn";
import { cg51Source, legacyNodeInfo } from "./cg51";
import { rouSource } from "./rou";
import { t66ySource } from "./t66y";
import type { Source } from "./types";

export const SOURCES: Source[] = [
  rouSource,
  cg51Source,
  nineOneSource,
  t66ySource,
];

const byId = new Map<string, Source>(SOURCES.map((s) => [s.id, s]));

/**
 * Resolve a source by id. Legacy endpoints omit `src`; `fallback` is the
 * historical default for that endpoint.
 */
export function getSource(id: string | null | undefined, fallback: string): Source {
  const source = (id ? byId.get(id) : undefined) ?? byId.get(fallback);
  if (!source) throw new HttpError(404, `unknown source: ${id ?? fallback}`);
  return source;
}

export { legacyNodeInfo };
