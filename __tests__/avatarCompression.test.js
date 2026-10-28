const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const mediaService = require('../services/mediaService');

const photo = (width, height, extra = {}) => sharp({
  create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } },
}).png().toBuffer().then(buffer => ({
  buffer, size: buffer.length, mimetype: 'image/png', originalname: 'me.png', ...extra,
}));

describe('avatar compression', () => {
  test('a large photo becomes a small JPEG within 512px', async () => {
    const file = await photo(3000, 2000);
    const out = await mediaService.compressAvatar(file);
    const meta = await sharp(out.buffer).metadata();

    assert.equal(meta.format, 'jpeg');
    assert.ok(Math.max(meta.width, meta.height) <= 512);
    assert.ok(Math.abs(meta.width / meta.height - 1.5) < 0.01); // not cropped or stretched
    assert.ok(out.size < file.size / 10, `${out.size} should be far smaller than ${file.size}`);
    assert.equal(out.size, out.buffer.length);
    assert.equal(out.mimetype, 'image/jpeg');
    assert.equal(out.originalname, 'me.jpg');
  });

  test('a small image is not enlarged', async () => {
    const out = await mediaService.compressAvatar(await photo(200, 100));
    const meta = await sharp(out.buffer).metadata();
    assert.deepEqual([meta.width, meta.height], [200, 100]);
  });

  test('the camera orientation is applied', async () => {
    const buffer = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#336699' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer(); // stored sideways: shows as 200x400
    const out = await mediaService.compressAvatar({ buffer, size: buffer.length, mimetype: 'image/jpeg', originalname: 'cam.jpg' });
    const meta = await sharp(out.buffer).metadata();
    assert.deepEqual([meta.width, meta.height], [200, 400]);
  });

  test('bytes that are not an image are rejected', async () => {
    const buffer = Buffer.from('not an image at all');
    await assert.rejects(mediaService.compressAvatar({ buffer, size: buffer.length, mimetype: 'image/jpeg', originalname: 'x.jpg' }));
  });
});
