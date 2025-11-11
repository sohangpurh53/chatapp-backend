const sequelize = require('../config/database');
const User = require('./User');
const Chat = require('./Chat');
const Message = require('./Message');
const ChatParticipant = require('./ChatParticipant');
const Call = require('./Call');

// Define associations
User.hasMany(Message, { foreignKey: 'senderId', as: 'sentMessages' });
Message.belongsTo(User, { foreignKey: 'senderId', as: 'sender' });

Chat.hasMany(Message, { foreignKey: 'chatId', as: 'messages' });
Message.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

User.belongsToMany(Chat, { 
  through: ChatParticipant, 
  foreignKey: 'userId', 
  otherKey: 'chatId',
  as: 'chats'
});

Chat.belongsToMany(User, { 
  through: ChatParticipant, 
  foreignKey: 'chatId', 
  otherKey: 'userId',
  as: 'participants'
});

User.hasMany(ChatParticipant, { foreignKey: 'userId' });
ChatParticipant.belongsTo(User, { foreignKey: 'userId', as: 'user' });

Chat.hasMany(ChatParticipant, { foreignKey: 'chatId' });
ChatParticipant.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

Chat.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });

// Call associations
User.hasMany(Call, { foreignKey: 'callerId', as: 'initiatedCalls' });
User.hasMany(Call, { foreignKey: 'receiverId', as: 'receivedCalls' });
Call.belongsTo(User, { foreignKey: 'callerId', as: 'caller' });
Call.belongsTo(User, { foreignKey: 'receiverId', as: 'receiver' });
Call.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

module.exports = {
  sequelize,
  User,
  Chat,
  Message,
  ChatParticipant,
  Call
};