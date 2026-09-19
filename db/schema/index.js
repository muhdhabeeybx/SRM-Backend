const enums = require("./enums");
const staffSchema = require("./staff");
const customerSchema = require("./customer");
// After ./customer and ./staff — customerPhone destructures both at load time.
const customerPhoneSchema = require("./customerPhone");
const contactSchema = require("./contact");
const driverSchema = require("./driver");
// Before its dependents: orderTruck, driverTruckHistory and deliveryInventory
// all destructure `fleetTrucks` at load time.
const fleetTruckSchema = require("./fleetTruck");
const depotSchema = require("./depot");
const productSchema = require("./product");
const depotStaffSchema = require("./depotStaff");
const lpgStationSchema = require("./lpgStation");
const lpgStationStaffSchema = require("./lpgStationStaff");
const lpgStationCylinderSchema = require("./lpgStationCylinder");
const lpgPriceHistorySchema = require("./lpgPriceHistory");
const depotProductCapacitiesSchema = require("./depotProductCapacities");
const depotProductPricesSchema = require("./depotProductPrices");
const depotPriceHistorySchema = require("./depotPriceHistory");
const depotPriceChangeSchema = require("./depotPriceChange");
const driverTruckHistorySchema = require("./driverTruckHistory");
const pfiSchema = require("./pfi");
// After ./pfi and ./staff — pfiStaff destructures both at load time.
const pfiStaffSchema = require("./pfiStaff");
const orderSchema = require("./order");
const vendorSchema = require("./vendor");
// After ./order and ./vendor — pfiExpense destructures `orders` and `vendors`
// at load time.
const pfiExpenseSchema = require("./pfiExpense");
const orderPfiAllocationSchema = require("./orderPfiAllocation");
const ticketSchema = require("./ticket");
const depositSchema = require("./deposit");
// After ./order and ./deposit — orderDepositAllocation destructures both at
// load time.
const orderDepositAllocationSchema = require("./orderDepositAllocation");
// After ./customer, ./order, ./deposit, ./staff — expectedPayment
// destructures all four at load time.
const expectedPaymentSchema = require("./expectedPayment");
const walletHoldSchema = require("./walletHold");
const deliveryCustomerSchema = require("./deliveryCustomer");
const deliveryNoteSchema = require("./deliveryNote");
const deliveryInventorySchema = require("./deliveryInventory");
const deliveryBatchSchema = require("./deliveryBatch");
const deliveryCycleClosureSchema = require("./deliveryCycleClosure");
const deliverySaleSchema = require("./deliverySale");
const webhookEventSchema = require("./webhookEvent");
const sessionSchema = require("./session");
const customerOtpSchema = require("./customerOtp");
const auditLogSchema = require("./auditLog");
const orderTruckSchema = require("./orderTruck");
const customerIdentitySchema = require("./customerIdentity");
const auditEventSchema = require("./auditEvent");
const fleetLedgerSchema = require("./fleetLedgerEntry");
const dailyReportSchema = require("./dailyReport");
const incidentRecordSchema = require("./incidentRecord");
const offlineSaleSchema = require("./offlineSale");
const dangoteProductSchema = require("./dangoteProduct");
const dangoteOrderRequestSchema = require("./dangoteOrderRequest");
const lpgOrderRequestSchema = require("./lpgOrderRequest");
const waSessionSchema = require("./waSession");
const waMessageSchema = require("./waMessage");
const waTemplateSchema = require("./waTemplate");
const bankAccountSchema = require("./bankAccount");
const bankStatementSchema = require("./bankStatement");
// After ./order, ./bankStatement, ./bankAccount, ./deposit and ./staff —
// orderPayment destructures all five at load time.
const orderPaymentSchema = require("./orderPayment");
const depotProductCommissionSchema = require("./depotProductCommission");
const commissionSchema = require("./commission");
const customerLicenseSchema = require("./companyLicense");
const notificationSchema = require("./notification");
// After ./notification — notificationDelivery destructures `notifications` at
// load time for its foreign key.
const notificationDeliverySchema = require("./notificationDelivery");
const notificationPreferenceSchema = require("./notificationPreference");
const deviceTokenSchema = require("./deviceToken");
const staffPageOverrideSchema = require("./staffPageOverride");
// After ./staff — messageTemplate destructures it at load time.
const messageTemplateSchema = require("./messageTemplate");
const messageCampaignSchema = require("./messageCampaign");
// After ./pfi and ./staff — cfoReportEntry destructures both at load time.
const cfoReportEntrySchema = require("./cfoReportEntry");

module.exports = {
  ...enums,
  ...staffSchema,
  ...customerSchema,
  ...customerPhoneSchema,
  ...contactSchema,
  ...driverSchema,
  ...depotSchema,
  ...productSchema,
  ...depotStaffSchema,
  ...lpgStationSchema,
  ...lpgStationStaffSchema,
  ...lpgStationCylinderSchema,
  ...lpgPriceHistorySchema,
  ...depotProductCapacitiesSchema,
  ...depotProductPricesSchema,
  ...depotPriceHistorySchema,
  ...depotPriceChangeSchema,
  ...driverTruckHistorySchema,
  ...pfiSchema,
  ...pfiStaffSchema,
  ...orderSchema,
  ...vendorSchema,
  ...pfiExpenseSchema,
  ...orderPfiAllocationSchema,
  ...ticketSchema,
  ...depositSchema,
  ...orderDepositAllocationSchema,
  ...orderPaymentSchema,
  ...expectedPaymentSchema,
  ...walletHoldSchema,
  ...deliveryCustomerSchema,
  ...deliveryNoteSchema,
  ...deliveryInventorySchema,
  ...deliveryBatchSchema,
  ...deliveryCycleClosureSchema,
  ...deliverySaleSchema,
  ...webhookEventSchema,
  ...sessionSchema,
  ...customerOtpSchema,
  ...auditLogSchema,
  ...orderTruckSchema,
  ...customerIdentitySchema,
  ...auditEventSchema,
  ...fleetTruckSchema,
  ...fleetLedgerSchema,
  ...dailyReportSchema,
  ...incidentRecordSchema,
  ...offlineSaleSchema,
  ...dangoteProductSchema,
  ...dangoteOrderRequestSchema,
  ...lpgOrderRequestSchema,
  ...waSessionSchema,
  ...waMessageSchema,
  ...waTemplateSchema,
  ...bankAccountSchema,
  ...bankStatementSchema,
  ...depotProductCommissionSchema,
  ...commissionSchema,
  ...customerLicenseSchema,
  ...notificationSchema,
  ...notificationDeliverySchema,
  ...notificationPreferenceSchema,
  ...deviceTokenSchema,
  ...staffPageOverrideSchema,
  ...messageTemplateSchema,
  ...messageCampaignSchema,
  ...cfoReportEntrySchema,
};
