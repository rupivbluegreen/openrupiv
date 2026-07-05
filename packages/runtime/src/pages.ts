/**
 * Server-rendered HTML pages (list / detail / form) per the app spec.
 *
 * Plain HTML, zero client-side framework. EVERY interpolated value passes
 * through escapeHtml — user data, spec titles, ids, all of it. Forms POST to
 * the entity API; workflow transitions render as one-button forms POSTing to
 * the transition endpoints.
 */

import type { AppSpec, EntityDef, FieldDef, PageDef } from "@openrupiv/spec";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "./db";
import { RuntimeError } from "./errors";
import type { Logger } from "./logger";
import { columnFor, isUuid, quoteIdent, toSnakeCase } from "./naming";
import {
  buildEntityModel,
  pageFor,
  rowToRecord,
  type EntityModel,
} from "./records";

/** Escape a value for safe interpolation into HTML text or attributes. */
export function escapeHtml(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #1a202c; }
  nav { display: flex; gap: 1rem; align-items: baseline; border-bottom: 1px solid #cbd5e0; padding-bottom: 0.75rem; margin-bottom: 1.5rem; }
  nav .spacer { flex: 1; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #cbd5e0; padding: 0.4rem 0.6rem; text-align: left; }
  th { background: #edf2f7; }
  form.inline { display: inline; }
  label { display: block; margin-top: 0.75rem; font-weight: 600; }
  input, select, textarea { display: block; margin-top: 0.25rem; padding: 0.35rem; min-width: 20rem; }
  button { margin-top: 1rem; padding: 0.4rem 1rem; cursor: pointer; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1.5rem; }
  dt { font-weight: 600; }
  .muted { color: #4a5568; font-size: 0.9rem; }
`;

function layout(
  title: string,
  user: { sub: string; email?: string } | undefined,
  body: string,
): string {
  const who = user ? escapeHtml(user.email ?? user.sub) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<nav>
  <a href="/">Pages</a>
  <span class="spacer"></span>
  <span class="muted">${who}</span>
  <form class="inline" method="post" action="/auth/logout"><button type="submit">Log out</button></form>
</nav>
<main>
${body}
</main>
</body>
</html>
`;
}

async function sendHtml(reply: FastifyReply, html: string): Promise<void> {
  await reply.header("content-type", "text/html; charset=utf-8").send(html);
}

function fieldsForPage(page: PageDef, entity: EntityDef): FieldDef[] {
  const byName = new Map(entity.fields.map((f) => [f.name, f]));
  if (!page.fields) return entity.fields;
  const selected: FieldDef[] = [];
  for (const name of page.fields) {
    const field = byName.get(name);
    if (field) selected.push(field);
  }
  return selected;
}

export function registerPages(
  app: FastifyInstance,
  spec: AppSpec,
  db: Db,
  logger: Logger,
): void {
  const pages = spec.pages ?? [];

  app.get("/", async (request, reply) => {
    const items = pages
      .map(
        (page) =>
          `<li><a href="/p/${escapeHtml(page.name)}">${escapeHtml(page.title ?? page.name)}</a>` +
          ` <span class="muted">(${escapeHtml(page.type)} · ${escapeHtml(page.entity)})</span></li>`,
      )
      .join("\n");
    const body = `<h1>${escapeHtml(spec.app.name)}</h1>
<p class="muted">${escapeHtml(spec.app.description ?? "")}</p>
<ul>
${items}
</ul>`;
    await sendHtml(reply, layout(spec.app.name, request.session, body));
  });

  for (const page of pages) {
    const entity = spec.entities.find((e) => e.name === page.entity);
    if (!entity) {
      throw new RuntimeError(
        "ERR_APP_SPEC_INVALID",
        `page ${page.name} references unknown entity ${page.entity}`,
      );
    }
    const model = buildEntityModel(spec, entity);

    switch (page.type) {
      case "list":
        registerListPage(app, spec, page, model, db);
        break;
      case "detail":
        registerDetailPage(app, spec, page, model, db);
        break;
      case "form":
        registerFormPage(app, spec, page, model, db, logger);
        break;
    }
  }
}

function registerListPage(
  app: FastifyInstance,
  spec: AppSpec,
  page: PageDef,
  model: EntityModel,
  db: Db,
): void {
  const fields = fieldsForPage(page, model.entity);
  const detailPage = pageFor(spec, model.entity.name, "detail");
  const formPage = pageFor(spec, model.entity.name, "form");

  app.get(`/p/${page.name}`, async (request, reply) => {
    const result = await db.query(
      `SELECT * FROM ${quoteIdent(model.table)} ORDER BY created_at DESC, id`,
    );
    const records = result.rows.map((row) => rowToRecord(model, row));

    const head = fields.map((f) => `<th>${escapeHtml(f.name)}</th>`).join("");
    const rows = records
      .map((record) => {
        const cells = fields
          .map((f) => `<td>${escapeHtml(record[f.name])}</td>`)
          .join("");
        const link = detailPage
          ? `<td><a href="/p/${escapeHtml(detailPage.name)}?id=${escapeHtml(record["id"])}">view</a></td>`
          : "";
        return `<tr>${cells}${link}</tr>`;
      })
      .join("\n");

    const newLink = formPage
      ? `<p><a href="/p/${escapeHtml(formPage.name)}">New ${escapeHtml(model.entity.name)}</a></p>`
      : "";
    const body = `<h1>${escapeHtml(page.title ?? page.name)}</h1>
${newLink}
<table>
<thead><tr>${head}${detailPage ? "<th></th>" : ""}</tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
    await sendHtml(reply, layout(page.title ?? page.name, request.session, body));
  });
}

function registerDetailPage(
  app: FastifyInstance,
  spec: AppSpec,
  page: PageDef,
  model: EntityModel,
  db: Db,
): void {
  const fields = fieldsForPage(page, model.entity);
  const hasApprovals = model.workflows.some((w) =>
    w.transitions.some((t) => t.approval !== undefined),
  );

  app.get<{ Querystring: { id?: string } }>(
    `/p/${page.name}`,
    async (request, reply) => {
      const id = request.query.id;
      if (!isUuid(id)) {
        throw new RuntimeError(
          "ERR_VALIDATION",
          "detail pages require an ?id=<uuid> query parameter",
          { statusCode: 400 },
        );
      }
      const result = await db.query(
        `SELECT * FROM ${quoteIdent(model.table)} WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) {
        throw new RuntimeError(
          "ERR_NOT_FOUND",
          `${model.entity.name} ${id} not found`,
          { statusCode: 404 },
        );
      }
      const record = rowToRecord(model, row);

      const detail = fields
        .map(
          (f) =>
            `<dt>${escapeHtml(f.name)}</dt><dd>${escapeHtml(record[f.name])}</dd>`,
        )
        .join("\n");

      let workflowHtml = "";
      if (model.workflows.length > 0) {
        let approvalCounts = new Map<string, number>();
        if (hasApprovals) {
          const counts = await db.query(
            "SELECT transition, COUNT(DISTINCT approver_sub)::int AS approvals " +
              "FROM workflow_approvals WHERE entity_table = $1 AND record_id = $2 " +
              "GROUP BY transition ORDER BY transition",
            [model.table, id],
          );
          approvalCounts = new Map(
            counts.rows.map((r) => [
              String(r["transition"]),
              Number(r["approvals"]),
            ]),
          );
        }

        const sections = model.workflows.map((workflow) => {
          const currentState = row[toSnakeCase(workflow.stateField)];
          const buttons = workflow.transitions
            .filter((t) => t.from === currentState)
            .map((t) => {
              const count = approvalCounts.get(t.name) ?? 0;
              const approvalNote = t.approval
                ? ` <span class="muted">(${count} of ${t.approval.count} approvals)</span>`
                : "";
              return (
                `<form class="inline" method="post" action="/api/${escapeHtml(model.apiSegment)}/${escapeHtml(id)}/transitions/${escapeHtml(t.name)}">` +
                `<button type="submit">${escapeHtml(t.name)}</button></form>${approvalNote}`
              );
            })
            .join("\n");
          return `<h2>Workflow: ${escapeHtml(workflow.name)}</h2>
<p>Current state: <strong>${escapeHtml(currentState)}</strong></p>
${buttons || '<p class="muted">No transitions available from this state.</p>'}`;
        });
        workflowHtml = sections.join("\n");
      }

      const body = `<h1>${escapeHtml(page.title ?? page.name)}</h1>
<dl>
${detail}
</dl>
${workflowHtml}`;
      await sendHtml(reply, layout(page.title ?? page.name, request.session, body));
    },
  );
}

function inputFor(field: FieldDef): string {
  const name = escapeHtml(field.name);
  const required = field.required === true ? " required" : "";
  switch (field.type) {
    case "text":
      return `<textarea id="${name}" name="${name}" rows="4"${required}></textarea>`;
    case "number":
      return `<input id="${name}" type="number" step="any" name="${name}"${required}>`;
    case "boolean":
      return `<input id="${name}" type="checkbox" name="${name}" value="true">`;
    case "date":
      return `<input id="${name}" type="date" name="${name}"${required}>`;
    case "datetime":
      return `<input id="${name}" type="datetime-local" name="${name}"${required}>`;
    case "enum": {
      const blank = field.required === true ? "" : `<option value=""></option>`;
      const options = (field.values ?? [])
        .map((v) => {
          const selected = field.default === v ? " selected" : "";
          return `<option value="${escapeHtml(v)}"${selected}>${escapeHtml(v)}</option>`;
        })
        .join("");
      return `<select id="${name}" name="${name}"${required}>${blank}${options}</select>`;
    }
    case "string":
    case "reference":
      return `<input id="${name}" type="text" name="${name}"${required}>`;
  }
}

/** Best human label for a referenced record: its first string field, else id. */
function labelField(entity: EntityDef): FieldDef | undefined {
  return entity.fields.find((f) => f.type === "string");
}

function registerFormPage(
  app: FastifyInstance,
  spec: AppSpec,
  page: PageDef,
  model: EntityModel,
  db: Db,
  logger: Logger,
): void {
  // Workflow state fields are server-set; never render an input for them.
  const fields = fieldsForPage(page, model.entity).filter(
    (f) => !model.stateFields.has(f.name),
  );

  app.get(`/p/${page.name}`, async (request, reply) => {
    const controls: string[] = [];
    for (const field of fields) {
      let control: string;
      if (field.type === "reference" && field.entity) {
        const target = spec.entities.find((e) => e.name === field.entity);
        if (!target) {
          throw new RuntimeError(
            "ERR_APP_SPEC_INVALID",
            `reference field ${field.name} targets unknown entity ${field.entity}`,
          );
        }
        const targetModel = buildEntityModel(spec, target);
        const result = await db.query(
          `SELECT * FROM ${quoteIdent(targetModel.table)} ORDER BY created_at DESC, id`,
        );
        const label = labelField(target);
        const blank = field.required === true ? "" : `<option value=""></option>`;
        const options = result.rows
          .map((row) => {
            const record = rowToRecord(targetModel, row);
            const text = label ? (record[label.name] ?? record["id"]) : record["id"];
            return `<option value="${escapeHtml(record["id"])}">${escapeHtml(text)}</option>`;
          })
          .join("");
        const required = field.required === true ? " required" : "";
        control = `<select id="${escapeHtml(field.name)}" name="${escapeHtml(field.name)}"${required}>${blank}${options}</select>`;
      } else {
        control = inputFor(field);
      }
      controls.push(
        `<label for="${escapeHtml(field.name)}">${escapeHtml(field.name)}</label>\n${control}`,
      );
    }

    const body = `<h1>${escapeHtml(page.title ?? page.name)}</h1>
<form method="post" action="/api/${escapeHtml(model.apiSegment)}">
${controls.join("\n")}
<button type="submit">Create</button>
</form>`;
    logger.debug(
      { event: "page.form_rendered", page: page.name, entityTable: model.table },
      "form page rendered",
    );
    await sendHtml(reply, layout(page.title ?? page.name, request.session, body));
  });
}
