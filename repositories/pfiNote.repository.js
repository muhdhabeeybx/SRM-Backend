const { client } = require("../config/db");
const { isoFields } = require("./pfiFile.repository");

/**
 * Notes on a PFI — the file's own narrative. See migration 0058.
 *
 * Written straight in SQL rather than through Drizzle so every read returns
 * `occurredOn` as the plain calendar day it is ("2026-09-12"). A `date` read as
 * a JavaScript Date is midnight UTC, which a browser in Lagos renders as the
 * day it was, and one anywhere west of Greenwich renders as the day before.
 */

const httpError = (status, message) => Object.assign(new Error(message), { status, statusCode: status });

const NOTE_KINDS = ["note", "issue", "decision"];

/**
 * Before migration 0058 has run, there is no pfi_notes table.
 *
 * The code can reach a server before the migration reaches its database, and
 * the PFI file and both reports read notes. A missing table must not take
 * those down with it: reads answer "no notes", and only a write — which has
 * nowhere to go — says why it cannot.
 */
const noTable = (err) => err && err.code === "42P01";
const notesUnavailable = () =>
  httpError(503, "Notes are not available yet — the database has not been updated for them (migration 0058).");

const COLUMNS = client`
  n.id, n.pfi_id AS "pfiId", n.kind, n.body,
  n.occurred_on::text AS "occurredOn",
  n.author_id AS "authorId", n.author_name AS "authorName",
  n.created_at AS "createdAt", n.updated_at AS "updatedAt",
  -- A second's grace: the insert stamps both columns, and a note is only
  -- "edited" when somebody changed it afterwards.
  (n.updated_at > n.created_at + interval '1 second') AS edited
`;

const STAMPS = ["createdAt", "updatedAt", "deletedAt"];

/** A PFI's live notes, in the order things happened — newest first. */
const listFor = async (pfiId) => {
  try {
    return (await client`
      SELECT ${COLUMNS}
        FROM pfi_notes n
       WHERE n.pfi_id = ${Number(pfiId)} AND n.deleted_at IS NULL
       ORDER BY n.occurred_on DESC, n.id DESC
    `).map((r) => isoFields(r, STAMPS));
  } catch (err) {
    if (noTable(err)) return [];
    throw err;
  }
};

const findById = async (noteId) => {
  try {
    const [row] = await client`
      SELECT ${COLUMNS}, n.deleted_at AS "deletedAt"
        FROM pfi_notes n
       WHERE n.id = ${Number(noteId)}
    `;
    return row ? isoFields(row, STAMPS) : null;
  } catch (err) {
    if (noTable(err)) throw notesUnavailable();
    throw err;
  }
};

const create = async ({ pfiId, kind = "note", body, occurredOn = null, authorId = null, authorName = "" }) => {
  let row;
  try {
    [row] = await client`
      INSERT INTO pfi_notes (pfi_id, kind, body, occurred_on, author_id, author_name)
      VALUES (
        ${Number(pfiId)}, ${kind}, ${String(body).trim()},
        COALESCE(${occurredOn}::date, CURRENT_DATE),
        ${authorId}, ${authorName}
      )
      RETURNING id
    `;
  } catch (err) {
    if (noTable(err)) throw notesUnavailable();
    throw err;
  }
  return findById(row.id);
};

/** Only the words, the kind and the day move. Who wrote it never does. */
const update = async (noteId, { kind, body, occurredOn }) => {
  const [row] = await client`
    UPDATE pfi_notes
       SET kind = COALESCE(${kind ?? null}, kind),
           body = COALESCE(${body == null ? null : String(body).trim()}, body),
           occurred_on = COALESCE(${occurredOn ?? null}::date, occurred_on),
           updated_at = now()
     WHERE id = ${Number(noteId)} AND deleted_at IS NULL
     RETURNING id
  `;
  if (!row) throw httpError(404, "Note not found");
  return findById(row.id);
};

/** Withdrawn, not erased — see the migration. */
const softDelete = async (noteId, { staffId = null, staffName = "" } = {}) => {
  const [row] = await client`
    UPDATE pfi_notes
       SET deleted_at = now(), deleted_by = ${staffId}, deleted_by_name = ${staffName}
     WHERE id = ${Number(noteId)} AND deleted_at IS NULL
     RETURNING id
  `;
  if (!row) throw httpError(404, "Note not found");
  return row;
};

/**
 * How many notes each PFI carries, and the latest one — for the register,
 * which lists every PFI and cannot afford a query per row.
 *
 * @returns {Promise<Map<number, {count:number, issues:number, decisions:number, latest:object|null}>>}
 */
const summaryFor = async (ids) => {
  const out = new Map();
  const list = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!list.length) return out;

  let rows;
  try {
    rows = await client`
    SELECT DISTINCT ON (n.pfi_id)
           n.pfi_id AS "pfiId",
           COUNT(*) OVER (PARTITION BY n.pfi_id)::int AS count,
           COUNT(*) FILTER (WHERE n.kind = 'issue') OVER (PARTITION BY n.pfi_id)::int AS issues,
           COUNT(*) FILTER (WHERE n.kind = 'decision') OVER (PARTITION BY n.pfi_id)::int AS decisions,
           n.kind, n.body, n.occurred_on::text AS "occurredOn", n.author_name AS "authorName"
      FROM pfi_notes n
     WHERE n.pfi_id = ANY(${list}) AND n.deleted_at IS NULL
     ORDER BY n.pfi_id, n.occurred_on DESC, n.id DESC
  `;
  } catch (err) {
    if (noTable(err)) return out;
    throw err;
  }
  for (const r of rows) {
    out.set(Number(r.pfiId), {
      count: r.count,
      issues: r.issues,
      decisions: r.decisions,
      latest: { kind: r.kind, body: r.body, occurredOn: r.occurredOn, authorName: r.authorName },
    });
  }
  return out;
};

module.exports = { NOTE_KINDS, listFor, findById, create, update, softDelete, summaryFor };
