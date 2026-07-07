export type SectionId =
  | "hero"
  | "pillar-sso"
  | "pillar-git"
  | "pillar-compliance"
  | "pillar-agents"
  | "roadmap"
  | "status";

const ALL_SECTION_IDS: readonly SectionId[] = [
  "hero",
  "pillar-sso",
  "pillar-git",
  "pillar-compliance",
  "pillar-agents",
  "roadmap",
  "status",
];

/**
 * Runtime guard for `SectionId`. `index.html`'s section ids and this
 * union are both hand-maintained; if they ever drift (a section renamed
 * or added/removed on one side but not the other), an unrecognized string
 * must never reach `computeLayout` — its `PILLAR_CENTERS[section]!`
 * non-null assertion would throw an uncaught `TypeError` deep in the
 * render loop with no useful error message. Callers should skip elements
 * that fail this check rather than force-casting them.
 */
export function isSectionId(value: string): value is SectionId {
  return (ALL_SECTION_IDS as readonly string[]).includes(value);
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Deterministic, evenly-distributed scatter across a sphere (Fibonacci sphere) — the ambient "hero" state. */
function fibonacciSphere(index: number, total: number, radius: number): Vec3Like {
  const y = total > 1 ? 1 - (index / (total - 1)) * 2 : 0;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * index;
  return { x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius };
}

/** Which node indices belong to which pillar cluster — deterministic partition by index modulo 4. */
function pillarMembers(total: number, pillarIndex: number): number[] {
  const members: number[] = [];
  for (let i = 0; i < total; i++) {
    if (i % 4 === pillarIndex) members.push(i);
  }
  return members;
}

const PILLAR_ORDER: readonly SectionId[] = ["pillar-sso", "pillar-git", "pillar-compliance", "pillar-agents"];

const PILLAR_CENTERS: Record<string, Vec3Like> = {
  "pillar-sso": { x: -3, y: 1, z: 0 },
  "pillar-git": { x: 3, y: 1, z: 0 },
  "pillar-compliance": { x: -3, y: -1, z: 0 },
  "pillar-agents": { x: 3, y: -1, z: 0 },
};

/**
 * Nodes belonging to this pillar arrange in a ring around `center`; other nodes fall back to a
 * Fibonacci-sphere position (unique per index, never collides) translated by `center`, so each
 * pillar's non-member nodes drift to a distinct faint outer sphere around that pillar's own center.
 */
function clusterLayout(
  index: number,
  total: number,
  memberIndices: number[],
  center: Vec3Like,
  clusterRadius: number,
  fallbackRadius: number,
): Vec3Like {
  const memberPos = memberIndices.indexOf(index);
  if (memberPos === -1) {
    const fallback = fibonacciSphere(index, total, fallbackRadius);
    return { x: center.x + fallback.x, y: center.y + fallback.y, z: center.z + fallback.z };
  }
  const angle = GOLDEN_ANGLE * memberPos;
  const ringR = clusterRadius * (0.3 + 0.7 * (memberPos / Math.max(1, memberIndices.length - 1)));
  return {
    x: center.x + Math.cos(angle) * ringR,
    y: center.y + Math.sin(angle) * ringR * 0.6,
    z: center.z + Math.sin(angle * 0.5) * ringR * 0.4,
  };
}

/** Evenly spaced along x into 6 phase columns (Phase 0–5), nodes distributed round-robin into columns. */
function roadmapLayout(index: number, total: number): Vec3Like {
  const phase = index % 6;
  const withinPhase = Math.floor(index / 6);
  const countInPhase = Math.ceil(total / 6);
  const x = -5 + phase * 2;
  const y = countInPhase > 1 ? -1.5 + (withinPhase / (countInPhase - 1)) * 3 : 0;
  return { x, y, z: 0 };
}

/** A calm settled grid — the "status" state. */
function statusLayout(index: number, total: number): Vec3Like {
  const cols = Math.ceil(Math.sqrt(total));
  const row = Math.floor(index / cols);
  const col = index % cols;
  return { x: (col - cols / 2) * 1.2, y: (row - cols / 2) * 1.2, z: 0 };
}

export function computeLayout(section: SectionId, index: number, total: number): Vec3Like {
  if (section === "hero") return fibonacciSphere(index, total, 5);
  if (section === "roadmap") return roadmapLayout(index, total);
  if (section === "status") return statusLayout(index, total);

  const pillarIndex = PILLAR_ORDER.indexOf(section);
  const members = pillarMembers(total, pillarIndex);
  return clusterLayout(index, total, members, PILLAR_CENTERS[section]!, 1.6, 6);
}
