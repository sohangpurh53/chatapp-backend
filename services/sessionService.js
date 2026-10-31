const { Op } = require('sequelize');
const { UserSession, UserDevice } = require('../models');

// Signed-in device sessions. Every token carries the session id (`sid`); the
// auth middleware, socket auth and token refresh all reject revoked sessions.

const MAX_ACTIVE_SESSIONS = Math.max(1, parseInt(process.env.MAX_ACTIVE_SESSIONS || '5', 10));
const VALIDATION_CACHE_MS = 30 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
// Signed out by something other than this device itself: it has to be told
const REMOTE_REASONS = new Set(['remote', 'all_others', 'limit']);

let io = null;
// sid -> { ok, userId, until, lastTouch }
const cache = new Map();

const setIO = (socketIO) => { io = socketIO; };
const getIO = () => io;

const header = (req, name) => {
  const value = req?.headers?.[name];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
};

/** Device details the app sends on every request (X-Device-* headers). */
const deviceFromRequest = (req) => ({
  deviceId: header(req, 'x-device-id'),
  deviceName: header(req, 'x-device-name'),
  platform: header(req, 'x-device-platform'),
  appVersion: header(req, 'x-app-version'),
  ipAddress: (header(req, 'x-forwarded-for') || req?.ip || '').split(',')[0].trim() || null,
  userAgent: header(req, 'user-agent'),
});

const notifyRevoked = (session, reason) => {
  cache.delete(session.id);
  if (!io) return;
  const room = `session_${session.id}`;
  // A device logging itself out must not hear "revoked": the app treats that as a
  // remote sign-out and deletes this phone's encryption keys
  if (reason !== 'logout') {
    io.to(room).emit('session_revoked', { sessionId: session.id, reason });
  }
  // Give the event a moment to arrive before cutting the connection
  setTimeout(() => io.in(room).disconnectSockets(true), 500);
};

/** The socket can't reach an app in the background: push before the token is removed. */
const pushSessionCheck = async (session) => {
  if (!session.deviceId) return;
  const device = await UserDevice.findOne({
    where: { userId: session.userId, deviceId: session.deviceId },
    attributes: ['fcmToken']
  });
  if (!device?.fcmToken) return;
  require('./fcmService').sendSessionCheck(device.fcmToken).catch((error) => {
    console.error('Session check push failed:', error.message);
  });
};

/** Stop pushes to a signed-out device. */
const deactivateDevice = async (userId, deviceId) => {
  if (!deviceId) return;
  await UserDevice.update(
    { isActive: false, fcmToken: null, lastLogoutAt: new Date() },
    { where: { userId, deviceId } }
  );
};

const revokeSession = async (session, reason) => {
  if (!session || session.revokedAt) return false;
  await session.update({ revokedAt: new Date(), revokeReason: reason });
  // Before the push: the device asks right after it, and must not get a cached "fine"
  cache.delete(session.id);
  if (REMOTE_REASONS.has(reason)) {
    await pushSessionCheck(session).catch((error) => {
      console.error('Session check push failed:', error.message);
    });
  }
  await deactivateDevice(session.userId, session.deviceId);
  notifyRevoked(session, reason);
  return true;
};

/**
 * Create a session for a fresh login. A previous session on the same device is
 * replaced; beyond MAX_ACTIVE_SESSIONS the least recently used one is signed out.
 */
const createSession = async (userId, req) => {
  const device = deviceFromRequest(req);

  if (device.deviceId) {
    const previous = await UserSession.findAll({
      where: { userId, deviceId: device.deviceId, revokedAt: null }
    });
    for (const session of previous) {
      await revokeSession(session, 'replaced');
    }
  }

  const session = await UserSession.create({ userId, ...device, lastActiveAt: new Date() });

  const active = await UserSession.findAll({
    where: { userId, revokedAt: null },
    order: [['lastActiveAt', 'DESC']]
  });
  for (const extra of active.slice(MAX_ACTIVE_SESSIONS)) {
    if (extra.id !== session.id) await revokeSession(extra, 'limit');
  }

  // Let the user's other devices know about the new sign-in
  if (io) {
    io.to(`user_${userId}`).except(`session_${session.id}`).emit('session_new', {
      sessionId: session.id,
      deviceName: session.deviceName || 'A new device',
      platform: session.platform,
      createdAt: session.createdAt
    });
  }

  return session;
};

/**
 * Is this session still signed in? Cached briefly so the check doesn't cost a
 * database round trip per request; lastActiveAt is refreshed every few minutes.
 */
const validateSession = async (sid, userId) => {
  const now = Date.now();
  const hit = cache.get(sid);
  if (hit && hit.until > now && hit.userId === userId) {
    if (hit.ok && now - hit.lastTouch > TOUCH_INTERVAL_MS) {
      hit.lastTouch = now;
      UserSession.update({ lastActiveAt: new Date() }, { where: { id: sid } }).catch(() => {});
    }
    return hit.ok;
  }

  const session = await UserSession.findByPk(sid, { attributes: ['id', 'userId', 'revokedAt', 'lastActiveAt'] });
  const ok = !!session && !session.revokedAt && session.userId === userId;
  const lastTouch = session?.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
  cache.set(sid, { ok, userId, until: now + VALIDATION_CACHE_MS, lastTouch });
  if (ok && now - lastTouch > TOUCH_INTERVAL_MS) {
    cache.get(sid).lastTouch = now;
    UserSession.update({ lastActiveAt: new Date() }, { where: { id: sid } }).catch(() => {});
  }
  return ok;
};

const listSessions = (userId) => UserSession.findAll({
  where: { userId, revokedAt: null },
  order: [['lastActiveAt', 'DESC']],
  attributes: ['id', 'deviceId', 'deviceName', 'platform', 'appVersion', 'ipAddress', 'lastActiveAt', 'createdAt']
});

const revokeById = async (userId, sid, reason = 'remote') => {
  const session = await UserSession.findOne({ where: { id: sid, userId } });
  return revokeSession(session, reason);
};

const revokeOthers = async (userId, currentSid) => {
  const others = await UserSession.findAll({
    where: { userId, revokedAt: null, ...(currentSid ? { id: { [Op.ne]: currentSid } } : {}) }
  });
  for (const session of others) {
    await revokeSession(session, 'all_others');
  }
  return others.length;
};

module.exports = {
  MAX_ACTIVE_SESSIONS,
  setIO,
  getIO,
  deviceFromRequest,
  createSession,
  validateSession,
  listSessions,
  revokeById,
  revokeOthers,
};
