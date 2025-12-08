const express = require('express');
const router = express.Router();
const callController = require('../controllers/callController');
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

// ✅ NEW: Clear stuck call status (for debugging)
router.post('/clear-status', async (req, res) => {
  try {
    const userId = req.user.id;
    const redisService = require('../config/redis');
    
    console.log(`🧹 Clearing call status for user ${userId}`);
    
    // Get current call status
    const callId = await redisService.getUserCallStatus(userId);
    
    if (callId) {
      console.log(`Found call status: ${callId}, removing...`);
      await redisService.deleteUserCallStatus(userId);
      
      // Also try to clean up the call itself if it exists
      const callData = await redisService.getActiveCall(callId);
      if (callData) {
        console.log(`Found active call data, cleaning up...`);
        await redisService.deleteActiveCall(callId);
        
        // Clean up other participant too
        const otherUserId = callData.callerId === userId ? callData.receiverId : callData.callerId;
        await redisService.deleteUserCallStatus(otherUserId);
      }
      
      res.json({ 
        success: true, 
        message: 'Call status cleared',
        clearedCallId: callId
      });
    } else {
      res.json({ 
        success: true, 
        message: 'No call status found'
      });
    }
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