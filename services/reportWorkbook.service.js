const ExcelJS = require("exceljs");
const { client } = require("../db");
const { orderReferenceClient } = require("../lib/orderReferenceSql");

/**
 * The daily report workbook — the Node half of Django's `orders_report_*.xlsx`.
 *
 * Django built this inside a Celery Beat task, so generating the file and
 * deciding when to send it were the same piece of code. They are separate here:
 * this module only builds a workbook for a given day and returns a Buffer.
 * Whatever triggers it — the npm script, an admin endpoint, or a scheduler
 * later — is somebody else's concern. That is what makes it testable without a
 * broker running.
 *
 * The styling follows the original: navy header row, white body, thin #CCCCCC
 * borders, cell text upper-cased. Uppercase was a quirk of the Django template
 * rather than a considered choice, but operations staff have been reading these
 * for years and diffing last week's against this week's is easier when the
 * shape does not move.
 */

const NAVY = "FF1F3864";
const BORDER = "FFCCCCCC";

const thinBorder = {
  top: { style: "thin", color: { argb: BORDER } },
  left: { style: "thin", color: { argb: BORDER } },
  bottom: { style: "thin", color: { argb: BORDER } },
  right: { style: "thin", color: { argb: BORDER } },
};

/** Django upper-cased every cell. Numbers and dates are left alone. */
const shout = (v) => (typeof v === "string" ? v.toUpperCase() : v);

/**
 * [start, end) for one calendar day, so a row at 23:59 lands in the right report.
 *
 * Bounds are handed to the driver as ISO strings, not Date objects. The raw
 * postgres.js client this module uses rejects a Date parameter outright
 * ("the string argument must be of type string ... received an instance of
 * Date"), which is easy to miss because the failure is a TypeError at bind time
 * rather than a SQL error. `day` is kept alongside for the filename.
 */
const dayBounds = (date) => {
  const startDate = new Date(date);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 1);
  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    day: `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`,
  };
};

const addSheet = (wb, name, columns, rows, emptyMessage) => {
  const sheet = wb.addWorksheet(name);
  sheet.columns = columns.map((c) => ({ ...c, width: c.width || 18 }));

  const header = sheet.getRow(1);
  header.values = columns.map((c) => String(c.header).toUpperCase());
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = thinBorder;
  });
  header.height = 22;

  if (!rows.length) {
    // Django printed "No orders today." in grey rather than leaving a blank
    // sheet, so a reader can tell "nothing happened" from "the job broke".
    const row = sheet.addRow([emptyMessage]);
    row.getCell(1).font = { italic: true, color: { argb: "FF999999" } };
    sheet.mergeCells(row.number, 1, row.number, Math.max(columns.length, 1));
    return sheet;
  }

  for (const r of rows) {
    const row = sheet.addRow(columns.map((c) => shout(r[c.key] ?? "")));
    row.eachCell((cell) => {
      cell.border = thinBorder;
      cell.alignment = { vertical: "middle", horizontal: "left" };
    });
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
};

/** Orders created on `date`, with the customer and product resolved. */
// The reference is derived, never stored: orders.order_number holds an opaque
// ORD- value for 511 orders, and a workbook quoting one names an order nobody
// can look up. See lib/orderReferenceSql.
const ordersFor = async ({ start, end }) => client`
  SELECT ${orderReferenceClient(client, 'o', 'c')} AS order_number, o.status, o.payment_status,
         c.name AS customer, c.company_name,
         p.name AS product, o.quantity, o.total_amount,
         d.name AS depot, o.created_at
  FROM orders o
  LEFT JOIN customers c ON c.id = o.customer_id
  LEFT JOIN products  p ON p.id = o.product_id
  LEFT JOIN depots    d ON d.id = o.depot_id
  WHERE o.created_at >= ${start} AND o.created_at < ${end}
  ORDER BY o.created_at
`;

