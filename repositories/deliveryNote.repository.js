const { eq, and, desc, count } = require("drizzle-orm");
const { db } = require("../config/db");
const { deliveryNotes, deliveryCustomers, orders } = require("../db/schema");
const { dayEdge, lagosToday, localDateStr } = require("../lib/zonedDay");

const findById = async (id) => {
  const [row] = await db
    .select()
    .from(deliveryNotes)
    .where(eq(deliveryNotes.id, id))
    .limit(1);
  return row || null;
};

const findByNumber = async (deliveryNoteNumber) => {
  const [row] = await db
    .select()
    .from(deliveryNotes)
    .where(eq(deliveryNotes.deliveryNoteNumber, deliveryNoteNumber))
    .limit(1);
  return row || null;
};

const findAll = async ({ customer, page = 1, limit = 50 } = {}) => {
  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * limitNum;

  const whereClause = customer
    ? eq(deliveryNotes.customerId, customer)
    : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: deliveryNotes.id,
        deliveryNoteNumber: deliveryNotes.deliveryNoteNumber,
        customerId: deliveryNotes.customerId,
        customerTypeSnapshot: deliveryNotes.customerTypeSnapshot,
        orderId: deliveryNotes.orderId,
        deliveryAddress: deliveryNotes.deliveryAddress,
        contactPersonOnSite: deliveryNotes.contactPersonOnSite,
        product: deliveryNotes.product,
        quantityDelivered: deliveryNotes.quantityDelivered,
        unit: deliveryNotes.unit,
        driver: deliveryNotes.driver,
        truck: deliveryNotes.truck,
        depotOfLoading: deliveryNotes.depotOfLoading,
        dispatchDate: deliveryNotes.dispatchDate,
        expectedDeliveryDate: deliveryNotes.expectedDeliveryDate,
        status: deliveryNotes.status,
        remarks: deliveryNotes.remarks,
        createdBy: deliveryNotes.createdBy,
        createdAt: deliveryNotes.createdAt,
        updatedAt: deliveryNotes.updatedAt,
        customerName: deliveryCustomers.name,
        customerCode: deliveryCustomers.customerCode,
      })
      .from(deliveryNotes)
      .leftJoin(
        deliveryCustomers,
        eq(deliveryNotes.customerId, deliveryCustomers.id)
      )
      .where(whereClause)
      .orderBy(desc(deliveryNotes.createdAt))
      .limit(limitNum)
      .offset(offset),
    db
      .select({ total: count() })
      .from(deliveryNotes)
      .where(whereClause),
  ]);

  return {
    deliveryNotes: rows,
    pagination: {
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    },
  };
};

const create = async (data) => {
  const [row] = await db.insert(deliveryNotes).values(data).returning();
  return row;
};

const update = async (id, data) => {
  const [row] = await db
    .update(deliveryNotes)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(deliveryNotes.id, id))
    .returning();
  return row || null;
};

const deleteById = async (id) => {
  const [row] = await db
    .delete(deliveryNotes)
    .where(eq(deliveryNotes.id, id))
    .returning();
  return row || null;
};

const generateNoteNumber = async () => {
  const todayStr = lagosToday().replace(/-/g, "");
  const [{ total }] = await db
    .select({ total: count() })
    .from(deliveryNotes);
  return `DN-${todayStr}-${String(total + 1).padStart(4, "0")}`;
};

module.exports = {
  findById,
  findByNumber,
  findAll,
  create,
  update,
  deleteById,
  generateNoteNumber,
};
