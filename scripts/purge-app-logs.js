#!/usr/bin/env node
/**
 * Deletes stored app logs.
 *
 *   node scripts/purge-app-logs.js                    # only counts
 *   node scripts/purge-app-logs.js --delete           # deletes everything
 *   node scripts/purge-app-logs.js --delete --days 30 # keeps the last 30 days
 */
require('dotenv').config();
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const AppLog = require('../models/AppLog');

const args = process.argv.slice(2);
const daysArg = args.indexOf('--days');
const days = daysArg === -1 ? null : Number(args[daysArg + 1]);

const main = async () => {
  if (days !== null && !(days >= 0)) throw new Error('--days needs a number');
  const where = days === null
    ? {}
    : { created_at: { [Op.lt]: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } };

  const total = await AppLog.count();
  const matching = await AppLog.count({ where });
  console.log(`${total} rows stored, ${matching} match`);

  if (args.includes('--delete')) {
    const deleted = await AppLog.destroy({ where });
    console.log(`Deleted ${deleted} rows`);
  } else {
    console.log('Nothing deleted (pass --delete)');
  }
};

main()
  .catch((error) => {
    console.error('Purge failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
