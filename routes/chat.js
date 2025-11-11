const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createChat,
  getUserChats,
  getChatMessages,
  searchUsers
} = require('../controllers/chatController');

router.post('/create', authenticateToken, createChat);
router.get('/my-chats', authenticateToken, getUserChats);
router.get('/:chatId/messages', authenticateToken, getChatMessages);
router.get('/search/users', authenticateToken, searchUsers);

module.exports = router;