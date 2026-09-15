const asyncHandler = require("express-async-handler");
const gateQueue = require("../../services/gateQueue.service");

/**
 * The gate's queue, filtered — GET /orders/gate-queue/:stage
 *
 * Both gate pages could only be used by searching for an order, which assumes
 * the officer already knows the reference for the truck in front of them. This
 * is the other direction: everything the gate is waiting on, with the summary
 * above it computed from the same filters as the rows beneath.
 */
const getGateQueue = asyncHandler(async (req, res) => {
  const { stage } = req.params;
  if (!gateQueue.STAGES[stage]) {
    return res.status(400).json({ success: false, message: "Stage must be entry or exit" });
  }

  const { from, to, pfiId, depotId, search, page, limit } = req.query;

  /**
   * Scope from the session, never from the query.
   *
   * A gate officer sees their own locations, and the filters narrow within
   * that rather than escaping it — otherwise the depot dropdown becomes a way
   * to read another depot's yard.
   */
  const scope = {
    all: Boolean(req.user?.canViewAllLocations),
    depotIds: req.user?.scope?.depotIds || [],
    pfiIds: req.user?.scope?.pfiIds || [],
  };

  const data = await gateQueue.forStage(stage, {
    from: from || null,
    to: to || null,
    pfiId: pfiId || null,
    depotId: depotId || null,
    search: search || null,
    page: page || 1,
    limit: limit || 100,
    scope,
  });

  res.json({ success: true, data });
});

module.exports = { getGateQueue };
