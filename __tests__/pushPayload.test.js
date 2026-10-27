const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { encryptedPushPayload } = require('../services/pushPayload');

describe('encrypted message pushes', () => {
  test('a short encrypted text carries its ciphertext and time, so the phone needs no fetch', () => {
    const payload = encryptedPushPayload(true, 'text', { version: 2, encryptedContent: 'abc' }, new Date('2026-10-27T10:00:00.000Z'));
    assert.deepEqual(JSON.parse(payload.encryptedPayload), { version: 2, encryptedContent: 'abc' });
    assert.equal(payload.createdAt, '2026-10-27T10:00:00.000Z');
  });

  test('attachments, plain messages and anything too big for a push are left out', () => {
    assert.deepEqual(encryptedPushPayload(true, 'image', { k: 'file key inside' }, new Date()), {});
    assert.deepEqual(encryptedPushPayload(false, 'text', null, new Date()), {});
    assert.deepEqual(encryptedPushPayload(true, 'text', { encryptedContent: 'x'.repeat(3000) }, new Date()), {});
  });
});
