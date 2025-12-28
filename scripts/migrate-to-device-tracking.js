const { sequelize, User, UserDevice } = require('../models');

async function migrateToDeviceTracking() {
  try {
    console.log('🚀 Starting migration to device tracking system...');

    // Create UserDevice table
    console.log('📋 Creating UserDevice table...');
    await UserDevice.sync({ force: false });
    console.log('✅ UserDevice table created/verified');

    // Migrate existing FCM tokens to device records
    console.log('🔄 Migrating existing FCM tokens...');
    
    const usersWithTokens = await User.findAll({
      where: {
        fcmToken: {
          [require('sequelize').Op.ne]: null
        }
      },
      attributes: ['id', 'username', 'fcmToken', 'fcmTokenUpdatedAt']
    });

    console.log(`Found ${usersWithTokens.length} users with FCM tokens to migrate`);

    for (const user of usersWithTokens) {
      try {
        // Create a device record for existing FCM token
        const deviceId = `migrated_${user.fcmToken.substring(0, 16)}`;
        
        await UserDevice.create({
          userId: user.id,
          deviceId: deviceId,
          deviceName: 'Migrated Device',
          deviceType: 'android', // Default assumption
          platform: 'Unknown',
          fcmToken: user.fcmToken,
          fcmTokenUpdatedAt: user.fcmTokenUpdatedAt,
          isActive: true,
          lastLoginAt: user.fcmTokenUpdatedAt || new Date(),
          lastSeenAt: new Date(),
          notificationPreferences: {
            calls: true,
            messages: true,
            groupMessages: true,
            soundEnabled: true,
            vibrationEnabled: true
          }
        });

        console.log(`✅ Migrated FCM token for user ${user.username} (${user.id})`);
      } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
          console.log(`⚠️  Device already exists for user ${user.username}, skipping...`);
        } else {
          console.error(`❌ Error migrating user ${user.username}:`, error.message);
        }
      }
    }

    // Verify migration
    console.log('\n📊 Migration verification:');
    const deviceCount = await UserDevice.count();
    const activeDeviceCount = await UserDevice.count({ where: { isActive: true } });
    const devicesWithTokens = await UserDevice.count({
      where: {
        fcmToken: {
          [require('sequelize').Op.ne]: null
        }
      }
    });

    console.log(`- Total devices: ${deviceCount}`);
    console.log(`- Active devices: ${activeDeviceCount}`);
    console.log(`- Devices with FCM tokens: ${devicesWithTokens}`);

    // Show sample device data
    console.log('\n📱 Sample device records:');
    const sampleDevices = await UserDevice.findAll({
      limit: 5,
      include: [{
        model: User,
        as: 'user',
        attributes: ['username']
      }]
    });

    sampleDevices.forEach(device => {
      console.log(`- ${device.user.username}: ${device.deviceName} (${device.deviceType}) - Active: ${device.isActive}`);
    });

    console.log('\n✅ Migration completed successfully!');
    console.log('\n📝 Next steps:');
    console.log('1. Update your mobile app to send device information when registering FCM tokens');
    console.log('2. Test the new device tracking endpoints');
    console.log('3. Consider removing the old fcmToken field from User model after testing');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

// Run migration
if (require.main === module) {
  migrateToDeviceTracking()
    .then(() => {
      console.log('🎉 Migration script completed');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = migrateToDeviceTracking;