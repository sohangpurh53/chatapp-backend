const express = require('express');
const router = express.Router();
const callController = require('../controllers/callController');
const { Call } = require('../models');
const { authenticateToken } = require('../middleware/auth');

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Get call history
router.get('/history', callController.getCallHistory);

// Get active calls
router.get('/active', callController.getActiveCalls);

// Get call statistics
router.get('/stats', callController.getCallStats);

// Delete call from history
router.delete('/:callId', callController.deleteCall);

// Status of one call, for an app woken by a push to check that it is still ringing
router.get('/:callId/status', async (req, res) => {
  try {
    const userId = req.user.id;
    const { callId } = req.params;
    const redisService = require('../config/redis');

    const live = await redisService.getActiveCall(callId);
    if (live) {
      if (live.callerId !== userId && live.receiverId !== userId) {
        return res.status(404).json({ error: 'Call not found' });
      }
      return res.json({ callId, status: live.status });
    }

    const call = await Call.findByPk(callId, { attributes: ['id', 'callerId', 'receiverId', 'status'] });
    if (!call || (call.callerId !== userId && call.receiverId !== userId)) {
      return res.status(404).json({ error: 'Call not found' });
    }
    // The row says 'initiated'/'answered' until the call ends; without the live
    // Redis entry the call is over either way
    const status = ['initiated', 'answered'].includes(call.status) ? 'ended' : call.status;
    res.json({ callId, status });
  } catch (error) {
    console.error('Error getting call status:', error);
    res.status(500).json({ error: 'Failed to get call status' });
  }
});

// Clears call state left behind by a previous session (the app calls this on startup).
// A call still ringing for this user is kept: the app may have been started by the
// push for that very call.
router.post('/clear-status', async (req, res) => {
  try {
    const userId = req.user.id;
    const redisService = require('../config/redis');

    const callId = (await redisService.getUserCallStatus(userId))?.callId;
    if (!callId) {
      return res.json({ success: true, message: 'No call status found' });
    }

    const callData = await redisService.getActiveCall(callId);
    if (callData?.status === 'ringing' && callData.receiverId === userId) {
      return res.json({ success: true, message: 'Call still ringing, kept' });
    }

    console.log(`🧹 Clearing call status ${callId} for user ${userId}`);
    await redisService.deleteUserCallStatus(userId);
    if (callData) {
      await redisService.deleteActiveCall(callId);
      const otherUserId = callData.callerId === userId ? callData.receiverId : callData.callerId;
      await redisService.deleteUserCallStatus(otherUserId);
    }

    res.json({
      success: true,
      message: 'Call status cleared',
      clearedCallId: callId
    });
  } catch (error) {
    console.error('Error clearing call status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clear call status',
      error: error.message
    });
  }
});

module.exports = router;