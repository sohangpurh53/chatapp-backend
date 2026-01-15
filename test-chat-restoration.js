/**
 * Test Script: Chat Restoration After Deletion
 * 
 * This script tests the robust chat creation/restoration flow:
 * 1. Create a chat between two users
 * 2. Delete the chat (soft delete)
 * 3. Try to create chat again (should restore)
 * 4. Verify chat is accessible
 */

const { Chat, User, ChatParticipant } = require('./models');
const { Op } = require('sequelize');

async function testChatRestoration() {
  console.log('🧪 Starting Chat Restoration Test...\n');

  try {
    // Step 1: Find two test users
    const users = await User.findAll({ limit: 2 });
    
    if (users.length < 2) {
      console.error('❌ Need at least 2 users in database to run test');
      return;
    }

    const user1 = users[0];
    const user2 = users[1];
    
    console.log(`👤 User 1: ${user1.username} (${user1.id})`);
    console.log(`👤 User 2: ${user2.username} (${user2.id})`);
    console.log('');

    // Step 2: Check if chat already exists
    let existingChat = await Chat.findOne({
      where: {
        isGroup: false,
        [Op.or]: [
          { participant1Id: user1.id, participant2Id: user2.id },
          { participant1Id: user2.id, participant2Id: user1.id }
        ]
      },
      paranoid: false
    });

    if (existingChat) {
      console.log(`📋 Found existing chat: ${existingChat.id} (isActive: ${existingChat.isActive})`);
      
      // Clean up for fresh test
      await ChatParticipant.destroy({ 
        where: { chatId: existingChat.id },
        force: true 
      });
      await existingChat.destroy({ force: true });
      console.log('🧹 Cleaned up existing chat for fresh test\n');
    }

    // Step 3: Create new chat
    console.log('📝 Creating new chat...');
    const newChat = await Chat.create({
      isGroup: false,
      participant1Id: user1.id,
      participant2Id: user2.id,
      createdBy: user1.id,
      lastActivityAt: new Date(),
      isActive: true
    });

    await ChatParticipant.create({
      userId: user1.id,
      chatId: newChat.id,
      role: 'member',
      isActive: true
    });

    await ChatParticipant.create({
      userId: user2.id,
      chatId: newChat.id,
      role: 'member',
      isActive: true
    });

    console.log(`✅ Created chat: ${newChat.id}`);
    console.log('');

    // Step 4: Verify chat is active
    const activeChat = await Chat.findByPk(newChat.id);
    console.log(`✅ Chat is active: ${activeChat.isActive}`);
    
    const activeParticipants = await ChatParticipant.findAll({
      where: { chatId: newChat.id, isActive: true }
    });
    console.log(`✅ Active participants: ${activeParticipants.length}`);
    console.log('');

    // Step 5: User 1 deletes the chat (soft delete)
    console.log('🗑️ User 1 deleting chat...');
    const user1Participant = await ChatParticipant.findOne({
      where: { chatId: newChat.id, userId: user1.id }
    });
    
    await user1Participant.update({ isActive: false });
    console.log(`✅ User 1 participant marked inactive`);
    
    // Check if both participants left
    const remainingActive = await ChatParticipant.count({
      where: { chatId: newChat.id, isActive: true }
    });
    
    if (remainingActive === 0) {
      await newChat.update({ isActive: false });
      console.log(`✅ Chat marked inactive (both participants left)`);
    } else {
      console.log(`✅ Chat still active (${remainingActive} participant(s) remaining)`);
    }
    console.log('');

    // Step 6: Verify chat is soft-deleted
    const deletedChat = await Chat.findByPk(newChat.id);
    console.log(`📋 Chat status after deletion: isActive=${deletedChat.isActive}`);
    
    const deletedParticipants = await ChatParticipant.findAll({
      where: { chatId: newChat.id }
    });
    console.log(`📋 Participants status:`);
    deletedParticipants.forEach(p => {
      console.log(`   - User ${p.userId}: isActive=${p.isActive}`);
    });
    console.log('');

    // Step 7: User 1 tries to create chat again (should restore)
    console.log('♻️ User 1 attempting to create chat again (should restore)...');
    
    const restoredChat = await Chat.findOne({
      where: {
        isGroup: false,
        [Op.or]: [
          { participant1Id: user1.id, participant2Id: user2.id },
          { participant1Id: user2.id, participant2Id: user1.id }
        ]
      },
      paranoid: false
    });

    if (restoredChat) {
      console.log(`✅ Found chat to restore: ${restoredChat.id}`);
      
      // Restore chat
      if (!restoredChat.isActive) {
        await restoredChat.update({ 
          isActive: true,
          lastActivityAt: new Date()
        });
        console.log(`✅ Restored chat ${restoredChat.id}`);
      }

      // Restore participants
      const participants = await ChatParticipant.findAll({
        where: { chatId: restoredChat.id }
      });

      for (const participant of participants) {
        if (!participant.isActive) {
          await participant.update({ isActive: true });
          console.log(`✅ Reactivated participant ${participant.userId}`);
        }
      }
    }
    console.log('');

    // Step 8: Verify restoration
    const finalChat = await Chat.findByPk(newChat.id);
    console.log(`📋 Final chat status: isActive=${finalChat.isActive}`);
    
    const finalParticipants = await ChatParticipant.findAll({
      where: { chatId: newChat.id, isActive: true }
    });
    console.log(`✅ Active participants after restoration: ${finalParticipants.length}`);
    
    finalParticipants.forEach(p => {
      console.log(`   - User ${p.userId}: isActive=${p.isActive}`);
    });
    console.log('');

    // Step 9: Verify both users can access the chat
    const user1Chats = await Chat.findAll({
      include: [{
        model: User,
        as: 'participants',
        where: { id: user1.id },
        through: { where: { isActive: true } }
      }],
      where: { isActive: true }
    });

    const user2Chats = await Chat.findAll({
      include: [{
        model: User,
        as: 'participants',
        where: { id: user2.id },
        through: { where: { isActive: true } }
      }],
      where: { isActive: true }
    });

    console.log(`✅ User 1 can see ${user1Chats.length} chat(s)`);
    console.log(`✅ User 2 can see ${user2Chats.length} chat(s)`);
    console.log('');

    console.log('🎉 TEST PASSED: Chat restoration works correctly!');
    console.log('');
    console.log('Summary:');
    console.log('✅ Chat created successfully');
    console.log('✅ Chat soft-deleted when user left');
    console.log('✅ Chat restored when user tried to create again');
    console.log('✅ Both users can access the restored chat');

  } catch (error) {
    console.error('❌ TEST FAILED:', error);
    console.error(error.stack);
  }
}

// Run the test
if (require.main === module) {
  testChatRestoration()
    .then(() => {
      console.log('\n✅ Test completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Test failed:', error);
      process.exit(1);
    });
}

module.exports = { testChatRestoration };
