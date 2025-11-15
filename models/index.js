const sequelize = require('../config/database');
const User = require('./User');
const Chat = require('./Chat');
const Message = require('./Message');
const ChatParticipant = require('./ChatParticipant');
const Call = require('./Call');
const MessageReceipt = require('./MessageReceipt');
const GroupInvite = require('./GroupInvite');
const GroupChatKey = require('./GroupChatKey');

// User associations
User.hasMany(Message, { foreignKey: 'senderId', as: 'sentMessages' });
User.hasMany(Message, { foreignKey: 'receiverId', as: 'receivedMessages' });

// Message associations
Message.belongsTo(User, { foreignKey: 'senderId', as: 'sender' });
Message.belongsTo(User, { foreignKey: 'receiverId', as: 'receiver' });
Message.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });
Message.belongsTo(Message, { foreignKey: 'replyToId', as: 'replyTo' });
Message.hasMany(Message, { foreignKey: 'replyToId', as: 'replies' });

// Chat associations
Chat.hasMany(Message, { foreignKey: 'chatId', as: 'messages' });
Chat.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
Chat.belongsTo(User, { foreignKey: 'participant1Id', as: 'participant1' });
Chat.belongsTo(User, { foreignKey: 'participant2Id', as: 'participant2' });

// Chat-User many-to-many through ChatParticipant
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

// ChatParticipant associations
User.hasMany(ChatParticipant, { foreignKey: 'userId', as: 'participations' });
ChatParticipant.belongsTo(User, { foreignKey: 'userId', as: 'user' });

Chat.hasMany(ChatParticipant, { foreignKey: 'chatId', as: 'participantRecords' });
ChatParticipant.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

ChatParticipant.belongsTo(Message, { foreignKey: 'lastReadMessageId', as: 'lastReadMessage' });

// MessageReceipt associations
Message.hasMany(MessageReceipt, { foreignKey: 'messageId', as: 'receipts' });
MessageReceipt.belongsTo(Message, { foreignKey: 'messageId', as: 'message' });

User.hasMany(MessageReceipt, { foreignKey: 'userId', as: 'messageReceipts' });
MessageReceipt.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// GroupInvite associations
Chat.hasMany(GroupInvite, { foreignKey: 'chatId', as: 'invites' });
GroupInvite.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

User.hasMany(GroupInvite, { foreignKey: 'inviterId', as: 'sentInvites' });
User.hasMany(GroupInvite, { foreignKey: 'inviteeId', as: 'receivedInvites' });
GroupInvite.belongsTo(User, { foreignKey: 'inviterId', as: 'inviter' });
GroupInvite.belongsTo(User, { foreignKey: 'inviteeId', as: 'invitee' });

// Call associations
User.hasMany(Call, { foreignKey: 'callerId', as: 'initiatedCalls' });
User.hasMany(Call, { foreignKey: 'receiverId', as: 'receivedCalls' });
Call.belongsTo(User, { foreignKey: 'callerId', as: 'caller' });
Call.belongsTo(User, { foreignKey: 'receiverId', as: 'receiver' });
Call.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

// GroupChatKey associations
Chat.hasMany(GroupChatKey, { foreignKey: 'chatId', as: 'groupKeys' });
GroupChatKey.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

User.hasMany(GroupChatKey, { foreignKey: 'userId', as: 'groupChatKeys' });
GroupChatKey.belongsTo(User, { foreignKey: 'userId', as: 'user' });

module.exports = {
  sequelize,
  User,
  Chat,
  Message,
  ChatParticipant,
  Call,
  MessageReceipt,
  GroupInvite,
  GroupChatKey
};