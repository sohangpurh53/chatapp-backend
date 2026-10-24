const { Sequelize } = require('sequelize');

/**
 * Emails are matched ignoring case and surrounding spaces, so the address typed
 * at email sign-up and the one Google reports (always lowercase) are one user.
 * The column itself stays as stored: Postgres `unique` is case-sensitive.
 */
const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

/** A Sequelize `where` that matches User.email case-insensitively. */
const emailMatches = (email) => Sequelize.where(
  Sequelize.fn('lower', Sequelize.col('email')),
  normalizeEmail(email)
);

module.exports = { normalizeEmail, emailMatches };
