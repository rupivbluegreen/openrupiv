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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fetches the build-time-generated status.json and renders it, grouped by section, into `containerEl`. */
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
    .map(
      ([section, sectionItems]) => `
        <div class="status-section">
          <h4>${escapeHtml(section)}</h4>
          <ul>
            ${sectionItems
              .map(
                (item) =>
                  `<li class="status-${item.level}"><strong>${escapeHtml(item.requirement)}:</strong> ${LEVEL_LABEL[item.level]}</li>`,
              )
              .join("")}
          </ul>
        </div>
      `,
    )
    .join("");
}
