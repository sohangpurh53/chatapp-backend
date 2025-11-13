const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createChat,
  getUserChats,
  getChatMessages,
  searchUsers,
  inviteToGroup,
  respondToGroupInvite,
  updateGroupInfo,
  markMessageAsRead
} = require('../controllers/chatController');

router.post('/create', authenticateToken, createChat);
router.get('/my-chats', authenticateToken, getUserChats);
router.get('/:chatId/messages', authenticateToken, getChatMessages);
router.get('/search/users', authenticateToken, searchUsers);

// Group management routes
router.post('/:chatId/invite', authenticateToken, inviteToGroup);
router.post('/invites/:inviteId/respond', authenticateToken, respondToGroupInvite);
router.put('/:chatId/info', authenticateToken, updateGroupInfo);

// Message management routes
router.post('/messages/:messageId/read', authenticateToken, markMessageAsRead);

module.exports = router;