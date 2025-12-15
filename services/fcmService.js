const { getMessaging } = require('../config/firebase');
const { User, Notification } = require('../models');

class FCMService {
  /**
   * Register or update FCM token for a user
   */
  async registerToken(userId, fcmToken) {
    try {
      await User.update(
        {
          fcmToken,
          fcmTokenUpdatedAt: new Date()
        },
        { where: { id: userId } }
      );
      console.log(`✅ FCM token registered for user ${userId}`);
      return { success: true };
    } catch (error) {
      console.error('FCM token registration error:', error);
      throw error;
    }
  }

  /**
   * Remove FCM token (on logout)
   */
  async removeToken(userId) {
    try {
      await User.update(
        { fcmToken: null, fcmTokenUpdatedAt: null },
        { where: { id: userId } }
      );
      console.log(`✅ FCM token removed for user ${userId}`);
      return { success: true };
    } catch (error) {
      console.error('FCM token removal error:', error);
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

      // Get user's FCM token
      const user = await User.findByPk(userId, {
        attributes: ['fcmToken', 'notificationPreferences']
      });

      if (!user || !user.fcmToken) {
        console.log(`⚠️  No FCM token for user ${userId}`);
        // Only update if notification has an id (database record)
        if (notification.id) {
          await Notification.update(
            {
              status: 'failed',
              error: 'No FCM token'
            },
            { where: { id: notification.id } }
          );
        }
        return { success: false, reason: 'no_token' };
      }

      // Check notification preferences
      const prefs = user.notificationPreferences || {};
      if (!this.shouldSendNotification(notification.type, prefs)) {
        console.log(`⚠️  Notification disabled by user preferences for user ${userId}`);
        // Only update if notification has an id (database record)
        if (notification.id) {
          await Notification.update(
            {
              status: 'failed',
              error: 'Disabled by user preferences'
            },
            { where: { id: notification.id } }
          );
        }
        return { success: false, reason: 'disabled_by_user' };
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
                                 notification.type === 'incoming_call_with_signal';

      const message = {
        token: user.fcmToken,
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
            notificationTitle: notification.title,
            notificationBody: notification.body
          })
        },
        android: {
          // ✅ Use high priority for call notifications
          priority: (notification.type === 'incoming_call' || notification.type === 'incoming_call_with_signal') ? 'high' : 'normal',
          // ✅ FIXED: Only include notification config for non-call notifications
          ...(!isCallNotification && {
            notification: {
              sound: prefs.soundEnabled !== false ? 'default' : undefined,
              channelId: this.getChannelId(notification.type),
              // ✅ Only use valid FCM notification properties
              defaultVibrateTimings: prefs.vibrationEnabled !== false
            }
          }),
          // ✅ Collapse key for call notifications to replace previous ones
          ...((notification.type === 'incoming_call' || notification.type === 'incoming_call_with_signal') && {
            collapseKey: 'incoming_call'
          })
        },
        apns: {
          payload: {
            aps: {
              sound: prefs.soundEnabled !== false ? 'default' : undefined,
              badge: 1,
              // ✅ Critical alert for iOS calls
              ...((notification.type === 'incoming_call' || notification.type === 'incoming_call_with_signal') && {
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
            'apns-priority': (notification.type === 'incoming_call' || notification.type === 'incoming_call_with_signal') ? '10' : '5',
            'apns-push-type': 'voip'
          }
        }
      };

      // ✅ DEBUG: Log the message structure for call notifications
      if (isCallNotification) {
        console.log('📱 FCM Call Notification Payload:');
        console.log('- Token:', user.fcmToken ? 'Present' : 'Missing');
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

      // Log success - only update if notification has an id (database record)
      if (notification.id) {
        await Notification.update(
          {
            status: 'sent',
            fcmMessageId: response,
            sentAt: new Date()
          },
          { where: { id: notification.id } }
        );
      }

      console.log(`✅ Notification sent to user ${userId}:`, response);
      return { success: true, messageId: response };

    } catch (error) {
      console.error('FCM send error:', error);

      // Handle invalid token
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        console.log(`🔄 Removing invalid FCM token for user ${userId}`);
        await this.removeToken(userId);
      }

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
