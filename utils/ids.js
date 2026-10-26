/**
 * Message ids are UUIDs. The app makes the id of each message it sends itself, so
 * a message it sends again (no acknowledgement before a timeout, app restarted)
 * is recognised instead of stored twice.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

/** Sorts before every real id; the start of a (createdAt, id) sync cursor. */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

module.exports = { isUuid, ZERO_UUID };
