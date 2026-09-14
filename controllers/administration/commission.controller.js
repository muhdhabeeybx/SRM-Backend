const asyncHandler = require("express-async-handler");
const commissionRepo = require("../../repositories/commission.repository");
const commissionService = require("../../services/commission.service");

const getCommissions = asyncHandler(async (req, res) => {
  const { search, status, depotId, customerId, dateFrom, dateTo, page, limit } = req.query;
  const result = await commissionRepo.findAll({
    search, status, depotId, customerId, dateFrom, dateTo, page, limit,
    scopeUser: req.user,
  });
  res.json({ success: true, data: result });
});

const getCommissionById = asyncHandler(async (req, res) => {
  const commission = await commissionRepo.findById(parseInt(req.params.id));
  if (!commission) {
    return res.status(404).json({ success: false, message: "Commission not found" });
  }
  res.json({ success: true, data: { commission } });
});

const confirmPayment = asyncHandler(async (req, res) => {
  const result = await commissionService.confirmPayment(
    parseInt(req.params.id),
    req.user.id
  );
  res.json({
    success: true,
    message: `Commission marked paid — ₦${parseFloat(result.commission.commissionAmount).toLocaleString()}`,
    data: result,
  });
});

const skipCommission = asyncHandler(async (req, res) => {
  const result = await commissionService.skipCommission(
    parseInt(req.params.id),
    req.user.id,
    req.body?.reason,
  );
  res.json({
    success: true,
    message: "Commission skipped — nobody was credited",
    data: result,
  });
});

/**
 * Confirm or skip a selection in one request.
 *
 * Partial success is a real outcome and is reported as one: the rows that went
 * through are named, and so is every row that did not, with the reason it gave.
 * Answering 200 for "some of it worked" beats 500 for the same thing, which
 * would leave the desk unable to tell which half landed.
 */
const bulkResolve = asyncHandler(async (req, res) => {
  const { ids, action, reason } = req.body;

  const results = await commissionService.resolveMany({
    ids: ids.map((id) => parseInt(id)),
    action,
    reason,
    staffId: req.user.id,
  });

  const verb = action === "skip" ? "skipped" : "marked paid";
  const message = results.failed.length
    ? `${results.done.length} ${verb}, ${results.failed.length} could not be`
    : `${results.done.length} commission${results.done.length === 1 ? "" : "s"} ${verb}`;

  res.json({ success: results.failed.length === 0, message, data: results });
});

/**
 * Undo a settlement, paid or skipped.
 *
 * The wallet-credit case answers 409 with the deposit it found rather than
 * refusing outright — see the service. The client shows it and can retry with
 * acknowledgeWalletCredit.
 */
const revertCommission = asyncHandler(async (req, res) => {
  try {
    const result = await commissionService.revertToPending(
      parseInt(req.params.id),
      req.user.id,
      {
        reason: req.body?.reason,
        acknowledgeWalletCredit: req.body?.acknowledgeWalletCredit === true,
      },
    );
    res.json({
      success: true,
      message: `Commission moved back to pending from ${result.was}`,
      data: result,
    });
  } catch (err) {
    if (err.code === "WALLET_CREDIT_EXISTS") {
      return res.status(409).json({
        success: false,
        code: err.code,
        message: err.message,
        data: { walletCredit: err.walletCredit },
      });
    }
    throw err;
  }
});

const getSummary = asyncHandler(async (req, res) => {
  const { depotId, customerId, dateFrom, dateTo } = req.query;
  const summary = await commissionRepo.getSummary({ depotId, customerId, dateFrom, dateTo });
  res.json({ success: true, data: { summary } });
});

const getRates = asyncHandler(async (req, res) => {
  const { depotId, page, limit } = req.query;
  const rates = await commissionRepo.getRates({ depotId, page, limit });
  res.json({ success: true, data: { rates } });
});

const upsertRate = asyncHandler(async (req, res) => {
  const { depotId, productId, commissionRate } = req.body;

  const numericRate = Number(commissionRate);
  if (isNaN(numericRate) || numericRate < 0) {
    return res.status(400).json({ success: false, message: "Commission rate must be a valid non-negative number" });
  }

  const rate = await commissionRepo.upsertRate(depotId, productId, numericRate);

  /**
   * Reprice what is already waiting.
   *
   * Setting a rate used to change nothing about the commissions already raised
   * at that depot — 116 of them sit at N0 for exactly that reason. Only
   * pending rows move; a paid commission settled at the rate in force when it
   * was paid.
   */
  const repriced = await commissionService.recomputeForRate(depotId, productId);

  res.json({
    success: true,
    message: repriced.updated
      ? `Commission rate saved — ${repriced.updated} pending commission${repriced.updated === 1 ? "" : "s"} repriced`
      : "Commission rate saved",
    data: { rate, repriced },
  });
});

const generateDailyReport = asyncHandler(async (req, res) => {
  const {
    location, pfi, date, litresSold, truckCount,
    customerCount, orderCount, totalCommissionPaid,
    staffName, remarks,
  } = req.body;

  // Dynamic import — jsPDF is ESM in newer versions
  const { default: jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;

  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  // Header
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("Soroman", pageWidth / 2, 20, { align: "center" });
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text("Daily Commission Report", pageWidth / 2, 28, { align: "center" });

  doc.setDrawColor(200);
  doc.line(14, 32, pageWidth - 14, 32);

  // Report Details
  let y = 40;
  const leftCol = 14;
  const rightCol = pageWidth / 2 + 10;

  doc.setFontSize(10);
  const fields = [
    ["Location:", location || "N/A"],
    ["PFI:", pfi || "N/A"],
    ["Date:", date || new Date().toLocaleDateString()],
    ["Litres Sold:", litresSold || "0"],
    ["Number of Trucks:", truckCount || "0"],
    ["Number of Customers:", customerCount || "0"],
    ["Number of Orders:", orderCount || "0"],
    ["Total Commission Paid:", `NGN ${Number(totalCommissionPaid || 0).toLocaleString()}`],
    ["Staff Name:", staffName || "N/A"],
  ];

  for (const [label, value] of fields) {
    doc.setFont("helvetica", "bold");
    doc.text(label, leftCol, y);
    doc.setFont("helvetica", "normal");
    doc.text(String(value), leftCol + 50, y);
    y += 7;
  }

  // Remarks
  y += 5;
  doc.setFont("helvetica", "bold");
  doc.text("Remarks:", leftCol, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  const remarkLines = doc.splitTextToSize(remarks || "No remarks", pageWidth - 28);
  doc.text(remarkLines, leftCol, y);
  y += remarkLines.length * 5 + 15;

  // Signature Lines
  doc.setDrawColor(150);
  doc.line(leftCol, y, leftCol + 60, y);
  doc.line(rightCol, y, rightCol + 60, y);
  y += 5;
  doc.setFontSize(9);
  doc.text("Prepared By", leftCol, y);
  doc.text("Approved By", rightCol, y);

  // Footer
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text(
    `Generated on ${new Date().toLocaleString()}`,
    pageWidth / 2,
    doc.internal.pageSize.getHeight() - 10,
    { align: "center" }
  );

  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=daily-commission-report-${date || "today"}.pdf`);
  res.send(pdfBuffer);
});

module.exports = {
  getCommissions,
  getCommissionById,
  confirmPayment,
  skipCommission,
  revertCommission,
  bulkResolve,
  getSummary,
  getRates,
  upsertRate,
  generateDailyReport,
};
