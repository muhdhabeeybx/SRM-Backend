const asyncHandler = require("express-async-handler");
const staffMessages = require("../../services/staffMessages.service");

/**
 * Messages between members of staff — services/staffMessages.service.js.
 *
 * GET  /staff-messages/people          everybody, with their conversation so far
 * GET  /staff-messages/unread-count    for the menu badge
 * GET  /staff-messages/with/:id        one conversation (marks it read)
 * POST /staff-messages/with/:id        send { body }
 * GET  /staff-messages/activity        admins: who wrote to whom, no text
 *
 * Every conversation route is the caller's own: the other person is the only
 * id in the path, and the caller is always req.user. There is no way to name
 * two other people and read between them.
 */

const getPeople = asyncHandler(async (req, res) => {
  const people = await staffMessages.people(req.user.id);
  res.json({ success: true, data: { people } });
});

const getUnreadCount = asyncHandler(async (req, res) => {
  const unread = await staffMessages.unreadCount(req.user.id);
  res.json({ success: true, data: { unread } });
});

const getThread = asyncHandler(async (req, res) => {
  const data = await staffMessages.thread(req.user.id, req.params.id, {
    before: req.query.before,
    limit: req.query.limit,
  });
  res.json({ success: true, data });
});

const sendMessage = asyncHandler(async (req, res) => {
  const data = await staffMessages.send(req.user.id, req.params.id, req.body?.body);
  res.status(201).json({ success: true, data });
});

const getActivity = asyncHandler(async (req, res) => {
  const data = await staffMessages.activity({ from: req.query.from, to: req.query.to });
  res.json({ success: true, data });
});

module.exports = { getPeople, getUnreadCount, getThread, sendMessage, getActivity };
