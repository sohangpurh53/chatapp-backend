const { Op } = require('sequelize');
const { DeviceLink, UserSession } = require('../models');
const sessionService = require('../services/sessionService');

// "Link a new phone" (see models/DeviceLink): request on the new phone, approve on
// a phone that has the keys, collect on the new phone.

const LINK_TTL_MS = 10 * 60 * 1000;
const MAX_PAYLOAD_LENGTH = 64 * 1024;

const isPublicKey = (key) => typeof key === 'string' && key.length >= 100 && key.length <= 4096;

const emit = (room, event, data, exceptRoom) => {
  const io = sessionService.getIO();
  if (!io) return;
  (exceptRoom ? io.to(room).except(exceptRoom) : io.to(room)).emit(event, data);
};

const openLink = (link) => link.status === 'pending' && new Date(link.expiresAt) > new Date();

// Phones count down from expiresInMs: their clocks can be off from the server's
const msLeft = (link) => Math.max(new Date(link.expiresAt).getTime() - Date.now(), 0);

const describeLink = (link) => ({
  linkId: link.id,
  deviceName: link.requesterName || 'A new phone',
  publicKey: link.linkPublicKey,
  expiresAt: link.expiresAt,
  expiresInMs: msLeft(link)
});

/** POST /auth/device-link {publicKey}: this phone asks the account's other phones for the keys. */
const requestLink = async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!isPublicKey(publicKey)) {
      return res.status(400).json({ error: 'Invalid key format' });
    }
    if (!req.sessionId) {
      return res.status(400).json({ error: 'Sign in again to link this phone' });
    }

    // One open request per phone: a new one replaces the last (and drops keys it never collected)
    await DeviceLink.update(
      { status: 'declined', payload: null },
      { where: { userId: req.user.id, requesterSessionId: req.sessionId, status: { [Op.in]: ['pending', 'approved'] } } }
    );

    const session = await UserSession.findOne({ where: { id: req.sessionId, userId: req.user.id } });
    const link = await DeviceLink.create({
      userId: req.user.id,
      requesterSessionId: req.sessionId,
      requesterName: session?.deviceName || null,
      linkPublicKey: publicKey,
      expiresAt: new Date(Date.now() + LINK_TTL_MS)
    });

    emit(`user_${req.user.id}`, 'device_link_request', describeLink(link), `session_${req.sessionId}`);

    res.status(201).json({ linkId: link.id, expiresAt: link.expiresAt, expiresInMs: msLeft(link) });
  } catch (error) {
    console.error('Device link request error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** GET /auth/device-link/pending: open requests from the account's other phones (missed while offline). */
const listPendingLinks = async (req, res) => {
  try {
    const links = await DeviceLink.findAll({
      where: {
        userId: req.user.id,
        status: 'pending',
        expiresAt: { [Op.gt]: new Date() },
        ...(req.sessionId ? { requesterSessionId: { [Op.ne]: req.sessionId } } : {})
      },
      order: [['createdAt', 'DESC']]
    });
    res.json({ links: links.map(describeLink) });
  } catch (error) {
    console.error('Device link list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const findOwnLink = (req) => DeviceLink.findOne({ where: { id: req.params.linkId, userId: req.user.id } });

/** POST /auth/device-link/:linkId/approve {payload}: a phone with the keys sends them, locked to the link key. */
const approveLink = async (req, res) => {
  try {
    const { payload } = req.body;
    if (typeof payload !== 'string' || !payload || payload.length > MAX_PAYLOAD_LENGTH) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const link = await findOwnLink(req);
    if (!link || !openLink(link)) {
      return res.status(404).json({ error: 'This request has expired. Ask again on the new phone.', code: 'LINK_EXPIRED' });
    }
    if (link.requesterSessionId === req.sessionId) {
      return res.status(403).json({ error: 'Approve on your other phone' });
    }

    await link.update({ payload, status: 'approved' });
    emit(`session_${link.requesterSessionId}`, 'device_link_approved', { linkId: link.id });

    res.json({ success: true });
  } catch (error) {
    console.error('Device link approve error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** POST /auth/device-link/:linkId/decline */
const declineLink = async (req, res) => {
  try {
    const link = await findOwnLink(req);
    if (link && link.status === 'pending') {
      await link.update({ status: 'declined' });
      emit(`session_${link.requesterSessionId}`, 'device_link_declined', { linkId: link.id });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Device link decline error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** GET /auth/device-link/:linkId: the new phone collects the answer; the payload is handed out once. */
const collectLink = async (req, res) => {
  try {
    const link = await findOwnLink(req);
    if (!link || link.requesterSessionId !== req.sessionId) {
      return res.status(404).json({ error: 'Link request not found' });
    }

    if (link.status === 'approved') {
      const payload = link.payload;
      await link.update({ status: 'completed', payload: null });
      return res.json({ status: 'approved', payload });
    }
    if (link.status === 'pending' && !openLink(link)) {
      return res.json({ status: 'expired' });
    }
    res.json({ status: link.status });
  } catch (error) {
    console.error('Device link collect error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  LINK_TTL_MS,
  requestLink,
  listPendingLinks,
  approveLink,
  declineLink,
  collectLink
};
