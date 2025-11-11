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

module.exports = router;