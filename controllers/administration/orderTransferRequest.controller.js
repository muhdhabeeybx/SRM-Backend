const asyncHandler = require("express-async-handler");
const svc = require("../../services/orderTransferRequest.service");

/**
 * Surplus transfer requests: finance asks, a named approver decides. The
 * rules live in services/orderTransferRequest.service.js; this only passes
 * the person and the body through and says what happened.
 */

const send = (res, status, data, message) => res.status(status).json({ success: true, message, data });
const fail = (res, err) => {
  const status = err.status || err.statusCode;
  if (!status) throw err;
  return res.status(status).json({ success: false, message: err.message });
};
const guarded = (fn) => asyncHandler(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    fail(res, err);
  }
});

const listRequests = guarded(async (req, res) => {
  const requests = await svc.list({
    status: req.query.status || "",
    search: req.query.search || "",
    pfiId: req.query.pfi ?? null,
    orderId: req.query.orderId ?? null,
    user: req.user,
  });
  send(res, 200, { requests });
});

const spare = guarded(async (req, res) => {
  send(res, 200, { order: await svc.spareOn(Number(req.params.orderId), req.user) });
});

const createRequest = guarded(async (req, res) => {
  const request = await svc.requestTransfer({ ...req.body, user: req.user });
  send(res, 201, { request }, `Transfer request #${request.id} sent for approval — nothing has moved yet`);
});

const createReversal = guarded(async (req, res) => {
  const request = await svc.requestReversal({ ...req.body, user: req.user });
  send(res, 201, { request }, `Request #${request.id} to undo the transfer sent for approval — nothing has moved yet`);
});

const approve = guarded(async (req, res) => {
  const request = await svc.approve({ requestId: Number(req.params.id), note: req.body.note, user: req.user });
  send(res, 200, { request }, `Approved — ₦${Number(request.amount).toLocaleString("en-NG")} moved`);
});

const reject = guarded(async (req, res) => {
  const request = await svc.reject({ requestId: Number(req.params.id), note: req.body.note, user: req.user });
  send(res, 200, { request }, "Rejected — nothing moved");
});

const cancel = guarded(async (req, res) => {
  const request = await svc.cancel({ requestId: Number(req.params.id), note: req.body.note, user: req.user });
  send(res, 200, { request }, "Request withdrawn");
});

module.exports = { listRequests, spare, createRequest, createReversal, approve, reject, cancel };
