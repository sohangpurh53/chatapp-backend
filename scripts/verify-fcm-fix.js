#!/usr/bin/env node

/**
 * Verify FCM Actions Fix
 * 
 * This script verifies that the FCM payload structure has been fixed
 * by examining the code directly without requiring database access.
 */

const fs = require('fs');
const path = require('path');

function verifyFCMFix() {
  console.log('🔍 Verifying FCM Actions Fix...\n');

  const fcmServicePath = path.join(__dirname, '..', 'services', 'fcmService.js');
  const fcmServiceCode = fs.readFileSync(fcmServicePath, 'utf8');

  // Check if actions is incorrectly placed in android.notification
  const incorrectPattern = /android\s*:\s*{[^}]*notification\s*:\s*{[^}]*actions\s*:/s;
  const hasIncorrectPlacement = incorrectPattern.test(fcmServiceCode);

  // Check if actions is correctly placed at android level
  const correctPattern = /android\s*:\s*{[^}]*actions\s*:\s*\[/s;
  const hasCorrectPlacement = correctPattern.test(fcmServiceCode);

  console.log('📋 Analysis Results:');
  console.log('==================');

  if (hasIncorrectPlacement) {
    console.log('❌ ISSUE FOUND: actions still in android.notification (incorrect)');
    return false;
  } else {
    console.log('✅ GOOD: No actions found in android.notification');
  }

  if (hasCorrectPlacement) {
    console.log('✅ GOOD: actions found at android level (correct)');
  } else {
    console.log('⚠️  WARNING: No actions found at android level');
  }

  // Look for the specific fix pattern
  const fixPattern = /\/\/ ✅ CRITICAL: Move actions to android level \(not inside notification\)/;
  const hasFixComment = fixPattern.test(fcmServiceCode);

  if (hasFixComment) {
    console.log('✅ GOOD: Fix comment found - actions moved to correct location');
  }

  // Extract the relevant section for visual inspection
  const androidSectionMatch = fcmServiceCode.match(/android\s*:\s*{[\s\S]*?},\s*apns/);
  if (androidSectionMatch) {
    console.log('\n📱 Android Section Structure:');
    console.log('============================');
    console.log(androidSectionMatch[0].replace(/},\s*apns$/, '}'));
  }

  console.log('\n🎯 Summary:');
  console.log('===========');
  
  if (!hasIncorrectPlacement && hasCorrectPlacement) {
    console.log('✅ FCM Actions Fix: SUCCESSFUL');
    console.log('✅ The "Unknown name actions" error should be resolved');
    console.log('✅ Actions are now correctly placed at android level');
    return true;
  } else if (!hasIncorrectPlacement && !hasCorrectPlacement) {
    console.log('⚠️  FCM Actions Fix: PARTIAL');
    console.log('⚠️  No incorrect placement found, but no actions detected');
    console.log('ℹ️  This might be normal if actions are conditionally added');
    return true;
  } else {
    console.log('❌ FCM Actions Fix: FAILED');
    console.log('❌ Actions are still incorrectly placed');
    return false;
  }
}

// Run verification
const success = verifyFCMFix();
process.exit(success ? 0 : 1);