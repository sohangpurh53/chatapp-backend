const http = require('http');
const https = require('https');
const { AiError } = require('./errors');
const { guardedLookup, checkAddress } = require('./urlGuard');
const net = require('net');

const DEFAULT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '30000', 10));
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * One HTTP request to an AI provider, with SSRF checks on every resolved
 * address, no redirects, a hard timeout, a response size cap and cancellation.
 * Resolves with { status, headers, text } for any HTTP status; rejects with an
 * AiError for network failures.
 */
const request = (urlString, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  allowPrivate = false,
  signal,
} = {}) => new Promise((resolve, reject) => {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    reject(new AiError('INVALID_ENDPOINT'));
    return;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const protocol = url.protocol;
  if (protocol !== 'https:' && protocol !== 'http:') {
    reject(new AiError('INVALID_ENDPOINT'));
    return;
  }
  try {
    // Literal IPs skip DNS lookup, so check them here
    if (net.isIP(hostname)) checkAddress(hostname, { allowPrivate, protocol });
  } catch (error) {
    reject(error);
    return;
  }
  if (signal?.aborted) {
    reject(new AiError('CANCELLED'));
    return;
  }

  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  const transport = protocol === 'https:' ? https : http;
  let settled = false;
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    fn(value);
  };

  const req = transport.request({
    method,
    hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ChatApp-AI/1.0',
      ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...headers,
    },
    lookup: guardedLookup({ allowPrivate, protocol }),
    agent: false,
  }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400) {
      res.resume();
      req.destroy();
      finish(reject, new AiError('UNEXPECTED_REDIRECT', undefined, { providerStatus: res.statusCode }));
      return;
    }
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        finish(reject, new AiError('RESPONSE_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => finish(resolve, {
      status: res.statusCode,
      headers: res.headers,
      text: Buffer.concat(chunks).toString('utf8'),
    }));
    res.on('error', () => finish(reject, new AiError('UNREACHABLE')));
  });

  const timer = setTimeout(() => {
    req.destroy();
    finish(reject, new AiError('TIMEOUT'));
  }, timeoutMs);

  const onAbort = () => {
    req.destroy();
    finish(reject, new AiError('CANCELLED'));
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  req.on('error', (error) => {
    if (error instanceof AiError) return finish(reject, error);
    if (NETWORK_CODES.has(error.code)) {
      const tls = /CERT|TLS/.test(error.code);
      return finish(reject, new AiError('UNREACHABLE', tls
        ? 'The provider\'s TLS certificate is not valid.'
        : undefined));
    }
    return finish(reject, new AiError('UNREACHABLE'));
  });

  if (payload !== undefined) req.write(payload);
  req.end();
});

/** Parse a JSON response body or fail with BAD_RESPONSE. */
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('BAD_RESPONSE');
  }
};

module.exports = { request, parseJson, DEFAULT_TIMEOUT_MS };
