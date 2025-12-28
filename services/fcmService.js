const { getMessaging } = require('../config/firebase');
const { User, Notification, UserDevice } = require('../models');
const { Op } = require('sequelize');
const deviceService = require('./deviceService');

class FCMService {
  /**
   * Register or update FCM token for a user device
   */
  async registerToken(userId, fcmToken, deviceInfo = {}) {
    try {
      // If no device info provided, try to update existing device or create a default one
      if (!deviceInfo.deviceId) {
        // Generate a device ID based on FCM token (fallback)
        deviceInfo.deviceId = `fcm_${fcmToken.substring(0, 16)}`;
        deviceInfo.deviceName = 'Unknown Device';
        deviceInfo.deviceType = 'android'; // Default assumption
      }

      // Register/update device with FCM token
      const result = await deviceService.registerDevice(userId, {
        ...deviceInfo,
        fcmToken
      });

      console.log(`✅ FCM token registered for user ${userId} device ${deviceInfo.deviceId}`);
      return { success: true, device: result.device };
    } catch (error) {
      console.error('FCM token registration error:', error);
      throw error;
    }
  }

  /**
   * Deactivate device (on logout) - don't remove FCM token, just mark device as inactive
   */
  async removeToken(userId, deviceId = null) {
    try {
      if (deviceId) {
        // Deactivate specific device
        await deviceService.deactivateDevice(userId, deviceId);
        console.log(`✅ Device deactivated for user ${userId}: ${deviceId}`);
      } else {
        // Deactivate all devices (fallback for old clients)
        await deviceService.logoutAllDevices(userId);
        console.log(`✅ All devices deactivated for user ${userId}`);
      }
      return { success: true };
    } catch (error) {
      console.error('Device deactivation error:', error);
      throw error;
    }
  }

  /**
   * Send notification via FCM
   */
  async sendNotification(userId, notification) {
    try {
      // Check if Firebase messaging is available
      const messaging = getMessaging();
      if (!messaging) {
        console.warn(`⚠️  Firebase not configured - skipping notification for user ${userId}`);
        // Only update if notification has an id (database record)
        if (notification.id) {
          await Notification.update(
            {
              status: 'failed',
              error: 'Firebase not configured'
            },
            { where: { id: notification.id } }
          );
        }
        return { success: false, reason: 'firebase_not_configured' };
      }

      // console.log("notification payload investigate.......", notification)

      // Get user's active FCM tokens from devices
      const activeTokens = await deviceService.getActiveFCMTokens(userId);

      if (!activeTokens || activeTokens.length === 0) {
        console.log(`⚠️  No active FCM tokens for user ${userId}`);
        // Only update if notification has an id (database record)
        if (notification.id) {
          await Notification.update(
            {
              status: 'failed',
              error: 'No active FCM tokens'
            },
            { where: { id: notification.id } }
          );
        }
        return { success: false, reason: 'no_active_tokens' };
      }

      console.log(`📱 Found ${activeTokens.length} active device(s) for user ${userId}`);

      // Send to all active devices
      const results = [];
      for (const tokenInfo of activeTokens) {
        try {
          const result = await this.sendToDevice(userId, notification, tokenInfo);
          results.push(result);
        } catch (error) {
          console.error(`❌ Failed to send to device ${tokenInfo.deviceId}:`, error);
          results.push({ success: false, error: error.message, deviceId: tokenInfo.deviceId });
        }
      }

      // Check if at least one device received the notification
      const successCount = results.filter(r => r.success).length;
      
      if (successCount > 0) {
        console.log(`✅ Notification sent to ${successCount}/${activeTokens.length} devices for user ${userId}`);
        
        // Update notification status if it has an id
        if (notification.id) {
          await Notification.update(
            {
              status: 'sent',
              sentAt: new Date()
            },
            { where: { id: notification.id } }
          );
        }
        
        return { success: true, deviceResults: results };
      } else {
        console.log(`❌ Failed to send to all devices for user ${userId}`);
        
        // Update notification status if it has an id
        if (notification.id) {
          await Notification.update(
            {
              status: 'failed',
              error: 'Failed to send to all devices'
            },
            { where: { id: notification.id } }
          );
        }
        
        return { success: false, reason: 'all_devices_failed', deviceResults: results };
      }

    } catch (error) {
      console.error('FCM send error:', error);

      // Log failure - only update if notification has an id (database record)
      if (notification.id) {
        await Notification.update(
          {
            status: 'failed',
            error: error.message
          },
          { where: { id: notification.id } }
        );
      }

      throw error;
    }
  }

