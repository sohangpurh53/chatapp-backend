const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const fcmService = require('../services/fcmService');
const deviceService = require('../services/deviceService');
const { User, Notification } = require('../models');

/**
 * Register FCM token with device information
 * POST /api/notifications/register-token
 */
router.post('/register-token', authenticateToken, async (req, res) => {
  try {
    const { 
      fcmToken, 
      deviceId, 
      deviceName, 
      deviceType, 
      platform, 
      appVersion,
      notificationPreferences 
    } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ error: 'FCM token is required' });
    }

    // Get client IP and user agent
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    const deviceInfo = {
      deviceId: deviceId || `fcm_${fcmToken.substring(0, 16)}`, // Fallback device ID
      deviceName: deviceName || 'Unknown Device',
      deviceType: deviceType || 'android',
      platform,
      appVersion,
      fcmToken,
      ipAddress,
      userAgent,
      notificationPreferences
    };

    await fcmService.registerToken(req.user.id, fcmToken, deviceInfo);

    res.json({
      success: true,
      message: 'FCM token and device registered successfully'
    });
  } catch (error) {
    console.error('Register token error:', error);
    res.status(500).json({ error: 'Failed to register token' });
  }
});

/**
 * Deactivate device (on logout)
 * POST /api/notifications/remove-token
 */
router.post('/remove-token', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.body;

    await fcmService.removeToken(req.user.id, deviceId);

    res.json({
      success: true,
      message: 'Device deactivated successfully'
    });
  } catch (error) {
    console.error('Remove token error:', error);
    res.status(500).json({ error: 'Failed to deactivate device' });
  }
});

/**
 * Get user devices
 * GET /api/notifications/devices
 */
router.get('/devices', authenticateToken, async (req, res) => {
  try {
    const { activeOnly = 'false' } = req.query;

    let devices;
    if (activeOnly === 'true') {
      devices = await deviceService.getActiveDevices(req.user.id);
    } else {
      devices = await deviceService.getAllDevices(req.user.id);
    }

    const stats = await deviceService.getDeviceStats(req.user.id);

    res.json({
      success: true,
      devices,
      stats
    });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

/**
 * Logout from all devices
 * POST /api/notifications/logout-all-devices
 */
router.post('/logout-all-devices', authenticateToken, async (req, res) => {
  try {
    const { exceptCurrentDevice = false } = req.body;
    const currentDeviceId = req.body.currentDeviceId;

    const result = await deviceService.logoutAllDevices(
      req.user.id, 
      exceptCurrentDevice ? currentDeviceId : null
    );

    res.json({
      success: true,
      message: `Logged out from ${result.loggedOutCount} device(s)`,
      loggedOutCount: result.loggedOutCount
    });
  } catch (error) {
    console.error('Logout all devices error:', error);
    res.status(500).json({ error: 'Failed to logout from all devices' });
  }
});

/**
 * Update device activity (heartbeat)
 * POST /api/notifications/device-heartbeat
 */
router.post('/device-heartbeat', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    await deviceService.updateDeviceActivity(req.user.id, deviceId);

    res.json({
      success: true,
      message: 'Device activity updated'
    });
  } catch (error) {
    console.error('Device heartbeat error:', error);
    res.status(500).json({ error: 'Failed to update device activity' });
  }
});

/**
 * Update notification preferences
 * PUT /api/notifications/preferences
 */
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const { calls, messages, groupMessages, soundEnabled, vibrationEnabled } = req.body;

    await User.update(
      {
        notificationPreferences: {
          calls: calls !== undefined ? calls : true,
          messages: messages !== undefined ? messages : true,
          groupMessages: groupMessages !== undefined ? groupMessages : true,
          soundEnabled: soundEnabled !== undefined ? soundEnabled : true,
          vibrationEnabled: vibrationEnabled !== undefined ? vibrationEnabled : true
        }
      },
      { where: { id: req.user.id } }
    );

    res.json({
      success: true,
      message: 'Notification preferences updated'
    });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * Get notification preferences
 * GET /api/notifications/preferences
 */
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['notificationPreferences']
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      preferences: user.notificationPreferences || {
        calls: true,
        messages: true,
        groupMessages: true,
        soundEnabled: true,
        vibrationEnabled: true
      }
    });
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

/**
 * Get notification history
 * GET /api/notifications/history
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const notifications = await Notification.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    const total = await Notification.count({
      where: { userId: req.user.id }
    });

    res.json({
      success: true,
      notifications,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: (parseInt(offset) + notifications.length) < total
      }
    });
  } catch (error) {
    console.error('Get notification history error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

/**
 * Mark notification as read
 * PUT /api/notifications/:id/read
 */
router.put('/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findOne({
      where: { 
        id: id,
        userId: req.user.id 
      }
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // Add isRead field to the notification
    await notification.update({ 
      data: {
        ...notification.data,
        isRead: true,
        readAt: new Date().toISOString()
      }
    });

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    console.error('Mark notification as read error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

/**
 * Mark all notifications as read
 * PUT /api/notifications/read-all
 */
router.put('/read-all', authenticateToken, async (req, res) => {
  try {
    await Notification.update(
      { 
        data: Notification.sequelize.fn(
          'JSON_SET',
          Notification.sequelize.col('data'),
          '$.isRead',
          true,
          '$.readAt',
          new Date().toISOString()
        )
      },
      { 
        where: { 
          userId: req.user.id,
          // Only update unread notifications
          data: {
            [Notification.sequelize.Op.not]: {
              [Notification.sequelize.Op.like]: '%"isRead":true%'
            }
          }
        }
      }
    );

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Mark all notifications as read error:', error);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

/**
 * Delete multiple notifications
 * DELETE /api/notifications/bulk
 */
router.delete('/bulk', authenticateToken, async (req, res) => {
  try {
    const { notificationIds } = req.body;

    if (!notificationIds || !Array.isArray(notificationIds)) {
      return res.status(400).json({ error: 'Notification IDs array is required' });
    }

    const result = await Notification.destroy({
      where: { 
        id: notificationIds,
        userId: req.user.id 
      }
    });

    res.json({
      success: true,
      message: `${result} notification(s) deleted successfully`,
      deletedCount: result
    });
  } catch (error) {
    console.error('Bulk delete notifications error:', error);
    res.status(500).json({ error: 'Failed to delete notifications' });
  }
});

/**
 * Clear all notifications
 * DELETE /api/notifications/clear-all
 */
router.delete('/clear-all', authenticateToken, async (req, res) => {
  try {
    const result = await Notification.destroy({
      where: { userId: req.user.id }
    });

    res.json({
      success: true,
      message: `All ${result} notification(s) cleared successfully`,
      deletedCount: result
    });
  } catch (error) {
    console.error('Clear all notifications error:', error);
    res.status(500).json({ error: 'Failed to clear all notifications' });
  }
});

/**
 * Delete notification
 * DELETE /api/notifications/:id
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await Notification.destroy({
      where: { 
        id: id,
        userId: req.user.id 
      }
    });

    if (result === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

module.exports = router;
