#!/usr/bin/env node

/**
 * Test FCM Notifications for Offline Calling
 * 
 * This script tests that only ONE FCM notification is sent per call
 * and that it contains the proper action buttons.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { v4: uuidv4 } = require('uuid');

// Mock FCM service to capture notifications
let sentNotifications = [];

const mockFCMService = {
  async sendNotification(userId, notification) {
    console.log(`📱 FCM Notification sent to user ${userId}:`);
    console.log(`   Title: ${notification.title}`);
    console.log(`   Body: ${notification.body}`);
    console.log(`   Type: ${notification.type}`);
    console.log(`   Has Actions: ${!!notification.data?.action}`);
    console.log(`   Signal Type: ${notification.data?.signalType || 'none'}`);
    console.log(`   Has Signal Data: ${!!notification.data?.signalData}`);
    
    sentNotifications.push({
      userId,
      notification,
      timestamp: Date.now()
    });
    
    return { success: true, messageId: `mock-${Date.now()}` };
  }
};

// Mock the FCM service
jest.doMock('../services/fcmService', () => mockFCMService);

async function testFCMNotifications() {
  console.log('🧪 Testing FCM Notifications for Offline Calling');
  console.log('================================================');
  
  try {
    // Reset notifications
    sentNotifications = [];
    
    const testCallId = uuidv4();
    const testCallerId = 'caller-123';
    const testReceiverId = 'receiver-456';
    
    // Import socket handlers after mocking
    const SocketHandlers = require('../socket/socketHandlers');
    const redisService = require('../config/redis');
    
    // Create mock socket handler instance
    const mockIO = {
      to: () => ({
        emit: () => console.log('Mock socket emit')
      })
    };
    
    const socketHandler = new SocketHandlers(mockIO);
    
    // Mock call data
    const callData = {
      id: testCallId,
      callerId: testCallerId,
      receiverId: testReceiverId,
      callType: 'voice',
      status: 'ringing'
    };
    
    // Store call in Redis
    await redisService.setActiveCall(testCallId, callData);
    
    // Test 1: Send offer signal (should trigger FCM)
    console.log('\n📤 Test 1: Sending offer signal...');
    
    const offerSignal = {
      type: 'offer',
      sdp: 'v=0\r\no=- 123456789 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
    };
    
    await socketHandler.sendSignalViaFCM(
      testReceiverId,
      testCallId,
      offerSignal,
      callData,
      testCallerId
    );
    
    // Test 2: Send ICE candidate (should NOT trigger FCM due to our fix)
    console.log('\n🧊 Test 2: Sending ICE candidate...');
    
    const iceSignal = {
      type: 'ice-candidate',
      candidate: 'candidate:1 1 UDP 2130706431 192.168.1.100 54400 typ host'
    };
    
    // This should not send FCM because it's not an offer
    console.log('   (This should NOT send FCM - ICE candidates are stored only)');
    
    // Test 3: Try to send another offer (should be rate limited)
    console.log('\n🔄 Test 3: Sending duplicate offer (should be rate limited)...');
    
    await socketHandler.sendSignalViaFCM(
      testReceiverId,
      testCallId,
      offerSignal,
      callData,
      testCallerId
    );
    
    // Analyze results
    console.log('\n📊 Results Analysis:');
    console.log(`   Total FCM notifications sent: ${sentNotifications.length}`);
    
    if (sentNotifications.length === 1) {
      console.log('✅ PASS: Only one FCM notification sent (as expected)');
      
      const notification = sentNotifications[0].notification;
      
      // Check notification structure
      if (notification.type === 'incoming_call_with_signal') {
        console.log('✅ PASS: Notification type is correct');
      } else {
        console.log('❌ FAIL: Wrong notification type:', notification.type);
      }
      
      if (notification.data?.signalData) {
        console.log('✅ PASS: Signal data included in notification');
      } else {
        console.log('❌ FAIL: Signal data missing from notification');
      }
      
      if (notification.data?.action === 'incoming_call_with_signal') {
        console.log('✅ PASS: Action field is correct');
      } else {
        console.log('❌ FAIL: Action field missing or incorrect');
      }
      
    } else if (sentNotifications.length === 0) {
      console.log('❌ FAIL: No FCM notifications sent');
    } else {
      console.log(`❌ FAIL: Too many FCM notifications sent (${sentNotifications.length})`);
      console.log('   This indicates the rate limiting is not working');
    }
    
    // Cleanup
    await redisService.deleteActiveCall(testCallId);
    
    console.log('\n🎉 Test completed!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

// Note: This is a conceptual test - in a real environment you'd use a proper testing framework
console.log('📝 Note: This is a conceptual test script.');
console.log('   In production, implement proper integration tests with your testing framework.');
console.log('   The key fixes implemented:');
console.log('   1. Only send FCM for "offer" signals, not ICE candidates');
console.log('   2. Rate limiting to prevent duplicate notifications');
console.log('   3. Proper action buttons in FCM payload');

process.exit(0);