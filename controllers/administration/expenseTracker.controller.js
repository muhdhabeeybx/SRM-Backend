const asyncHandler = require("express-async-handler");
const service = require("../../services/expenseTracker.service");

/** Check (dryRun) or record the LPG plants' expenses tracker — see the service. */
const uploadTracker = asyncHandler(async (req, res) => {
  const data = await service.importTracker({
    rows: req.body.rows,
    dryRun: req.body.dryRun === true,
    enteredBy: req.body.enteredBy ?? null,
    user: req.user,
  });
  const { summary, recorded } = data;
  const message = recorded
    ? `${recorded} expense${recorded === 1 ? "" : "s"} recorded as paid`
    : summary.errors
      ? `${summary.errors} row${summary.errors === 1 ? "" : "s"} to fix — nothing recorded`
      : summary.toRecord ? "Checked — nothing recorded yet" : "Nothing new to record";
  res.status(recorded ? 201 : 200).json({ success: true, message, data });
});

module.exports = { uploadTracker };
