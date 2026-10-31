const crypto = require('crypto');

const same = (a, b) => {
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
};

/** Browser login for admin pages. With no password configured, nobody gets in. */
const requireAdmin = (req, res, next) => {
  const user = process.env.ADMIN_USER;
  const password = process.env.ADMIN_PASSWORD;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  const [givenUser, ...rest] = Buffer.from(encoded || '', 'base64').toString().split(':');

  if (user && password && scheme === 'Basic' && same(givenUser, user) && same(rest.join(':'), password)) {
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin", charset="UTF-8"');
  return res.status(401).json({ error: 'Authentication required' });
};

module.exports = { requireAdmin };
