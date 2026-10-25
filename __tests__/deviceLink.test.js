const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { DeviceLink, UserSession } = require('../models');
const sessionService = require('../services/sessionService');
const deviceLink = require('../controllers/deviceLinkController');

const KEY = '-----BEGIN RSA PUBLIC KEY-----' + 'L'.repeat(300) + '-----END RSA PUBLIC KEY-----';

const stubs = [];
const stub = (object, name, replacement) => {
  stubs.push([object, name, object[name]]);
  object[name] = replacement;
};

const call = async (handler, req) => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler({ user: { id: 'u1' }, params: {}, body: {}, ...req }, res);
  return res;
};

describe('link a new phone', () => {
  let emitted;
  let links;

  // A link row as Sequelize would hand it back
  const row = (fields) => ({
    id: 'link-1',
    userId: 'u1',
    requesterSessionId: 'new-phone',
    requesterName: 'POCO M2007J20CI',
    linkPublicKey: KEY,
    payload: null,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60000),
    ...fields,
    async update(changes) { Object.assign(this, changes); return this; },
  });

  beforeEach(() => {
    emitted = [];
    links = [];
    const room = (name, except) => ({
      except: (other) => room(name, other),
      emit: (event, data) => emitted.push({ room: name, except, event, data }),
    });
    stub(sessionService, 'getIO', () => ({ to: (name) => room(name) }));
    stub(UserSession, 'findOne', async () => ({ id: 'new-phone', deviceName: 'POCO M2007J20CI' }));
    stub(DeviceLink, 'update', async () => [0]);
    stub(DeviceLink, 'create', async (fields) => { const link = row(fields); links.push(link); return link; });
  });

  afterEach(() => {
    while (stubs.length) {
      const [object, name, original] = stubs.pop();
      object[name] = original;
    }
  });

  describe('request (new phone)', () => {
    test('asks the account\'s other phones, not itself, with the one-time key', async () => {
      const res = await call(deviceLink.requestLink, { sessionId: 'new-phone', body: { publicKey: KEY } });

      assert.equal(res.statusCode, 201);
      assert.equal(links[0].requesterSessionId, 'new-phone');
      assert.ok(new Date(links[0].expiresAt) - Date.now() <= deviceLink.LINK_TTL_MS);
      assert.deepEqual(emitted.map(e => [e.room, e.except, e.event]), [['user_u1', 'session_new-phone', 'device_link_request']]);
      assert.equal(emitted[0].data.publicKey, KEY);
      assert.equal(emitted[0].data.deviceName, 'POCO M2007J20CI');
    });

    test('says how long the request lasts, so a phone with a wrong clock does not give up early', async () => {
      const res = await call(deviceLink.requestLink, { sessionId: 'new-phone', body: { publicKey: KEY } });

      assert.ok(res.body.expiresInMs > deviceLink.LINK_TTL_MS - 5000 && res.body.expiresInMs <= deviceLink.LINK_TTL_MS);
      assert.ok(emitted[0].data.expiresInMs > deviceLink.LINK_TTL_MS - 5000);
    });

    test('rejects something that is not a public key', async () => {
      const res = await call(deviceLink.requestLink, { sessionId: 'new-phone', body: { publicKey: 'short' } });

      assert.equal(res.statusCode, 400);
      assert.equal(links.length, 0);
    });

    test('a new request replaces this phone\'s open one', async () => {
      let closed;
      stub(DeviceLink, 'update', async (changes, options) => { closed = { changes, where: options.where }; return [1]; });

      await call(deviceLink.requestLink, { sessionId: 'new-phone', body: { publicKey: KEY } });

      assert.equal(closed.changes.status, 'declined');
      assert.equal(closed.changes.payload, null);
      assert.equal(closed.where.requesterSessionId, 'new-phone');
      // Keys approved for the last request but never collected go too
      assert.deepEqual(closed.where.status[require('sequelize').Op.in], ['pending', 'approved']);
    });
  });

  describe('approve (phone with the keys)', () => {
    test('stores the locked keys and tells only the new phone', async () => {
      const link = row();
      stub(DeviceLink, 'findOne', async ({ where }) => (where.id === 'link-1' && where.userId === 'u1' ? link : null));

      const res = await call(deviceLink.approveLink, { sessionId: 'old-phone', params: { linkId: 'link-1' }, body: { payload: 'LOCKED' } });

      assert.equal(res.statusCode, 200);
      assert.equal(link.status, 'approved');
      assert.equal(link.payload, 'LOCKED');
      assert.deepEqual(emitted.map(e => [e.room, e.event]), [['session_new-phone', 'device_link_approved']]);
    });

    test('the new phone cannot approve its own request', async () => {
      stub(DeviceLink, 'findOne', async () => row());

      const res = await call(deviceLink.approveLink, { sessionId: 'new-phone', params: { linkId: 'link-1' }, body: { payload: 'LOCKED' } });

      assert.equal(res.statusCode, 403);
    });

    test('an expired or answered request cannot be approved', async () => {
      for (const fields of [{ expiresAt: new Date(Date.now() - 1000) }, { status: 'declined' }, { status: 'completed' }]) {
        stub(DeviceLink, 'findOne', async () => row(fields));

        const res = await call(deviceLink.approveLink, { sessionId: 'old-phone', params: { linkId: 'link-1' }, body: { payload: 'LOCKED' } });

        assert.equal(res.statusCode, 404);
        assert.equal(res.body.code, 'LINK_EXPIRED');
      }
    });

    test('another account\'s request is not found', async () => {
      stub(DeviceLink, 'findOne', async ({ where }) => (where.userId === 'someone-else' ? row() : null));

      const res = await call(deviceLink.approveLink, { sessionId: 'old-phone', params: { linkId: 'link-1' }, body: { payload: 'LOCKED' } });

      assert.equal(res.statusCode, 404);
    });

    test('refuses a missing or oversized payload', async () => {
      stub(DeviceLink, 'findOne', async () => row());

      for (const payload of [undefined, '', 'x'.repeat(64 * 1024 + 1)]) {
        const res = await call(deviceLink.approveLink, { sessionId: 'old-phone', params: { linkId: 'link-1' }, body: { payload } });
        assert.equal(res.statusCode, 400);
      }
    });

    test('declining tells the new phone', async () => {
      const link = row();
      stub(DeviceLink, 'findOne', async () => link);

      await call(deviceLink.declineLink, { sessionId: 'old-phone', params: { linkId: 'link-1' } });

      assert.equal(link.status, 'declined');
      assert.deepEqual(emitted.map(e => [e.room, e.event]), [['session_new-phone', 'device_link_declined']]);
    });
  });

  describe('collect (new phone)', () => {
    test('hands out the locked keys once, then forgets them', async () => {
      const link = row({ status: 'approved', payload: 'LOCKED' });
      stub(DeviceLink, 'findOne', async () => link);

      const first = await call(deviceLink.collectLink, { sessionId: 'new-phone', params: { linkId: 'link-1' } });
      const second = await call(deviceLink.collectLink, { sessionId: 'new-phone', params: { linkId: 'link-1' } });

      assert.deepEqual(first.body, { status: 'approved', payload: 'LOCKED' });
      assert.equal(link.payload, null);
      assert.deepEqual(second.body, { status: 'completed' });
    });

    test('only the phone that asked can collect', async () => {
      stub(DeviceLink, 'findOne', async () => row({ status: 'approved', payload: 'LOCKED' }));

      const res = await call(deviceLink.collectLink, { sessionId: 'old-phone', params: { linkId: 'link-1' } });

      assert.equal(res.statusCode, 404);
    });

    test('reports a request nobody answered in time as expired', async () => {
      stub(DeviceLink, 'findOne', async () => row({ expiresAt: new Date(Date.now() - 1000) }));

      const res = await call(deviceLink.collectLink, { sessionId: 'new-phone', params: { linkId: 'link-1' } });

      assert.deepEqual(res.body, { status: 'expired' });
    });
  });

  test('lists open requests from the account\'s other phones only', async () => {
    let where;
    stub(DeviceLink, 'findAll', async (options) => { where = options.where; return [row()]; });

    const res = await call(deviceLink.listPendingLinks, { sessionId: 'old-phone' });

    assert.equal(where.userId, 'u1');
    assert.equal(where.status, 'pending');
    assert.ok(where.requesterSessionId);
    assert.deepEqual(res.body.links.map(l => [l.linkId, l.deviceName, l.publicKey]), [['link-1', 'POCO M2007J20CI', KEY]]);
  });
});
