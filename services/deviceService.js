const { UserDevice, User } = require('../models');
const { Op } = require('sequelize');

class DeviceService {
  /**
   * Register or update a device for a user
   */
  async registerDevice(userId, deviceInfo) {
    try {
      const {
        deviceId,
        deviceName,
        deviceType = 'android',
        platform,
        appVersion,
        fcmToken,
        ipAddress,
        userAgent,
        notificationPreferences
      } = deviceInfo;

      if (!deviceId) {
        throw new Error('Device ID is required');
      }

      // Check if device already exists
      let device = await UserDevice.findOne({
        where: {
          userId,
          deviceId
        }
      });

      const deviceData = {
        userId,
        deviceId,
        deviceName,
        deviceType,
        platform,
        appVersion,
        fcmToken,
        fcmTokenUpdatedAt: fcmToken ? new Date() : null,
        isActive: true,
        lastLoginAt: new Date(),
        lastSeenAt: new Date(),
        ipAddress,
        userAgent,
        notificationPreferences: notificationPreferences || {
          calls: true,
          messages: true,
          groupMessages: true,
          soundEnabled: true,
          vibrationEnabled: true
        }
      };

      if (device) {
        // Update existing device
        await device.update(deviceData);
        console.log(`✅ Device updated for user ${userId}: ${deviceId}`);
      } else {
        // Create new device
        device = await UserDevice.create(deviceData);
        console.log(`✅ New device registered for user ${userId}: ${deviceId}`);
      }

      return { success: true, device };
    } catch (error) {
      console.error('Device registration error:', error);
      throw error;
    }
  }

  /**
   * Update FCM token for a specific device
   */
  async updateFCMToken(userId, deviceId, fcmToken) {
    try {
      const device = await UserDevice.findOne({
        where: {
          userId,
          deviceId
        }
      });

      if (!device) {
        throw new Error('Device not found');
      }

      await device.update({
        fcmToken,
        fcmTokenUpdatedAt: new Date(),
        lastSeenAt: new Date()
      });

      console.log(`✅ FCM token updated for device ${deviceId} of user ${userId}`);
      return { success: true };
    } catch (error) {
      console.error('FCM token update error:', error);
      throw error;
    }
  }

  /**
   * Deactivate device (on logout) - don't remove, just mark as inactive
   */
  async deactivateDevice(userId, deviceId) {
    try {
      const device = await UserDevice.findOne({
        where: {
          userId,
          deviceId
        }
      });

      if (!device) {
        console.log(`⚠️  Device not found for deactivation: ${deviceId}`);
        return { success: false, reason: 'device_not_found' };
      }

      await device.update({
        isActive: false,
        lastLogoutAt: new Date(),
        lastSeenAt: new Date()
      });

      console.log(`✅ Device deactivated for user ${userId}: ${deviceId}`);
      return { success: true };
    } catch (error) {
      console.error('Device deactivation error:', error);
      throw error;
    }
  }

  /**
   * Get all active devices for a user
   */
  async getActiveDevices(userId) {
    try {
      const devices = await UserDevice.findAll({
        where: {
          userId,
          isActive: true
        },
        order: [['lastSeenAt', 'DESC']]
      });

      return devices;
    } catch (error) {
      console.error('Error fetching active devices:', error);
      throw error;
    }
  }

  /**
   * Get all devices for a user (active and inactive)
   */
  async getAllDevices(userId) {
    try {
      const devices = await UserDevice.findAll({
        where: {
          userId
        },
        order: [['lastSeenAt', 'DESC']]
      });

      return devices;
    } catch (error) {
      console.error('Error fetching all devices:', error);
      throw error;
    }
  }

  /**
   * Get FCM tokens for all active devices of a user
   */
  async getActiveFCMTokens(userId) {
    try {
      const devices = await UserDevice.findAll({
        where: {
          userId,
          isActive: true,
          fcmToken: {
            [Op.ne]: null
          }
        },
        attributes: ['fcmToken', 'deviceId', 'deviceName', 'notificationPreferences']
      });

      return devices.map(device => ({
        fcmToken: device.fcmToken,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        notificationPreferences: device.notificationPreferences
      }));
    } catch (error) {
      console.error('Error fetching FCM tokens:', error);
      throw error;
    }
  }

  /**
   * Update device activity (heartbeat)
   */
  async updateDeviceActivity(userId, deviceId) {
    try {
      const device = await UserDevice.findOne({
        where: {
          userId,
          deviceId
        }
      });

      if (device) {
        await device.update({
          lastSeenAt: new Date()
        });
      }

      return { success: true };
    } catch (error) {
      console.error('Error updating device activity:', error);
      throw error;
    }
  }

  /**
   * Remove old inactive devices (cleanup)
   */
  async cleanupOldDevices(daysOld = 90) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const deletedCount = await UserDevice.destroy({
        where: {
          isActive: false,
          lastSeenAt: {
            [Op.lt]: cutoffDate
          }
        }
      });

      console.log(`🧹 Cleaned up ${deletedCount} old inactive devices`);
      return { success: true, deletedCount };
    } catch (error) {
      console.error('Error cleaning up old devices:', error);
      throw error;
    }
  }

  /**
   * Force logout from all devices (security feature)
   */
  async logoutAllDevices(userId, exceptDeviceId = null) {
    try {
      const whereClause = {
        userId,
        isActive: true
      };

      if (exceptDeviceId) {
        whereClause.deviceId = {
          [Op.ne]: exceptDeviceId
        };
      }

      const updatedCount = await UserDevice.update(
        {
          isActive: false,
          lastLogoutAt: new Date()
        },
        {
          where: whereClause
        }
      );

      console.log(`✅ Logged out from ${updatedCount[0]} devices for user ${userId}`);
      return { success: true, loggedOutCount: updatedCount[0] };
    } catch (error) {
      console.error('Error logging out all devices:', error);
      throw error;
    }
  }

  /**
   * Get device statistics for a user
   */
  async getDeviceStats(userId) {
    try {
      const totalDevices = await UserDevice.count({
        where: { userId }
      });

      const activeDevices = await UserDevice.count({
        where: { userId, isActive: true }
      });

      const devicesWithFCM = await UserDevice.count({
        where: {
          userId,
          isActive: true,
          fcmToken: {
            [Op.ne]: null
          }
        }
      });

      return {
        totalDevices,
        activeDevices,
        inactiveDevices: totalDevices - activeDevices,
        devicesWithFCM
      };
    } catch (error) {
      console.error('Error fetching device stats:', error);
      throw error;
    }
  }
}

module.exports = new DeviceService();