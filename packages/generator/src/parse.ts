/**
 * Extract a candidate JSON object from a raw model response. Models are
 * instructed to emit ONLY the JSON spec, but the parser tolerates markdown
 * code fences, leading prose, and trailing prose. A response with no
 * parseable JSON object is a *validation failure* (fed back through the
 * retry loop), never a crash.
 */

export type ParsedCandidate =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

const FENCE_RE = /```(?:json)?[^\S\n]*\n?([\s\S]*?)```/i;

export function extractSpecJson(raw: string): ParsedCandidate {
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, reason: "the response is empty" };
  }

  const candidates: string[] = [];
  const fence = FENCE_RE.exec(text);
  const fenced = fence?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  candidates.push(text);

  for (const candidate of candidates) {
    const direct = tryParseObject(candidate);
    if (direct !== undefined) return { ok: true, value: direct };
    const scanned = firstParseableObject(candidate);
    if (scanned !== undefined) return { ok: true, value: scanned };
  }

  return { ok: false, reason: "no parseable JSON object found in the response" };
}

/** JSON.parse a string, accepting only plain (non-array) objects. */
function tryParseObject(s: string): unknown {
  try {
    const value: unknown = JSON.parse(s);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Scan for `{ ... }` spans (string-aware brace matching) and return the
 * first span that parses to a plain object. Handles prose around and
 * between JSON, and braces inside JSON string values.
 */
function firstParseableObject(s: string): unknown {
  for (let i = 0; i < s.length; i++) {
    if (s.charAt(i) !== "{") continue;
    const end = scanBalanced(s, i);
    if (end === -1) continue;
    const value = tryParseObject(s.slice(i, end + 1));
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Index of the `}` matching the `{` at `start`, or -1 if unbalanced. */
function scanBalanced(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