  /**
   * Send notification to a specific device
   */
  async sendToDevice(userId, notification, tokenInfo) {
    try {
      const messaging = getMessaging();
      if (!messaging) {
        throw new Error('Firebase not configured');
      }

      const { fcmToken, deviceId, deviceName, notificationPreferences } = tokenInfo;
      // Check notification preferences for this device
      const prefs = notificationPreferences || {};
      if (!this.shouldSendNotification(notification.type, prefs)) {
        console.log(`⚠️  Notification disabled by device preferences for user ${userId} device ${deviceId}`);
        return { success: false, reason: 'disabled_by_user', deviceId };
      }

      // Prepare data payload - all values must be strings
      const dataPayload = {
        type: notification.type,
        timestamp: new Date().toISOString()
      };

      // Convert notification.data to strings - FCM requires all data values to be strings
      if (notification.data) {
        Object.keys(notification.data).forEach(key => {
          const value = notification.data[key];
          if (value !== null && value !== undefined) {
            // ✅ CRITICAL: Ensure ALL values are strings for FCM
            if (typeof value === 'string') {
              // Handle large signal data with compression check
              if (key === 'signalData' && value.length > 3000) {
                console.warn(`⚠️  Signal data too large (${value.length} chars), truncating for FCM`);
                dataPayload[key] = JSON.stringify({ 
                  type: 'truncated', 
                  message: 'Signal data too large for FCM, will be delivered via socket' 
                });
              } else {
                dataPayload[key] = value;
              }
            } else {
              // ✅ Convert all non-string values to strings
              dataPayload[key] = String(value);
            }
          }
        });
      }

      // ✅ CRITICAL FIX: Use data-only payload for call notifications
      // This prevents default Firebase notifications and allows custom notifee notifications
      const isCallNotification = notification.type === 'incoming_call' || 
                                 notification?.data?.type === 'incoming_call_with_signal' ||
                                 notification?.data?.type === 'incoming_call_offline';

      const message = {
        token: fcmToken,
        // ✅ Only include notification for non-call types
        ...((!isCallNotification) && {
          notification: {
            title: notification.title,
            body: notification.body
          }
        }),
        data: {
          ...dataPayload,
          // ✅ For call notifications, move title/body to data
          ...(isCallNotification && {
            notificationTitle: notification?.data?.notificationTitle,
            notificationBody: notification?.data?.notificationBody
          })
        },
        android: {
          // ✅ Use high priority for call notifications
          priority: (notification.type === 'incoming_call' || 
                     notification?.data?.type === 'incoming_call_with_signal' ||
                     notification?.data?.type === 'incoming_call_offline') ? 'high' : 'normal',
          // ✅ FIXED: Only include notification config for non-call notifications
          ...(!isCallNotification && {
            notification: {
              sound: prefs.soundEnabled !== false ? 'default' : undefined,
              channelId: this.getChannelId(notification?.data?.type),
              // ✅ Only use valid FCM notification properties
              defaultVibrateTimings: prefs.vibrationEnabled !== false
            }
          }),
          // ✅ Collapse key for call notifications to replace previous ones
          ...((notification.type === 'incoming_call' || 
               notification?.data?.type === 'incoming_call_with_signal' ||
               notification?.data?.type === 'incoming_call_offline') && {
            collapseKey: 'incoming_call'
          })
        },
        apns: {
          payload: {
            aps: {
              sound: prefs.soundEnabled !== false ? 'default' : undefined,
              badge: 1,
              // ✅ Critical alert for iOS calls
              ...((notification.type === 'incoming_call' || 
                   notification?.data?.type === 'incoming_call_with_signal' ||
                   notification?.data?.type === 'incoming_call_offline') && {
                'content-available': 1,
                alert: {
                  title: notification.title,
                  body: notification.body
                },
                category: 'INCOMING_CALL'
              })
            }
          },
          headers: {
            // ✅ High priority for iOS
            'apns-priority': (notification.type === 'incoming_call' || 
                             notification?.data?.type === 'incoming_call_with_signal' ||
                             notification?.data?.type === 'incoming_call_offline') ? '10' : '5',
            'apns-push-type': 'voip'
          }
        }
      };

      // ✅ DEBUG: Log the message structure for call notifications
      if (isCallNotification) {
        console.log('📱 FCM Call Notification Payload:');
        console.log('- Device:', `${deviceName} (${deviceId})`);
        console.log('- Token:', fcmToken ? 'Present' : 'Missing');
        console.log('- Data keys:', Object.keys(message.data || {}));
        console.log('- Data types:', Object.keys(message.data || {}).map(key => 
          `${key}: ${typeof message.data[key]}`
        ));
        
        // Check for non-string values
        const nonStringValues = Object.keys(message.data || {}).filter(key => 
          typeof message.data[key] !== 'string'
        );
        if (nonStringValues.length > 0) {
          console.error('❌ Non-string values found in FCM data:', nonStringValues.map(key => 
            `${key}: ${typeof message.data[key]} (${message.data[key]})`
          ));
        }
      }

      // Send via FCM
      const response = await messaging.send(message);

      console.log(`✅ Notification sent to device ${deviceId} (${deviceName}) for user ${userId}:`, response);
      return { success: true, messageId: response, deviceId, deviceName };

    } catch (error) {
      console.error(`FCM send error for device ${tokenInfo.deviceId}:`, error);

      // Handle invalid token - deactivate the device
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        console.log(`🔄 Deactivating device with invalid FCM token: ${tokenInfo.deviceId}`);
        await deviceService.deactivateDevice(userId, tokenInfo.deviceId);
      }

      throw error;
    }
  }

  /**
   * Send notification to multiple users
   */
  async sendMulticast(userIds, notification) {
    const results = await Promise.allSettled(
      userIds.map(userId => this.sendNotification(userId, notification))
    );

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    console.log(`📊 Multicast: ${successCount}/${userIds.length} sent`);

    return results;
  }

  /**
   * Check if notification should be sent based on user preferences
   */
  shouldSendNotification(type, preferences) {
    switch (type) {
      case 'incoming_call':
      case 'incoming_call_with_signal':
      case 'incoming_call_offline':
      case 'missed_call':
      case 'call_ended':
        return preferences.calls !== false;
      case 'new_message':
        return preferences.messages !== false;
      default:
        return true;
    }
  }

  /**
   * Get Android notification channel ID
   */
  getChannelId(type) {
    switch (type) {
      case 'incoming_call':
      case 'incoming_call_with_signal':
      case 'incoming_call_offline':
      case 'missed_call':
      case 'call_ended':
        return 'calls';
      case 'new_message':
        return 'messages';
      default:
        return 'default';
    }
  }
}

module.exports = new FCMService();
