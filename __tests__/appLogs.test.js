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
});
