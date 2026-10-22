const crypto = require('crypto');
const { AiError } = require('./errors');

// Provider API keys are encrypted at rest with AES-256-GCM. The key comes from
// AI_CREDENTIALS_KEY (32 bytes as 64 hex chars or base64) and never touches the
// database. Each ciphertext is bound to its owner and provider row through the
// GCM additional data, so a blob copied onto another row will not decrypt.
// To rotate: move the old value to AI_CREDENTIALS_KEY_PREVIOUS (comma-separated
// list allowed) and set a new AI_CREDENTIALS_KEY. Old blobs still decrypt and
// are re-encrypted with the new key the next time they are used.

const FORMAT_VERSION = 1;

const parseKey = (raw, name) => {
  const value = String(raw || '').trim();
  if (!value) return null;
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error(`${name} must be 32 bytes, given as 64 hex characters or base64`);
  }
  return key;
};

const keyIdOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);

let cached = null;
let cachedFrom = null;

const loadKeys = () => {
  const source = `${process.env.AI_CREDENTIALS_KEY || ''}|${process.env.AI_CREDENTIALS_KEY_PREVIOUS || ''}`;
  if (cached && cachedFrom === source) return cached;
  const current = parseKey(process.env.AI_CREDENTIALS_KEY, 'AI_CREDENTIALS_KEY');
  const previous = String(process.env.AI_CREDENTIALS_KEY_PREVIOUS || '')
    .split(',')
    .map(v => parseKey(v, 'AI_CREDENTIALS_KEY_PREVIOUS'))
    .filter(Boolean);
  cached = {
    current: current ? { key: current, kid: keyIdOf(current) } : null,
    all: [current, ...previous].filter(Boolean).map(key => ({ key, kid: keyIdOf(key) })),
  };
  cachedFrom = source;
  return cached;
};

const isConfigured = () => {
  try {
    return !!loadKeys().current;
  } catch {
    return false;
  }
};

const aadFor = (context) => Buffer.from(`chatapp-ai:${context.userId}:${context.providerId}`);

/** Encrypt a secret for one provider row. Returns an opaque string for the database. */
const encrypt = (plaintext, context) => {
  let keys;
  try {
    keys = loadKeys();
  } catch {
    throw new AiError('VAULT_NOT_CONFIGURED', 'The server AI_CREDENTIALS_KEY is malformed.');
  }
  if (!keys.current) throw new AiError('VAULT_NOT_CONFIGURED');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.current.key, iv);
  cipher.setAAD(aadFor(context));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: FORMAT_VERSION,
    kid: keys.current.kid,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  });
};

/** Decrypt a stored secret. `needsRotation` is true when an older key was used. */
const decrypt = (blob, context) => {
  let parsed;
  try {
    parsed = JSON.parse(blob);
  } catch {
    throw new AiError('VAULT_DECRYPT_FAILED');
  }
  let keys;
  try {
    keys = loadKeys();
  } catch {
    throw new AiError('VAULT_NOT_CONFIGURED', 'The server AI_CREDENTIALS_KEY is malformed.');
  }
  if (!keys.all.length) throw new AiError('VAULT_NOT_CONFIGURED');
  const candidates = [...keys.all.filter(k => k.kid === parsed.kid), ...keys.all.filter(k => k.kid !== parsed.kid)];
  for (const candidate of candidates) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', candidate.key, Buffer.from(parsed.iv, 'base64'));
      decipher.setAAD(aadFor(context));
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.ct, 'base64')), decipher.final()]).toString('utf8');
      return { plaintext, needsRotation: !keys.current || candidate.kid !== keys.current.kid };
    } catch {
      // wrong key or tampered blob: try the next key
    }
  }
  throw new AiError('VAULT_DECRYPT_FAILED');
};

/** "••••abcd": enough for the user to recognise a key, useless to anyone else. */
const hintFor = (secret) => {
  const value = String(secret || '');
  return value.length >= 12 ? `••••${value.slice(-4)}` : '••••';
};

module.exports = { isConfigured, encrypt, decrypt, hintFor };