/** PFI movements on `date` — the "PFI activity" half of the combined report. */
const pfiActivityFor = async ({ start, end }) => client`
  SELECT pf.pfi_number, pr.name AS product, m.qty_litres, m.notes, m.created_at
  FROM pfi_movements m
  LEFT JOIN pfis     pf ON pf.id = m.pfi_id
  LEFT JOIN products pr ON pr.id = pf.product_id
  WHERE m.created_at >= ${start} AND m.created_at < ${end}
  ORDER BY m.created_at
`;

/** Staff daily sales reports submitted on `date`. */
const staffSalesFor = async ({ start, end }) => client`
  SELECT r.report_date, r.product_name, r.opening_stock, r.received_stock,
         r.litres_sold, r.truck_count, r.avg_price, r.status,
         r.reviewed_by_name,
         COALESCE(s.first_name || ' ' || s.surname, '') AS submitted_by
  FROM daily_reports r
  LEFT JOIN staff s ON s.id = r.submitted_by
  WHERE r.created_at >= ${start} AND r.created_at < ${end}
  ORDER BY r.created_at
`;

/**
 * Django's combined daily report: orders plus PFI activity, one sheet each.
 * @returns {Promise<{ buffer: Buffer, filename: string, orderCount: number, pfiCount: number }>}
 */
async function buildDailyReport(date = new Date()) {
  const bounds = dayBounds(date);
  const [orders, pfi] = await Promise.all([ordersFor(bounds), pfiActivityFor(bounds)]);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Soroman System";
  wb.created = new Date();

  addSheet(
    wb,
    "Orders",
    [
      { header: "Order No", key: "order_number", width: 16 },
      { header: "Customer", key: "customer", width: 28 },
      { header: "Company", key: "company_name", width: 26 },
      { header: "Product", key: "product", width: 14 },
      { header: "Quantity", key: "quantity", width: 12 },
      { header: "Total Amount", key: "total_amount", width: 16 },
      { header: "Depot", key: "depot", width: 26 },
      { header: "Status", key: "status", width: 14 },
      { header: "Payment", key: "payment_status", width: 12 },
    ],
    orders,
    "No orders today."
  );

  addSheet(
    wb,
    "PFI Activity",
    [
      { header: "PFI Number", key: "pfi_number", width: 34 },
      { header: "Product", key: "product", width: 14 },
      { header: "Qty (Litres)", key: "qty_litres", width: 14 },
      { header: "Notes", key: "notes", width: 40 },
    ],
    pfi,
    "No PFI activity today."
  );

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return {
    buffer,
    filename: `orders_report_${bounds.day}.xlsx`,
    orderCount: orders.length,
    pfiCount: pfi.length,
  };
}

/** Django's second scheduled mail: the staff sales sheet. */
async function buildStaffSalesReport(date = new Date()) {
  const bounds = dayBounds(date);
  const rows = await staffSalesFor(bounds);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Soroman System";
  wb.created = new Date();

  addSheet(
    wb,
    "Staff Sales",
    [
      { header: "Date", key: "report_date", width: 14 },
      { header: "Submitted By", key: "submitted_by", width: 24 },
      { header: "Product", key: "product_name", width: 14 },
      { header: "Opening Stock", key: "opening_stock", width: 15 },
      { header: "Received", key: "received_stock", width: 13 },
      { header: "Litres Sold", key: "litres_sold", width: 13 },
      { header: "Trucks", key: "truck_count", width: 10 },
      { header: "Avg Price", key: "avg_price", width: 12 },
      { header: "Status", key: "status", width: 12 },
      { header: "Reviewed By", key: "reviewed_by_name", width: 22 },
    ],
    rows,
    "No staff sales reports today."
  );

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return {
    buffer,
    filename: `staff_sales_report_${bounds.day}.xlsx`,
    rowCount: rows.length,
  };
}

module.exports = { buildDailyReport, buildStaffSalesReport, dayBounds };
