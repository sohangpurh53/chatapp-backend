const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const AppLog = require('../models/AppLog');
const router = require('../routes/applogs');

describe('reading app logs', () => {
  let server;
  let url;
  const original = { findAll: AppLog.findAll, key: process.env.APP_LOGS_KEY };

  beforeEach(async () => {
    AppLog.findAll = async () => [{ id: 1 }];
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${server.address().port}/api/app-logs`;
  });

  afterEach(async () => {
    AppLog.findAll = original.findAll;
    if (original.key === undefined) delete process.env.APP_LOGS_KEY;
    else process.env.APP_LOGS_KEY = original.key;
    await new Promise((resolve) => server.close(resolve));
  });

  test('nobody can read them when no key is configured', async () => {
    delete process.env.APP_LOGS_KEY;
    assert.equal((await fetch(url)).status, 403);
  });

  test('a missing or wrong key is refused', async () => {
    process.env.APP_LOGS_KEY = 'right-key';
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { 'x-app-logs-key': 'wrong-key' } })).status, 403);
  });

  test('the right key reads them', async () => {
    process.env.APP_LOGS_KEY = 'right-key';
    const response = await fetch(url, { headers: { 'x-app-logs-key': 'right-key' } });
    assert.equal(response.status, 200);
  });

  describe('writing them', () => {
    let saved;
    const originalCreate = AppLog.create;
    const post = (body) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    beforeEach(() => {
      saved = null;
      AppLog.create = async (row) => { saved = row; return { id: 1 }; };
    });
    afterEach(() => { AppLog.create = originalCreate; });

    test('a normal error is stored', async () => {
      const response = await post({ level: 'error', message: 'boom', payload: ['boom'], platform: 'android' });
      assert.equal(response.status, 201);
      assert.deepEqual(saved.payload, ['boom']);
    });

    test('oversized content is cut down', async () => {
      await post({ level: 'error', message: 'x'.repeat(9000), payload: ['y'.repeat(30000)], platform: 'z'.repeat(99) });
      assert.equal(saved.message.length, 5000);
      assert.equal(saved.payload, null);
      assert.equal(saved.platform.length, 20);
    });

    test('a message that is not text is refused', async () => {
      assert.equal((await post({ level: 'error', message: { a: 1 } })).status, 400);
    });

    test('a flood is cut off', async () => {
      const statuses = [];
      for (let i = 0; i < 310; i += 1) statuses.push((await post({ level: 'error', message: 'spam' })).status);
      assert.equal(statuses.at(-1), 429);
    });
  });
});
