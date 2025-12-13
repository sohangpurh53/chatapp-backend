#!/usr/bin/env node

/**
 * Cleanup Expired Signals Script
 * 
 * This script cleans up expired WebRTC signaling data from Redis.
 * Should be run periodically (e.g., every 5 minutes) via cron job.
 * 
 * Usage:
 *   node scripts/cleanup-expired-signals.js
 * 
 * Cron job example (every 5 minutes):
 *   5 * * * * /usr/bin/node /path/to/backend/scripts/cleanup-expired-signals.js
//  */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const redisService = require('../config/redis');

async function cleanupExpiredSignals() {
  try {
    console.log('🧹 Starting expired signals cleanup...');
    
    const cleanedCount = await redisService.cleanupExpiredSignals();
    
    if (cleanedCount > 0) {
      console.log(`✅ Cleanup completed: ${cleanedCount} expired signals removed`);
    } else {
      console.log('ℹ️  No expired signals found');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  }
}

// Run cleanup
cleanupExpiredSignals();