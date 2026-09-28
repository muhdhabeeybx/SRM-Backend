const { onEvent } = require("../services/events");
const { notify } = require("./index");
const { rolesFor, OPERATIONS_REVIEWERS, INCIDENT_REVIEWERS } = require("./staffChoices");

/**
 * The bridge from the business event bus to the notification engine.
 *
 * services/events.js already carries "something happened" announcements whose
 * consumers the emitting service never learns about. This module is one such
 * consumer: it maps events to notifications, so a service that emits
 * `daily_report.approved` knows nothing about SMS — and adding push to that
 * flow is an edit here, not in the ERP service.
 *
 * Not every notification arrives this way. Flows whose data lives inside a
 * transaction (an order's invoice, a ticket's QR code) call `notify()` from
 * the service that already holds the data; routing those through the bus would
 * mean re-reading rows the caller has in hand. Both paths end at one engine.
 *
 * Every handler below is written against the payload the emitter ACTUALLY
 * sends — `entityId` is the record id by convention, and the extra fields are
 * whatever that emitter chose to attach. A handler that needs a field the
 * event does not carry is a change to the emitter, not a lookup smuggled in
 * here; the one exception is noted where it occurs.
 */

// Who reviews what now lives in ./staffChoices.js, with every other role
// notice, so an admin can take a person out of one or add a person to it.
// Roles are matched by overlap, so an installation that has not created
// every role still notifies the ones it has.

const registerNotificationListeners = () => {
  // ─── ERP: daily reports ───────────────────────────────────────────────────

  onEvent("daily_report.submitted", async (p) => {
    await notify("staff.daily_report_submitted", {
      to: { roles: rolesFor("daily_reports") },
      data: {
        reportId: p.entityId,
        location: p.location,
        reportDate: p.reportDate,
        submitterName: p.submittedByName || p.actor?.name || "",
      },
    });
  });

  for (const status of ["approved", "rejected"]) {
    onEvent(`daily_report.${status}`, async (p) => {
      const submitterId = p.submitterStaffId || p.report?.submittedBy;
      // Fall back to the bare phone number when the report has no staff id
      // (a submitter whose account was since deleted) — an SMS is still better
      // than silence, even though it can carry no inbox row.
      if (!submitterId && !p.submitterPhone) return;
      await notify(`staff.daily_report_${status}`, {
        to: submitterId ? { staffId: submitterId } : { phone: p.submitterPhone },
        data: {
          reportId: p.entityId,
          location: p.report?.location,
          reportDate: p.report?.reportDate,
          comment: p.comment,
        },
      });
    });
  }

  // ─── ERP: incidents ───────────────────────────────────────────────────────

  onEvent("incident.submitted", async (p) => {
    await notify("staff.incident_submitted", {
      to: { roles: rolesFor("incidents") },
      data: {
        incidentId: p.entityId,
        incidentType: p.incidentType,
        location: p.location,
        summary: p.title,
        submitterName: p.actor?.name || "",
      },
    });
  });

  for (const status of ["reviewed", "resolved", "rejected"]) {
    onEvent(`incident.${status}`, async (p) => {
      if (!p.submittedBy) return;
      // Reviewing your own report should not notify you about it.
      if (p.actor?.type === "staff" && p.actor.id === p.submittedBy) return;
      await notify("staff.incident_updated", {
        to: { staffId: p.submittedBy },
        data: {
          incidentId: p.entityId,
          incidentType: p.incidentType,
          status,
          reviewerName: p.actor?.name || "",
        },
      });
    });
  }

  // ─── ERP: offline sales ───────────────────────────────────────────────────

  for (const status of ["approved", "rejected"]) {
    onEvent(`offline_sale.${status}`, async (p) => {
      if (!p.createdBy) return;
      if (p.actor?.type === "staff" && p.actor.id === p.createdBy) return;
      await notify("staff.offline_sale_updated", {
        to: { staffId: p.createdBy },
        data: {
          saleId: p.entityId,
          reference: p.saleNumber,
          amount: p.totalAmount,
          status,
        },
      });
    });
  }

  // ─── ERP: fleet ───────────────────────────────────────────────────────────

  onEvent("fleet.truck_created", async (p) => {
    await notify("staff.fleet_updated", {
      to: { roles: rolesFor("fleet_changes") },
      data: {
        truckId: p.entityId,
        truckNumber: p.plateNumber,
        action: "added",
        actorName: p.actor?.name || "",
      },
    });
  });

  // ─── Delivery (ERP delivery customers) ────────────────────────────────────
  //
  // These buyers live in `delivery_customers` and have no portal account, so
  // every one of them is a contact-only recipient: SMS is the only channel
  // that can reach them, and the catalog entries reflect that.

  onEvent("delivery.released", async (p) => {
    if (!p.customerPhone) return;
    await notify("delivery.released", {
      to: { phone: p.customerPhone },
      data: {
        deliveryId: p.entityId,
        allocationCode: p.allocation?.allocationCode,
        truckNumber: p.allocation?.truckNumber,
        quantityAllocated: p.allocation?.quantityAllocated,
      },
    });
  });

  onEvent("delivery.confirmed", async (p) => {
    if (!p.customerPhone) return;
    await notify("delivery.confirmed", {
      to: { phone: p.customerPhone },
      data: {
        deliveryId: p.entityId,
        allocationCode: p.allocationCode || p.allocation?.allocationCode,
        truckNumber: p.allocation?.truckNumber,
      },
    });
  });

  onEvent("delivery.rejected", async (p) => {
    if (!p.customerPhone) return;
    await notify("delivery.rejected", {
      to: { phone: p.customerPhone },
      data: {
        deliveryId: p.entityId,
        allocationCode: p.allocation?.allocationCode,
        reason: p.reason,
      },
    });
  });

  // ─── Security (customer realm) ────────────────────────────────────────────
  //
  // Mandatory in the catalog — unmutable. Someone whose account was taken over
  // would otherwise have muted their only warning.
  //
  // `entityId` is the customer id on both of these events (see
  // services/identity.service.js), which is why no lookup is needed.

  onEvent("customer.identity_linked", async (p) => {
    if (!p.entityId) return;
    await notify("security.identity_linked", {
      to: { customerId: p.entityId },
      data: { provider: p.provider },
    });
  });

  onEvent("customer.identity_unlinked", async (p) => {
    if (!p.entityId) return;
    await notify("security.identity_unlinked", {
      to: { customerId: p.entityId },
      data: { provider: p.provider },
    });
  });

  // ─── Licences (customer realm) ────────────────────────────────────────────

  for (const status of ["approved", "rejected"]) {
    onEvent(`license.${status}`, async (p) => {
      const customerId = p.license?.customerId;
      if (!customerId) return;
      await notify(`license.${status}`, {
        to: { customerId },
        data: {
          licenseId: p.entityId,
          licenseType: p.license?.licenseType || p.license?.licenseName,
          reason: p.comment,
        },
      });
    });
  }
};

module.exports = { registerNotificationListeners, OPERATIONS_REVIEWERS, INCIDENT_REVIEWERS };
