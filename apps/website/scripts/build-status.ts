import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ReadinessLevel = "shipped" | "in_progress" | "planned" | "not_planned";

export interface ReadinessItem {
  section: string;
  requirement: string;
  level: ReadinessLevel;
  detail: string;
}

const LEVEL_BY_EMOJI: Record<string, ReadinessLevel> = {
  "✅": "shipped",
  "🚧": "in_progress",
  "📋": "planned",
  "❌": "not_planned",
};

/**
 * Parses ENTERPRISE_READINESS.md's `## Section` + `| Requirement | Status |`
 * table structure into structured items. Throws if the file's format has
 * drifted in a way this parser can't recognize — this build step must fail
 * loudly rather than silently ship stale/empty status (CLAUDE.md #2).
 */
export function parseReadiness(markdown: string): ReadinessItem[] {
  const lines = markdown.split("\n");
  const items: ReadinessItem[] = [];
  let currentSection = "";

  for (const line of lines) {
    const sectionMatch = /^## (.+)$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!.trim();
      continue;
    }

    const rowMatch = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (!rowMatch || !currentSection) continue;

    const requirement = rowMatch[1]!.trim();
    const statusText = rowMatch[2]!.trim();
    if (requirement === "Requirement" || /^-+$/.test(requirement.replace(/\s/g, ""))) continue;

    const matchedEmoji = Object.keys(LEVEL_BY_EMOJI).find((emoji) => statusText.startsWith(emoji));
    if (!matchedEmoji) continue;

    items.push({
      section: currentSection,
      requirement,
      level: LEVEL_BY_EMOJI[matchedEmoji]!,
      detail: statusText.slice(matchedEmoji.length).trim(),
    });
  }

  if (items.length === 0) {
    throw new Error(
      "parseReadiness: found zero status rows — ENTERPRISE_READINESS.md's format may have changed; refusing to ship an empty status section",
    );
  }
  return items;
}

export function buildStatusJson(readinessMarkdownPath: string, outputJsonPath: string): void {
  const markdown = readFileSync(readinessMarkdownPath, "utf8");
  const items = parseReadiness(markdown);
  writeFileSync(outputJsonPath, JSON.stringify(items, null, 2));
}

// CLI entry point: `tsx scripts/build-status.ts`, run from apps/website/.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildStatusJson(
    fileURLToPath(new URL("../../../ENTERPRISE_READINESS.md", import.meta.url)),
    fileURLToPath(new URL("../public/status.json", import.meta.url)),
  );
  // eslint-disable-next-line no-console
  console.log("apps/website/public/status.json regenerated from ENTERPRISE_READINESS.md");
}
