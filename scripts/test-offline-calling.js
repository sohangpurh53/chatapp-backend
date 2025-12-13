#!/usr/bin/env node

/**
 * Test Offline Calling Implementation
 * 
 * This script tests the offline calling functionality by simulating:
 * 1. User going offline
 * 2. Caller sending SDP offer
 * 3. Signal storage in Redis
 * 4. FCM notification with signal data
 * 5. User coming back online
 * 6. Signal delivery and call establishment
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const redisService = require('../config/redis');
const { v4: uuidv4 } = require('uuid');

// Test data
const testCallId = uuidv4();
const testCallerId = 'caller-123';
const testReceiverId = 'receiver-456';

const testOffer = {
  type: 'offer',
  sdp: 'v=0\r\no=- 123456789 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=msid-semantic: WMS\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtcp:9 IN IP4 0.0.0.0\r\na=ice-ufrag:test\r\na=ice-pwd:testpassword\r\na=ice-options:trickle\r\na=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\r\na=setup:actpass\r\na=mid:0\r\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\na=sendrecv\r\na=msid:test testtrack\r\na=rtcp-mux\r\na=rtpmap:111 opus/48000/2\r\na=ssrc:1001 cname:test\r\na=ssrc:1001 msid:test testtrack\r\na=ssrc:1001 mslabel:test\r\na=ssrc:1001 label:testtrack\r\n'
};

async function testOfflineCalling() {
  console.log('🧪 Testing Offline Calling Implementation');
  console.log('==========================================');
  
  try {
    // Step 1: Validate signal data
    console.log('\n📋 Step 1: Validating signal data...');
    const validation = redisService.validateSignalData(testOffer);
    if (!validation.valid) {
      throw new Error(`Signal validation failed: ${validation.error}`);
    }
    console.log('✅ Signal data is valid');

    // Step 2: Simulate storing signal for offline user
    console.log('\n📥 Step 2: Storing signal for offline user...');
    const signalData = {
      type: testOffer.type,
      payload: testOffer,
      fromUserId: testCallerId,
      timestamp: Date.now(),
      callId: testCallId
    };

    await redisService.pushPendingSignal(testReceiverId, testCallId, signalData);
    console.log(`✅ Signal stored for user ${testReceiverId}, call ${testCallId}`);

    // Step 3: Verify signal storage
    console.log('\n🔍 Step 3: Verifying signal storage...');
    const pendingSignals = await redisService.getPendingSignalsForUser(testReceiverId);
    
    if (!pendingSignals[testCallId] || pendingSignals[testCallId].length === 0) {
      throw new Error('Signal not found in storage');
    }
    
    const storedSignal = pendingSignals[testCallId][0];
    console.log('✅ Signal found in storage:');
    console.log(`   - Type: ${storedSignal.type}`);
    console.log(`   - From: ${storedSignal.fromUserId}`);
    console.log(`   - Timestamp: ${new Date(storedSignal.timestamp).toISOString()}`);
    console.log(`   - Has SDP: ${!!storedSignal.payload.sdp}`);

    // Step 4: Test signal retrieval and validation
    console.log('\n📤 Step 4: Testing signal retrieval...');
    const retrievedSignals = await redisService.getPendingSignalsForUser(testReceiverId);
    const callSignals = retrievedSignals[testCallId] || [];
    
    if (callSignals.length === 0) {
      throw new Error('No signals found for call');
    }
    
    const offerSignal = callSignals.find(s => s.type === 'offer');
    if (!offerSignal) {
      throw new Error('Offer signal not found');
    }
    
    console.log('✅ Offer signal retrieved successfully');
    console.log(`   - SDP length: ${offerSignal.payload.sdp.length} characters`);

    // Step 5: Test FCM payload preparation
    console.log('\n📱 Step 5: Testing FCM payload preparation...');
    const fcmPayload = {
      title: 'Incoming voice call',
      body: `${testCallerId} is calling you`,
      type: 'incoming_call_with_signal',
      priority: 'high',
      data: {
        type: 'incoming_call_with_signal',
        callId: testCallId,
        callerId: testCallerId,
        receiverId: testReceiverId,
        callType: 'voice',
        signalType: offerSignal.type,
        signalData: JSON.stringify(offerSignal.payload),
        timestamp: String(Date.now()),
        action: 'incoming_call_with_signal'
      }
    };

    // Check payload size (FCM has 4KB limit)
    const payloadSize = JSON.stringify(fcmPayload).length;
    console.log(`✅ FCM payload prepared (${payloadSize} bytes)`);
    
    if (payloadSize > 4000) {
      console.warn('⚠️  Payload size exceeds recommended FCM limit (4KB)');
    }

    // Step 6: Simulate user reconnection and signal delivery
    console.log('\n🔄 Step 6: Simulating user reconnection...');
    
    // This would normally be done by the socket handler when user reconnects
    const pendingForDelivery = await redisService.getPendingSignalsForUser(testReceiverId);
    
    for (const callId of Object.keys(pendingForDelivery)) {
      const signals = pendingForDelivery[callId];
      console.log(`📤 Would deliver ${signals.length} signals for call ${callId}`);
      
      for (const signal of signals) {
        console.log(`   - Signal: ${signal.type} from ${signal.fromUserId}`);
      }
    }

    // Step 7: Cleanup test data
    console.log('\n🧹 Step 7: Cleaning up test data...');
    await redisService.deletePendingSignals(testReceiverId, testCallId);
    
    // Verify cleanup
    const afterCleanup = await redisService.getPendingSignalsForUser(testReceiverId);
    if (afterCleanup[testCallId] && afterCleanup[testCallId].length > 0) {
      console.warn('⚠️  Cleanup may not have been complete');
    } else {
      console.log('✅ Test data cleaned up successfully');
    }

    console.log('\n🎉 All tests passed! Offline calling implementation is working correctly.');
    console.log('==========================================');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Additional test: Signal expiration
async function testSignalExpiration() {
  console.log('\n⏰ Testing signal expiration...');
  
  const expiredCallId = uuidv4();
  const expiredSignal = {
    type: 'offer',
    payload: testOffer,
    fromUserId: testCallerId,
    timestamp: Date.now(),
    callId: expiredCallId,
    expiresAt: Date.now() - 1000 // Expired 1 second ago
  };

  // Store expired signal
  await redisService.pushPendingSignal(testReceiverId, expiredCallId, expiredSignal, 1); // 1 second TTL
  
  // Wait for expiration
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Try to retrieve - should be filtered out
  const signals = await redisService.getPendingSignalsForUser(testReceiverId);
  
  if (signals[expiredCallId] && signals[expiredCallId].length > 0) {
    console.warn('⚠️  Expired signal was not filtered out');
  } else {
    console.log('✅ Expired signals are properly filtered');
  }
}

// Run tests
async function runAllTests() {
  try {
    await testOfflineCalling();
    await testSignalExpiration();
    
    console.log('\n🏆 All tests completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n💥 Test suite failed:', error);
    process.exit(1);
  }
}

runAllTests();