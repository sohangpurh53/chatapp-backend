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

      // Convert notification.data to strings
      if (notification.data) {
        Object.keys(notification.data).forEach(key => {
          const value = notification.data[key];
          if (value !== null && value !== undefined) {
            dataPayload[key] = typeof value === 'string' ? value : JSON.stringify(value);
          }
        });
      }

      // Prepare FCM message
      const message = {
        token: user.fcmToken,
        notification: {
          title: notification.title,
          body: notification.body
        },
        data: dataPayload,
        android: {
          priority: notification.priority || 'high',
          notification: {
            sound: prefs.soundEnabled !== false ? 'default' : undefined,
            channelId: this.getChannelId(notification.type),
            priority: 'high',
            defaultVibrateTimings: prefs.vibrationEnabled !== false
          }
        },
        apns: {
          payload: {
            aps: {
              sound: prefs.soundEnabled !== false ? 'default' : undefined,
              badge: 1
            }
          }
        }
      };

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
      case 'missed_call':
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
      case 'missed_call':
        return 'calls';
      case 'new_message':
        return 'messages';
      default:
        return 'default';
    }
  }
}

module.exports = new FCMService();
