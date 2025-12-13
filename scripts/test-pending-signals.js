const redisService = require('../config/redis');

async function run() {
  const targetUserId = 'test-user-1';
  const callId = 'call-1234';
  const offerSignal = { type: 'offer', sdp: 'dummy-sdp' };

  console.log('Pushing pending signal...');
  await redisService.pushPendingSignal(targetUserId, callId, { type: 'offer', payload: offerSignal });

  console.log('Retrieving pending signals...');
  const pending = await redisService.getPendingSignalsForUser(targetUserId);
  console.log('Pending signals for user:', JSON.stringify(pending, null, 2));

  console.log('Deleting pending signals...');
  await redisService.deletePendingSignals(targetUserId, callId);

  const pendingAfter = await redisService.getPendingSignalsForUser(targetUserId);
  console.log('Pending after delete:', JSON.stringify(pendingAfter, null, 2));

  await redisService.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
