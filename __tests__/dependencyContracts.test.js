/**
 * Guards the packages we patched for CVEs. Several fixes are npm `overrides`
 * or major bumps that `npm audit` happily reports as clean even when they break
 * us at runtime (query-string 10 left minio without `stringify`, for example),
 * so these exercise the real behaviour rather than the mere install.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');
const Minio = require('minio');

describe('minio with overridden query-string / stream-json', () => {
  const client = new Minio.Client({
    endPoint: '127.0.0.1',
    port: 9000,
    useSSL: false,
    accessKey: 'access',
    secretKey: 'secret-secret',
    region: 'us-east-1',
  });

  it('signs presigned URLs deterministically', async () => {
    const url = await client.presignedGetObject(
      'bucket',
      'a/b c.jpg',
      3600,
      { 'response-content-disposition': 'attachment' },
      new Date('2026-01-01T00:00:00Z')
    );
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/bucket/a/b%20c.jpg');
    assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(parsed.searchParams.get('response-content-disposition'), 'attachment');
    assert.match(parsed.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  });

  // minio requires 'stream-json/jsonl/Parser.js' at load time. stream-json 3.x
  // renamed it to parser.js, which only "works" on case-insensitive disks
  // (Windows, /mnt/*) and crashes the server on Linux/Docker.
  it('can load the stream-json parser minio requires', () => {
    const minioDir = path.dirname(require.resolve('minio'));
    const { make } = require(require.resolve('stream-json/jsonl/Parser.js', { paths: [minioDir] }));
    assert.equal(typeof make, 'function');
  });

  it('keeps the query encoding S3 signatures depend on', () => {
    const qs = require(require.resolve('query-string', {
      paths: [path.dirname(require.resolve('minio'))],
    }));
    assert.equal(qs.stringify({ b: 'x/y z', a: 1 }), 'a=1&b=x%2Fy%20z');
    assert.equal(qs.stringify({ a: "!'()*~" }), 'a=%21%27%28%29%2A~');
  });
});

describe('MINIO_USE_SSL parsing', () => {
  const { isEnabled } = require('../config/minio');

  it('treats any spelling of true as on', () => {
    for (const value of ['true', 'True', 'TRUE', ' true ', '1', 'yes', 'on']) {
      assert.equal(isEnabled(value), true, value);
    }
  });

  it('treats everything else as off', () => {
    for (const value of ['false', 'False', '0', '', 'no', 'off', undefined, null, 'truthy']) {
      assert.equal(isEnabled(value), false, String(value));
    }
  });
});

describe('sharp image pipelines', () => {
  const mediaService = require('../services/mediaService');
  const source = () =>
    sharp({
      create: { width: 640, height: 320, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 0.5 } },
    });

  for (const format of ['png', 'jpeg', 'webp', 'gif']) {
    it(`compresses a ${format} avatar to an upright JPEG`, async () => {
      const buffer = await source().toFormat(format).toBuffer();
      const out = await mediaService.compressAvatar({ buffer, originalname: `me.${format}`, mimetype: `image/${format}` });
      const meta = await sharp(out.buffer).metadata();
      assert.equal(meta.format, 'jpeg');
      assert.equal(out.mimetype, 'image/jpeg');
      assert.equal(out.originalname, 'me.jpg');
      assert.ok(meta.width <= 640);
    });
  }

  it('rejects bytes that are not an image', async () => {
    await assert.rejects(
      mediaService.compressAvatar({ buffer: Buffer.from('not an image'), originalname: 'x.png' })
    );
  });

  it('compressImage falls back to the original bytes on bad input', async () => {
    const bad = Buffer.from('not an image');
    assert.equal(await mediaService.compressImage(bad), bad);
  });
});

describe('nodemailer 10 over a real SMTP socket', () => {
  let server;
  let received = '';
  const saved = {};
  const envKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];

  before(async () => {
    server = net.createServer((socket) => {
      let inData = false;
      socket.write('220 test ESMTP\r\n');
      socket.on('data', (chunk) => {
        const text = chunk.toString();
        received += text;
        if (inData) {
          if (text.endsWith('\r\n.\r\n')) {
            inData = false;
            socket.write('250 queued\r\n');
          }
        } else if (/^(EHLO|HELO)/i.test(text)) socket.write('250 test\r\n');
        else if (/^DATA/i.test(text)) {
          inData = true;
          socket.write('354 go\r\n');
        } else if (/^QUIT/i.test(text)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    for (const key of envKeys) saved[key] = process.env[key];
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(server.address().port);
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    process.env.MAIL_FROM = 'noreply@example.test';
    delete require.cache[require.resolve('../services/mailer')];
  });

  after(async () => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[require.resolve('../services/mailer')];
    await new Promise((resolve) => server.close(resolve));
  });

  it('delivers the message through services/mailer', async () => {
    const { sendMail } = require('../services/mailer');
    const result = await sendMail({ to: 'user@example.test', subject: 'Reset code', text: 'Your code is 123456' });
    assert.deepEqual(result, { delivered: true });
    assert.match(received, /MAIL FROM:<noreply@example\.test>/i);
    assert.match(received, /RCPT TO:<user@example\.test>/i);
    assert.match(received, /Subject: Reset code/);
    assert.match(received, /Your code is 123456/);
  });
});

describe('bull-board 9 mounted in Express 4', () => {
  let server;
  let base;

  before(async () => {
    const { createBullBoard } = require('@bull-board/api');
    const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
    const { ExpressAdapter } = require('@bull-board/express');

    const fakeQueue = {
      name: 'notifications',
      opts: {},
      metaValues: { version: 'bullmq-5.65.0' },
      getWorkers: async () => [],
      getRateLimitTtl: async () => 0,
      getJobSchedulersCount: async () => 0,
      toKey: (type) => `bull:notifications:${type}`,
      getJobCounts: async () => ({ waiting: 2, active: 0, completed: 1, failed: 0, delayed: 0, paused: 0 }),
      getJobs: async () => [],
      isPaused: async () => false,
      getGlobalConcurrency: async () => null,
      client: Promise.resolve({ info: async () => 'redis_version:7.0.0\r\n' }),
    };

    const adapter = new ExpressAdapter();
    adapter.setBasePath('/admin/queues');
    createBullBoard({ queues: [new BullMQAdapter(fakeQueue)], serverAdapter: adapter });

    const app = express();
    const gate = (req, res, next) =>
      req.headers.authorization === 'Bearer ok' ? next() : res.status(401).json({ error: 'Unauthorized' });
    app.use('/admin/queues', gate, adapter.getRouter());
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/admin/queues`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const get = (suffix = '', auth = true) =>
    fetch(`${base}${suffix}`, { headers: auth ? { authorization: 'Bearer ok' } : {} });

  it('stays behind the admin gate', async () => {
    assert.equal((await get('', false)).status, 401);
    assert.equal((await get('/api/queues', false)).status, 401);
  });

  it('serves the dashboard page with assets under the mount path', async () => {
    const res = await get();
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<div id="root">/);
    const asset = html.match(/(?:href|src)="(static\/[^"]+\.(?:js|css))"/);
    assert.match(html, /<base href="\/admin\/queues\/"/);
    assert.ok(asset, 'expected a bundled asset');
    assert.equal((await get(`/${asset[1]}`)).status, 200);
  });

  it('serves the queue API', async () => {
    const res = await get('/api/queues');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.queues[0].name, 'notifications');
    assert.equal(body.queues[0].counts.waiting, 2);
  });
});
