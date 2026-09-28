const { sql } = require("drizzle-orm");
const { db } = require("../config/db");

/**
 * Who is changing a PFI assignment, and how — for the record.
 *
 * pfi_assignment_log is written by a trigger on pfi_staff (migration 0060), so
 * every change is recorded whichever path makes it. A trigger cannot see the
 * request, though, so the application tells it: these settings are local to
 * the transaction, the trigger reads them, and they vanish when it ends. A
 * change made without them is still recorded — as 'unattributed', with no
 * actor — which is the honest answer for a script or a hand-run statement.
 *
 * Call it inside the same transaction as the change, before it.
 */

/** How an assignment changed. Stored on the log, so these values are permanent. */
const SOURCES = {
  MANAGE_USERS: "manage_users",
  PFI_ACTIVATION: "pfi_activation",
  ACCOUNT_DELETED: "account_deleted",
  PFI_DELETED: "pfi_deleted",
};

/** The context of a change made by the person behind this request. */
const contextFromRequest = (req, source, note = "") => ({
  actorId: req?.user?.id ?? null,
  source,
  note,
  ip: req?.ip || "",
  userAgent: req?.headers?.["user-agent"] || "",
});

/** Set the context on a transaction, ahead of the change it describes. */
const setAssignmentContext = async (tx, ctx = {}) => {
  await tx.execute(sql`SELECT
    set_config('soroman.actor_staff_id', ${ctx.actorId != null ? String(ctx.actorId) : ""}, true),
    set_config('soroman.assignment_source', ${String(ctx.source || "")}, true),
    set_config('soroman.assignment_note', ${String(ctx.note || "").slice(0, 1000)}, true),
    set_config('soroman.ip_address', ${String(ctx.ip || "").slice(0, 100)}, true),
    set_config('soroman.user_agent', ${String(ctx.userAgent || "").slice(0, 500)}, true)`);
};

/** Run `work(tx)` in a transaction that carries this context. */
const withAssignmentContext = (ctx, work) =>
  db.transaction(async (tx) => {
    await setAssignmentContext(tx, ctx);
    return work(tx);
  });

module.exports = { SOURCES, contextFromRequest, setAssignmentContext, withAssignmentContext };
