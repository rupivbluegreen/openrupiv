type ReadinessLevel = "shipped" | "in_progress" | "planned" | "not_planned";

interface ReadinessItem {
  section: string;
  requirement: string;
  level: ReadinessLevel;
  detail: string;
}

const LEVEL_LABEL: Record<ReadinessLevel, string> = {
  shipped: "Shipped",
  in_progress: "In progress",
  planned: "Planned",
  not_planned: "Not planned",
};

const COUNT_LABEL: Record<ReadinessLevel, string> = {
  shipped: "shipped",
  in_progress: "in progress",
  planned: "planned",
  not_planned: "not planned",
};

const LEVEL_ORDER: ReadinessLevel[] = ["shipped", "in_progress", "planned", "not_planned"];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Tallies items by level -- the ONLY source for the summary counts rendered
 * in each category's <summary>, so the counts can never drift from the
 * detailed per-item list rendered inside the same <details>. */
function countByLevel(items: ReadinessItem[]): Record<ReadinessLevel, number> {
  const counts: Record<ReadinessLevel, number> = { shipped: 0, in_progress: 0, planned: 0, not_planned: 0 };
  for (const item of items) counts[item.level] += 1;
  return counts;
}

/** Renders one pill per level with at least one item, in a fixed order; a
 * category with zero items at a given level shows no pill for it at all. */
function renderCounts(counts: Record<ReadinessLevel, number>): string {
  return LEVEL_ORDER.filter((level) => counts[level] > 0)
    .map((level) => `<span class="status-count status-count-${level}">${counts[level]} ${COUNT_LABEL[level]}</span>`)
    .join("");
}

/**
 * Fetches the build-time-generated status.json and renders it as one
 * collapsed-by-default <details> per section, each summarizing its
 * shipped/in-progress/planned counts and expanding to the full detail list.
 */
export async function renderStatus(containerEl: HTMLElement): Promise<void> {
  const res = await fetch("./status.json");
  if (!res.ok) {
    containerEl.textContent = "Status unavailable.";
    return;
  }
  const items = (await res.json()) as ReadinessItem[];

  const bySection = new Map<string, ReadinessItem[]>();
  for (const item of items) {
    const list = bySection.get(item.section) ?? [];
    list.push(item);
    bySection.set(item.section, list);
  }

  containerEl.innerHTML = [...bySection.entries()]
    .map(([section, sectionItems]) => {
      const counts = countByLevel(sectionItems);
      const detailItems = sectionItems
        .map(
          (item) =>
            `<li class="status-${item.level}"><strong>${escapeHtml(item.requirement)}:</strong> ${LEVEL_LABEL[item.level]}${
              item.detail ? ` — ${escapeHtml(item.detail)}` : ""
            }</li>`,
        )
        .join("");
      return `
        <details class="status-category">
          <summary>
            <span class="status-category-name">${escapeHtml(section)}</span>
            <span class="status-counts">${renderCounts(counts)}</span>
          </summary>
          <ul class="status-detail-list">${detailItems}</ul>
        </details>
      `;
    })
    .join("");
}
