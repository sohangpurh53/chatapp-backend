const crypto = require('crypto');
const { Op } = require('sequelize');
const { User, PasswordReset } = require('../models');
const { emailMatches } = require('../utils/email');
const mailer = require('./mailer');

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// Keyed by the user and the server secret, so a leaked table can't be brute-forced
// without the secret and one user's hash is useless for another
const hashCode = (userId, code) => crypto
  .createHmac('sha256', process.env.JWT_SECRET || 'dev-only-secret')
  .update(`${userId}:${code}`)
  .digest('hex');

const sameHash = (a, b) => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * Emails a reset code. Never reveals whether the address has an account: unknown
 * addresses, Google-only accounts (no password to reset) and requests inside the
 * cooldown all end the same way as a sent code.
 */
const requestReset = async (email) => {
  const user = await User.findOne({ where: emailMatches(email) });
  if (!user || !user.password) return { sent: false };

  const latest = await PasswordReset.findOne({ where: { userId: user.id }, order: [['createdAt', 'DESC']] });
  if (latest && Date.now() - new Date(latest.createdAt).getTime() < RESEND_COOLDOWN_MS) {
    return { sent: false };
  }

  // Only the newest code works
  await PasswordReset.destroy({ where: { userId: user.id, usedAt: null } });

  const code = generateCode();
  await PasswordReset.create({
    userId: user.id,
    codeHash: hashCode(user.id, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  await mailer.sendMail({
    to: user.email,
    subject: 'Your ChatApp password reset code',
    text: [
      `Your ChatApp password reset code is ${code}.`,
      '',
      `It expires in ${CODE_TTL_MS / 60000} minutes and works once.`,
      'If you did not ask for this, you can ignore this email: your password has not changed.',
    ].join('\n'),
  });
  return { sent: true };
};

/**
 * Checks a code. Wrong guesses are counted and the code locks after MAX_ATTEMPTS.
 * Returns the live reset record for a correct code (spend it with `useUp` once the
 * password is changed, so a request that fails halfway does not burn the code),
 * otherwise null.
 */
const verifyCode = async (userId, code) => {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;

  const reset = await PasswordReset.findOne({
    where: { userId, usedAt: null, expiresAt: { [Op.gt]: new Date() } },
    order: [['createdAt', 'DESC']],
  });
  if (!reset || reset.attempts >= MAX_ATTEMPTS) return null;

  if (!sameHash(reset.codeHash, hashCode(userId, code))) {
    await reset.update({ attempts: reset.attempts + 1 });
    return null;
  }
  return reset;
};

const useUp = (reset) => reset.update({ usedAt: new Date() });

module.exports = {
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
  MAX_ATTEMPTS,
  generateCode,
  hashCode,
  requestReset,
  verifyCode,
  useUp,
};
