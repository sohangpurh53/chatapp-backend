const net = require('net');
const dns = require('dns');
const { AiError } = require('./errors');

// Server-side request forgery protection for provider endpoints.
//  - Only http(s). No credentials, query string or fragment in the base URL.
//  - Every address a hostname resolves to is checked at connect time. The
//    check runs inside the socket's DNS lookup, so DNS rebinding cannot swap
//    in a private address after validation. IP literals are checked directly.
//  - Link-local (cloud metadata), multicast and reserved ranges are always
//    blocked. Loopback and private networks are allowed only when the server
//    operator sets AI_ALLOW_PRIVATE_ENDPOINTS=true (self-hosted Ollama etc.).
//  - Plain HTTP is only allowed towards private addresses, so API keys never
//    cross the internet unencrypted.

const ipv4ToInt = (ip) => ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
const inV4 = (ip, cidr) => {
  const [base, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
};

// Never reachable, whatever the server configuration
const V4_ALWAYS_BLOCKED = [
  '0.0.0.0/8', '169.254.0.0/16', '192.0.0.0/24', '192.0.2.0/24', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];
// Reachable only with AI_ALLOW_PRIVATE_ENDPOINTS=true
const V4_PRIVATE = ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

const expandV6 = (ip) => {
  let address = ip.toLowerCase().split('%')[0];
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  const v4Tail = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const n = ipv4ToInt(v4Tail[1]);
    address = address.replace(v4Tail[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const halves = address.split('::');
  const headParts = halves[0] ? halves[0].split(':') : [];
  if (halves.length === 1) return headParts.map(p => parseInt(p || '0', 16));
  const tailParts = halves[1] ? halves[1].split(':') : [];
  const missing = Math.max(8 - headParts.length - tailParts.length, 0);
  return [...headParts, ...Array(missing).fill('0'), ...tailParts].map(p => parseInt(p || '0', 16));
};

/** 'blocked' | 'private' | 'public' */
const classifyAddress = (ip) => {
  const family = net.isIP(ip);
  if (family === 4) {
    if (ip === '255.255.255.255' || V4_ALWAYS_BLOCKED.some(c => inV4(ip, c))) return 'blocked';
    if (V4_PRIVATE.some(c => inV4(ip, c))) return 'private';
    return 'public';
  }
  if (family === 6) {
    const p = expandV6(ip);
    const zeroUpTo = (n) => p.slice(0, n).every(x => x === 0);
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the IPv4 inside
    const mapped = zeroUpTo(5) && p[5] === 0xffff;
    const nat64 = p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every(x => x === 0);
    if (mapped || nat64) {
      return classifyAddress(`${p[6] >> 8}.${p[6] & 255}.${p[7] >> 8}.${p[7] & 255}`);
    }
    if (p.every(x => x === 0)) return 'blocked'; // ::
    if (zeroUpTo(7) && p[7] === 1) return 'private'; // ::1
    if ((p[0] & 0xffc0) === 0xfe80) return 'blocked'; // link-local
    if ((p[0] & 0xff00) === 0xff00) return 'blocked'; // multicast
    if (p[0] === 0x2001 && p[1] === 0x0db8) return 'blocked'; // documentation
    if ((p[0] & 0xfe00) === 0xfc00) return 'private'; // unique local
    return 'public';
  }
  return 'blocked';
};

const BLOCKED_HOSTNAMES = [/^metadata$/i, /\.internal$/i];

const privateEndpointsAllowed = () =>
  String(process.env.AI_ALLOW_PRIVATE_ENDPOINTS || '').toLowerCase() === 'true';

const checkAddress = (address, { allowPrivate, protocol }) => {
  const kind = classifyAddress(address);
  if (kind === 'blocked') throw new AiError('BLOCKED_ENDPOINT');
  if (kind === 'private' && !allowPrivate) throw new AiError('BLOCKED_ENDPOINT');
  if (protocol === 'http:' && kind !== 'private') throw new AiError('INSECURE_ENDPOINT');
  return kind;
};

/**
 * Validate and normalise a base URL. Checks the format and literal addresses;
 * host names are checked again on every connection. Returns the URL without a
 * trailing slash.
 */
const validateBaseUrl = (raw, { allowPrivate = false } = {}) => {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) throw new AiError('INVALID_ENDPOINT');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AiError('INVALID_ENDPOINT');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AiError('INVALID_ENDPOINT', 'The API address must start with https://');
  }
  if (url.username || url.password) {
    throw new AiError('INVALID_ENDPOINT', 'Put the API key in the API key field, not in the address.');
  }
  if (url.search || url.hash) {
    throw new AiError('INVALID_ENDPOINT', 'The API address must not contain a query string or #fragment.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || BLOCKED_HOSTNAMES.some(re => re.test(hostname))) throw new AiError('BLOCKED_ENDPOINT');

  if (net.isIP(hostname)) {
    checkAddress(hostname, { allowPrivate, protocol: url.protocol });
  } else if (/^localhost$/i.test(hostname) || /\.localhost$/i.test(hostname)) {
    if (!allowPrivate) throw new AiError('BLOCKED_ENDPOINT');
  } else if (url.protocol === 'http:' && !allowPrivate) {
    throw new AiError('INSECURE_ENDPOINT');
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

/** A dns.lookup replacement for http(s).request that refuses forbidden addresses. */
const guardedLookup = ({ allowPrivate, protocol }) => (hostname, options, callback) => {
  const cb = typeof options === 'function' ? options : callback;
  let opts = {};
  if (typeof options === 'number') opts = { family: options };
  else if (options && typeof options === 'object') opts = options;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    try {
      if (!addresses || !addresses.length) throw new AiError('UNREACHABLE');
      for (const entry of addresses) checkAddress(entry.address, { allowPrivate, protocol });
    } catch (guardError) {
      return cb(guardError);
    }
    if (opts.all) return cb(null, addresses);
    return cb(null, addresses[0].address, addresses[0].family);
  });
};

module.exports = { classifyAddress, validateBaseUrl, guardedLookup, checkAddress, privateEndpointsAllowed };
