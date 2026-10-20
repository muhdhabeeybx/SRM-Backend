const { client } = require("../db");

/**
 * What each trip's AGO comes to on the AGO stock ledger (0093): given +
 * top-ups − retrieved, for the trips that have any. Delivery Costing reads it
 * in place of the figure typed on the trip, which stays in its column — so a
 * trip whose ledger entries are all deleted shows the typed figure again.
 *
 * @param {number[]} tripIds  delivery_inventory ids
 * @returns {Promise<Map<number, number>>}  trip id → litres, two decimals
 */
async function tripAgoFor(tripIds, tx = client) {
  const ids = [...new Set((tripIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  const rows = await tx`
    SELECT trip_id, SUM(CASE WHEN kind = 'retrieved' THEN -litres ELSE litres END) AS net
      FROM ago_stock_entries
     WHERE deleted_at IS NULL AND kind IN ('given', 'top_up', 'retrieved') AND trip_id = ANY(${ids}::int[])
     GROUP BY trip_id`;
  return new Map(rows.map((r) => [Number(r.trip_id), Math.round(Number(r.net) * 100) / 100]));
}

module.exports = { tripAgoFor };
