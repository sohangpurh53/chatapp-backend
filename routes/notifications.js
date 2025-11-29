const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const fcmService = require('../services/fcmService');
const { User, Notification } = require('../models');

/**
 * Register FCM token
 * POST /api/notifications/register-token
 */
router.post('/register-token', authenticateToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({ error: 'FCM token is required' });
    }

    await fcmService.registerToken(req.user.id, fcmToken);

    res.json({
      success: true,
      message: 'FCM token registered successfully'
    });
  } catch (error) {
    console.error('Register token error:', error);
    res.status(500).json({ error: 'Failed to register token' });
  }
});

/**
 * Remove FCM token (on logout)
 * POST /api/notifications/remove-token
 */
router.post('/remove-token', authenticateToken, async (req, res) => {
  try {
    await fcmService.removeToken(req.user.id);

    res.json({
      success: true,
      message: 'FCM token removed successfully'
    });
  } catch (error) {
    console.error('Remove token error:', error);
    res.status(500).json({ error: 'Failed to remove token' });
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

module.exports = router;
