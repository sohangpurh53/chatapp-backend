// End-to-end call tests: real Socket.IO server, real SocketHandlers, real socket.io-client
// "phones" talking over the wire. Only Redis, the database and the push service are
// in-memory (see helpers/callHarness.js). Timers run for real but in milliseconds.
const { describe, test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

// The call handlers log every step; under `node --test` that output in the child's
// stdout trips the runner ("Unable to deserialize cloned data")
console.log = () => {};

const { installCallStore, startServer, sleep, until, redisService } = require('./helpers/callHarness');

redisService.client.disconnect();
after(() => redisService.client.disconnect());

// Short enough to keep the suite fast, long enough to be well clear of scheduling noise
const FAST = { ringTimeoutMs: 600, ringAckTimeoutMs: 100, reconnectGraceMs: { answered: 300, ringing: 150 } };

describe('calls over real sockets', () => {
  let env;
  let server;
  let store;

  beforeEach(async () => {
    env = installCallStore();
    store = env.store;
    server = await startServer({ timings: FAST });
  });

  afterEach(async () => {
    await server.close();
    env.restore();
  });

  /** alice (a connected caller) starts a video call to `receiverId`. */
  const startCall = async (alice, receiverId = 'bob') => {
    const seen = alice.all('call_initiated').length;
    alice.emit('initiate_call', { receiverId, callType: 'video', chatId: 'chat-1' });
    const initiated = await until(() => alice.all('call_initiated')[seen], { label: 'call_initiated' });
    return initiated.callId;
  };

  const offer = (sdp = 'v=0 offer') => ({ type: 'offer', sdp });
  const candidate = (n = 1) => ({ type: 'ice-candidate', candidate: { candidate: `candidate:${n}` } });
  const signal = (alice, callId, payload, to = 'bob') => alice.emit('call_signal', { callId, targetUserId: to, signal: payload });
  const pushTypes = () => store.pushes.map(p => p.notification.data?.type || p.notification.type);

  describe('ringing', () => {
    test('a running app is rung over its socket, confirms it, and gets no push', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');

      const callId = await startCall(alice);

      const incoming = await bob.waitFor('incoming_call');
      assert.equal(incoming.callId, callId);
      assert.equal(incoming.caller.username, 'alice');
      assert.equal(incoming.callType, 'video');
      assert.equal(incoming.receiverId, 'bob');
      assert.deepEqual(await alice.waitFor('call_status_update'), { callId, status: 'ringing' });
      assert.equal((await alice.waitFor('call_initiated')).receiverOnline, true);
      await sleep(250); // well past the acknowledgement wait
      assert.equal(store.pushes.length, 0);
      assert.equal(store.calls.get(callId).status, 'ringing');
    });

    test('the caller hears call_initiated only after the receiver was rung', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');

      await startCall(alice);
      await bob.waitFor('incoming_call');

      // alice sends the offer as soon as she gets call_initiated, so the ring has to be
      // on the wire before it
      assert.ok(bob.events.findIndex(e => e.event === 'incoming_call') >= 0);
      signal(alice, store.calls.keys().next().value, offer());
      await bob.waitFor('call_signal');
      const order = bob.names().filter(n => n === 'incoming_call' || n === 'call_signal');
      assert.deepEqual(order, ['incoming_call', 'call_signal']);
    });

    test('a connected app that never confirms (frozen by Doze) is woken with a push', async () => {
      const alice = await server.phone('alice');
      await server.phone('bob', { ack: false });

      const callId = await startCall(alice);

      await until(() => store.pushes.length === 1, { label: 'the fallback push (have ' + JSON.stringify(store.pushes.map(p => [p.userId, p.notification.type, p.notification.data && p.notification.data.callId])) + ')' });
      const push = store.pushes[0];
      assert.equal(push.userId, 'bob');
      assert.equal(push.notification.data.type, 'incoming_call_offline');
      assert.equal(push.notification.data.callId, callId);
      assert.equal(push.notification.data.callerName, 'alice');
      assert.equal(push.notification.data.callType, 'video');
      assert.equal(alice.all('call_status_update').length, 0, 'caller is not told "ringing" without a confirmation');
    });

    test('a receiver with no socket gets the push and the caller hears first', async () => {
      const alice = await server.phone('alice');

      const callId = await startCall(alice);

      const initiated = await alice.waitFor('call_initiated');
      assert.equal(initiated.receiverOnline, false);
      assert.equal(initiated.status, 'calling');
      await until(() => store.pushes.length === 1, { label: 'the push' });
      assert.equal(store.pushes[0].notification.data.callId, callId);
    });

    test('the push expires when the ringing does', async () => {
      server.handlers.timings.ringTimeoutMs = 3000; // clear of the push's one-second minimum
      const alice = await server.phone('alice');
      const before = Date.now();
      await startCall(alice);
      await until(() => store.pushes.length === 1, { label: 'the push' });

      const { notification } = store.pushes[0];
      assert.ok(notification.ttlMs > 2000 && notification.ttlMs <= 3000, `ttl ${notification.ttlMs}`);
      const expiresAt = Number(notification.data.ringExpiresAt);
      assert.ok(expiresAt >= before + 3000 - 50 && expiresAt <= Date.now() + 3000, 'the app is told when to give up');
    });

    test('every device of the receiver rings', async () => {
      const alice = await server.phone('alice');
      const bobPhone = await server.phone('bob');
      const bobTablet = await server.phone('bob');

      const callId = await startCall(alice);

      assert.equal((await bobPhone.waitFor('incoming_call')).callId, callId);
      assert.equal((await bobTablet.waitFor('incoming_call')).callId, callId);
      await sleep(200);
      assert.equal(store.pushes.length, 0);
    });

    test('one phone confirming is enough: a frozen second device does not trigger a push', async () => {
      const alice = await server.phone('alice');
      await server.phone('bob');
      await server.phone('bob', { ack: false });

      await startCall(alice);
      await alice.waitFor('call_status_update');
      await sleep(250);

      assert.equal(store.pushes.length, 0);
    });
  });

  describe('answering', () => {
    test('a long ring followed by an answer connects, and the ring timeout stays cancelled', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      await bob.waitFor('incoming_call');
      signal(alice, callId, offer());
      await bob.waitFor('call_signal');

      await sleep(FAST.ringTimeoutMs * 0.7); // ringing a long time, answered just in time
      bob.emit('answer_call', { callId, hasOffer: true });

      assert.deepEqual(await alice.waitFor('call_answered'), { callId, receiverId: 'bob' });
      assert.deepEqual(await bob.waitFor('call_connected'), { callId });
      assert.equal(store.calls.get(callId).status, 'answered');
      assert.equal(server.handlers.callTimeouts.has(callId), false, 'the missed-call timer is cancelled by the answer');

      // Past the point where the unanswered-call timer would have fired
      await sleep(FAST.ringTimeoutMs * 0.7);
      assert.equal(alice.all('call_missed').length, 0);
      assert.equal(alice.all('call_ended').length, 0);
      assert.equal(bob.all('call_ended').length, 0);
      assert.equal(store.calls.get(callId).status, 'answered');
      assert.equal(store.missedCalls.length, 0);
      assert.equal(server.handlers.callTimeouts.has(callId), false);
    });

    test('answering twice confirms twice but connects the caller once', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      await bob.waitFor('incoming_call');

      // Real Redis reads at once but the reply takes a moment: that is when two answers
      // that arrive together both see the call as still ringing
      const fast = redisService.getActiveCall;
      redisService.getActiveCall = async (id) => { const snapshot = await fast(id); await sleep(25); return snapshot; };

      bob.emit('answer_call', { callId, hasOffer: true });
      bob.emit('answer_call', { callId, hasOffer: true });

      await until(() => bob.all('call_connected').length === 2, { label: 'two confirmations' });
      await sleep(100); // long enough for a duplicate to land
      assert.equal(alice.all('call_answered').length, 1);
      assert.equal(store.callUpdates.filter(u => u.values.status === 'answered').length, 1);
    });

    test('answering from the push hands over the offer and candidates the phone missed', async () => {
      const alice = await server.phone('alice');
      const callId = await startCall(alice); // bob has no socket yet
      signal(alice, callId, offer('woken-up offer'));
      signal(alice, callId, candidate(1));
      signal(alice, callId, candidate(2));
      await until(() => store.pending.get(`bob:${callId}`)?.length === 3, { label: 'stored signals' });

      const bob = await server.phone('bob'); // the app starts from the notification
      await sleep(120);
      assert.equal(bob.all('call_signal').length, 0, 'nothing is pushed at the app before it answers');

      bob.emit('answer_call', { callId, hasOffer: false });

      await bob.waitFor('call_connected');
      await until(() => bob.all('call_signal').length === 3, { label: 'the stored signals' });
      const received = bob.all('call_signal');
      assert.deepEqual(received.map(s => s.signal.type), ['offer', 'ice-candidate', 'ice-candidate']);
      assert.equal(received[0].signal.sdp, 'woken-up offer');
      assert.equal(received[0].fromUserId, 'alice');
      assert.equal(store.pending.size, 0);
      assert.equal(alice.all('call_signal').length, 0, 'the caller is not asked for a new offer');
      await alice.waitFor('call_answered');
    });

    test('answering from the push with nothing stored asks the caller for a fresh offer', async () => {
      const alice = await server.phone('alice');
      const callId = await startCall(alice);
      const bob = await server.phone('bob');

      bob.emit('answer_call', { callId, hasOffer: false });

      const request = await alice.waitFor('call_signal');
      assert.equal(request.signal.type, 'request-offer');
      assert.equal(request.callId, callId);
      assert.equal(request.fromUserId, 'bob');
    });

    test('a frozen socket swallows the offer, and the phone still gets it after answering from the push', async () => {
      const alice = await server.phone('alice');
      const frozen = await server.phone('bob', { ack: false });
      const callId = await startCall(alice);
      await until(() => store.pushes.length === 1, { label: 'the push' });

      signal(alice, callId, offer('sent into a dead socket'));
      signal(alice, callId, candidate());
      await frozen.waitFor('call_signal'); // the server did relay it live...

      const fresh = await server.phone('bob'); // ...but the app that answers is a new socket
      fresh.emit('answer_call', { callId, hasOffer: false });

      await until(() => fresh.all('call_signal').length === 2, { label: 'the stored offer and candidate' });
      assert.equal(fresh.all('call_signal')[0].signal.sdp, 'sent into a dead socket');
      assert.equal(alice.all('call_signal').length, 0);
      // The frozen device is told to stop ringing
      assert.equal((await frozen.waitFor('call_ended')).reason, 'answered_elsewhere');
    });

    test('an app that got the offer live drops the stored copy when it answers', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      signal(alice, callId, offer());
      await bob.waitFor('call_signal');
      assert.equal(store.pending.get(`bob:${callId}`).length, 1);

      bob.emit('answer_call', { callId, hasOffer: true });
      await bob.waitFor('call_connected');

      assert.equal(store.pending.size, 0);
    });

    test('once answered, signals are only relayed and nothing piles up in Redis', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      bob.emit('answer_call', { callId, hasOffer: true });
      await bob.waitFor('call_connected');

      for (let i = 0; i < 5; i++) signal(alice, callId, candidate(i));
      await until(() => bob.all('call_signal').length === 5, { label: 'relayed candidates' });

      assert.equal(store.pending.size, 0);
    });

    test('the receiver\'s other devices stop ringing when one answers', async () => {
      const alice = await server.phone('alice');
      const bobPhone = await server.phone('bob');
      const bobTablet = await server.phone('bob');
      const callId = await startCall(alice);
      await bobPhone.waitFor('incoming_call');
      await bobTablet.waitFor('incoming_call');

      bobPhone.emit('answer_call', { callId, hasOffer: true });

      const stopped = await bobTablet.waitFor('call_ended');
      assert.equal(stopped.reason, 'answered_elsewhere');
      assert.equal(stopped.callId, callId);
      assert.equal(bobPhone.all('call_ended').length, 0, 'the device that answered keeps the call');
      assert.equal(alice.all('call_answered').length, 1);
    });

    test('someone who is not the receiver cannot answer, and the call keeps ringing', async () => {
      const alice = await server.phone('alice');
      await server.phone('bob');
      const mallory = await server.phone('mallory');
      const callId = await startCall(alice);

      mallory.emit('answer_call', { callId, hasOffer: true });

      const error = await mallory.waitFor('call_error');
      assert.equal(error.callId, callId);
      assert.equal(store.calls.get(callId).status, 'ringing');
      assert.equal(alice.all('call_answered').length, 0);
    });

    test('answering a call that already ended says so, naming the call', async () => {
      const bob = await server.phone('bob');

      bob.emit('answer_call', { callId: 'long-gone', hasOffer: true });

      const error = await bob.waitFor('call_error');
      assert.equal(error.callId, 'long-gone');
      assert.match(error.message, /already ended/);
    });
  });

  describe('declining, cancelling and not answering', () => {
    test('declining tells the caller, stops the other devices, and cleans up', async () => {
      const alice = await server.phone('alice');
      const bobPhone = await server.phone('bob');
      const bobTablet = await server.phone('bob');
      const callId = await startCall(alice);
      signal(alice, callId, offer());
      await bobPhone.waitFor('incoming_call');

      bobPhone.emit('decline_call', { callId });

      assert.deepEqual(await alice.waitFor('call_declined'), { callId });
      assert.equal((await bobTablet.waitFor('call_ended')).reason, 'declined');
      await until(() => store.calls.size === 0, { label: 'the call to be removed' });
      assert.equal(store.userCalls.size, 0);
      assert.equal(store.pending.size, 0);
      assert.ok(store.callUpdates.some(u => u.values.status === 'declined'));
    });

    test('someone else declining does nothing', async () => {
      const alice = await server.phone('alice');
      await server.phone('bob');
      const mallory = await server.phone('mallory');
      const callId = await startCall(alice);

      mallory.emit('decline_call', { callId });
      await sleep(150);

      assert.equal(store.calls.get(callId).status, 'ringing');
      assert.equal(alice.all('call_declined').length, 0);
    });

    test('nobody answers: the call is missed, both sides hear it, and a missed-call notification goes out', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);

      assert.deepEqual(await alice.waitFor('call_missed', () => true, FAST.ringTimeoutMs + 1000), { callId });
      const ended = await bob.waitFor('call_ended');
      assert.equal(ended.reason, 'missed');
      assert.equal(store.calls.size, 0);
      assert.equal(store.userCalls.size, 0);
      assert.deepEqual(store.missedCalls.map(c => [c.callId, c.callerId, c.receiverId]), [[callId, 'alice', 'bob']]);
      assert.ok(store.callUpdates.some(u => u.values.status === 'missed' && u.values.endReason === 'no_answer'));
      assert.equal(store.pushes.length, 0, 'bob has a socket, so no "call ended" push');
    });

    test('a missed call stops the ringing on a phone that only has the push', async () => {
      const alice = await server.phone('alice');
      const callId = await startCall(alice); // bob never connects

      await alice.waitFor('call_missed', () => true, FAST.ringTimeoutMs + 1000);

      await until(() => pushTypes().includes('call_ended'), { label: 'the call-ended push' });
      const ended = store.pushes.find(p => p.notification.type === 'call_ended');
      assert.equal(ended.userId, 'bob');
      assert.equal(ended.notification.data.callId, callId);
      assert.equal(ended.notification.data.reason, 'missed');
      assert.ok(ended.notification.ttlMs > 0);
    });

    test('the caller hanging up while the receiver\'s phone is still waking cancels the ring', async () => {
      const alice = await server.phone('alice');
      const callId = await startCall(alice);
      signal(alice, callId, offer());
      await until(() => store.pending.has(`bob:${callId}`), { label: 'the stored offer' });

      alice.emit('end_call', { callId });

      await until(() => pushTypes().includes('call_ended'), { label: 'the call-ended push' });
      const ended = store.pushes.find(p => p.notification.type === 'call_ended');
      assert.equal(ended.notification.data.reason, 'user_ended');
      assert.equal(store.calls.size, 0);
      assert.equal(store.pending.size, 0);
      assert.equal((await alice.waitFor('call_ended')).reason, 'user_ended');
    });

    test('the caller hanging up while it rings on a connected phone and its second device', async () => {
      const alice = await server.phone('alice');
      const aliceTablet = await server.phone('alice');
      const bobPhone = await server.phone('bob');
      const bobTablet = await server.phone('bob');
      const callId = await startCall(alice);
      await bobPhone.waitFor('incoming_call');

      alice.emit('end_call', { callId });

      for (const phone of [bobPhone, bobTablet, aliceTablet]) {
        assert.equal((await phone.waitFor('call_ended')).reason, 'user_ended');
      }
      assert.equal(store.pushes.length, 0);
    });

    test('ending a call the server no longer knows answers with not_found', async () => {
      const alice = await server.phone('alice');

      alice.emit('end_call', { callId: 'unknown' });

      const ended = await alice.waitFor('call_ended');
      assert.equal(ended.reason, 'not_found');
    });

    test('someone outside the call cannot end it', async () => {
      const alice = await server.phone('alice');
      await server.phone('bob');
      const mallory = await server.phone('mallory');
      const callId = await startCall(alice);

      mallory.emit('end_call', { callId });
      await sleep(150);

      assert.equal(store.calls.get(callId).status, 'ringing');
    });
  });

  describe('starting a call', () => {
    test('a busy receiver is reported and no call is created', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const carol = await server.phone('carol');
      const first = await startCall(carol, 'bob');
      bob.emit('answer_call', { callId: first, hasOffer: true });
      await bob.waitFor('call_connected');
      store.created.length = 0;

      alice.emit('initiate_call', { receiverId: 'bob', callType: 'voice' });

      assert.equal((await alice.waitFor('call_error')).message, 'User is busy');
      assert.equal(store.created.length, 0);
      assert.equal(store.calls.size, 1);
    });

    test('a call the caller was left in is ended before the new one starts', async () => {
      const alice = await server.phone('alice');
      const carol = await server.phone('carol');
      await server.phone('bob');
      const stale = await startCall(alice, 'carol');
      carol.emit('answer_call', { callId: stale, hasOffer: true });
      await carol.waitFor('call_connected');

      const fresh = await startCall(alice, 'bob');

      assert.equal((await carol.waitFor('call_ended')).callId, stale);
      assert.notEqual(fresh, stale);
      assert.deepEqual([...store.calls.keys()], [fresh]);
    });

    test('call state left behind by a restart does not block anyone', async () => {
      store.userCalls.set('alice', { callId: 'ghost-call-1', status: 'calling' });
      store.userCalls.set('bob', { callId: 'ghost-call-2', status: 'receiving' });
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');

      const callId = await startCall(alice);

      assert.equal((await bob.waitFor('incoming_call')).callId, callId);
    });

    test('a ring nobody ended before a restart does not block the receiver', async () => {
      store.calls.set('old', { id: 'old', callerId: 'carol', receiverId: 'bob', status: 'ringing', startedAt: new Date(Date.now() - 60000) });
      store.userCalls.set('bob', { callId: 'old', status: 'receiving' });
      const alice = await server.phone('alice');
      await server.phone('bob');

      const callId = await startCall(alice);

      assert.ok(callId);
      assert.equal(store.calls.has('old'), false);
    });

    test('calling yourself or a user who does not exist is refused', async () => {
      const alice = await server.phone('alice');

      alice.emit('initiate_call', { receiverId: 'alice' });
      alice.emit('initiate_call', { receiverId: 'ghost-user' });
      alice.emit('initiate_call', {});

      await until(() => alice.all('call_error').length === 3, { label: 'three refusals' });
      assert.equal(store.created.length, 0);
    });
  });

  describe('signals', () => {
    test('only the two people on the call can exchange signals', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const mallory = await server.phone('mallory');
      const callId = await startCall(alice);
      await bob.waitFor('incoming_call');

      mallory.emit('call_signal', { callId, targetUserId: 'bob', signal: offer('forged') });
      alice.emit('call_signal', { callId, targetUserId: 'mallory', signal: offer('leaked') });
      alice.emit('call_signal', { callId, targetUserId: 'alice', signal: offer('to self') });
      await sleep(150);

      assert.equal(bob.all('call_signal').length, 0);
      assert.equal(mallory.all('call_signal').length, 0);
      assert.equal(store.pending.size, 0);
    });

    test('a new offer replaces the stored ones while the receiver is away', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      bob.emit('answer_call', { callId, hasOffer: true });
      await bob.waitFor('call_connected');
      bob.drop();
      await until(() => !server.handlers.isUserConnected('bob'), { label: 'bob to be gone' });

      signal(alice, callId, offer('first'));
      signal(alice, callId, candidate(1));
      signal(alice, callId, offer('ice restart'));
      signal(alice, callId, candidate(2));

      await until(() => store.pending.get(`bob:${callId}`)?.length === 2, { label: 'stored signals' });
      assert.deepEqual(store.pending.get(`bob:${callId}`).map(s => s.payload.sdp || s.payload.candidate.candidate), ['ice restart', 'candidate:2']);
    });

    test('call controls reach the other person only', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      bob.emit('answer_call', { callId, hasOffer: true });
      await bob.waitFor('call_connected');

      alice.emit('toggle_audio', { callId, muted: true });
      alice.emit('toggle_video', { callId, videoEnabled: false });
      alice.emit('share_screen', { callId });

      assert.deepEqual(await bob.waitFor('participant_audio_toggle'), { callId, userId: 'alice', muted: true });
      assert.deepEqual(await bob.waitFor('participant_video_toggle'), { callId, userId: 'alice', videoEnabled: false });
      assert.deepEqual(await bob.waitFor('screen_share_started'), { callId, userId: 'alice' });
      assert.equal(store.calls.get(callId).screenSharing.userId, 'alice');

      alice.emit('stop_screen_share', { callId });
      assert.deepEqual(await bob.waitFor('screen_share_stopped'), { callId, userId: 'alice' });
      await until(() => !store.calls.get(callId).screenSharing, { label: 'screen share cleared' });
      assert.equal(alice.all('participant_audio_toggle').length, 0);
    });
  });

  describe('an answered call', () => {
    const connectedCall = async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      bob.emit('answer_call', { callId, hasOffer: true });
      await bob.waitFor('call_connected');
      await alice.waitFor('call_answered');
      return { alice, bob, callId };
    };

    test('either side hanging up ends it for both, and the history is saved', async () => {
      const { alice, bob, callId } = await connectedCall();
      await sleep(30);

      bob.emit('end_call', { callId });

      assert.equal((await alice.waitFor('call_ended')).endedBy, 'bob');
      assert.equal((await bob.waitFor('call_ended')).reason, 'user_ended');
      await until(() => store.calls.size === 0, { label: 'cleanup' });
      assert.equal(store.userCalls.size, 0);
      const finished = store.callUpdates.find(u => u.values.status === 'ended');
      assert.ok(finished, 'history row updated');
      assert.ok(finished.values.duration >= 0);
      assert.equal(finished.where.id, callId);
    });

    test('a dropped socket does not end the call if the app comes back in time', async () => {
      const { alice, bob, callId } = await connectedCall();

      bob.drop();
      await sleep(FAST.reconnectGraceMs.answered * 0.4);
      assert.equal(alice.all('call_ended').length, 0);
      const back = await server.phone('bob'); // the app reconnects (new socket)

      await sleep(FAST.reconnectGraceMs.answered * 1.5); // past when the timer would have fired
      assert.equal(alice.all('call_ended').length, 0);
      assert.equal(store.calls.get(callId).status, 'answered');
      assert.equal(server.handlers.callDisconnectTimers.size, 0);
      assert.equal(back.all('call_ended').length, 0);
    });

    test('an ICE restart sent while the socket was down arrives when the app reconnects', async () => {
      const { alice, bob, callId } = await connectedCall();
      bob.drop();
      await until(() => !server.handlers.isUserConnected('bob'), { label: 'bob to be gone' });

      signal(alice, callId, offer('ice restart after network change'));
      signal(alice, callId, candidate(7));
      await until(() => store.pending.get(`bob:${callId}`)?.length === 2, { label: 'stored restart' });

      const back = await server.phone('bob');

      await until(() => back.all('call_signal').length === 2, { label: 'the restart signals' });
      assert.deepEqual(back.all('call_signal').map(s => s.signal.type), ['offer', 'ice-candidate']);
      assert.equal(store.pending.size, 0);
    });

    test('a user who stays gone ends the call after the grace period, and the other side is told', async () => {
      const { alice, bob, callId } = await connectedCall();

      bob.drop();

      const ended = await alice.waitFor('call_ended', () => true, FAST.reconnectGraceMs.answered + 1500);
      assert.equal(ended.reason, 'network_error');
      assert.equal(ended.endedBy, 'bob');
      assert.equal(store.calls.size, 0);
      assert.equal(store.userCalls.size, 0);
      assert.ok(store.callUpdates.some(u => u.where.id === callId && u.values.endReason === 'network_error'));
    });

    test('losing one of two sockets does not start the countdown', async () => {
      const alice = await server.phone('alice');
      const bobPhone = await server.phone('bob');
      const bobTablet = await server.phone('bob');
      const callId = await startCall(alice);
      bobPhone.emit('answer_call', { callId, hasOffer: true });
      await bobPhone.waitFor('call_connected');

      bobTablet.drop();
      await sleep(FAST.reconnectGraceMs.answered * 1.5);

      assert.equal(alice.all('call_ended').length, 0);
      assert.equal(server.handlers.callDisconnectTimers.size, 0);
    });

    test('when the other person is gone for good the push is used to tell them', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      bob.emit('answer_call', { callId, hasOffer: true });
      await bob.waitFor('call_connected');
      bob.drop();
      await until(() => !server.handlers.isUserConnected('bob'), { label: 'bob to be gone' });

      alice.emit('end_call', { callId });

      await until(() => pushTypes().includes('call_ended'), { label: 'the call-ended push' });
      assert.equal(store.pushes.find(p => p.notification.type === 'call_ended').userId, 'bob');
    });
  });

  describe('a socket that drops while ringing', () => {
    test('the receiver dropping does not end the ring: the push can still reach them', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      await bob.waitFor('incoming_call');

      bob.drop();
      await sleep(FAST.reconnectGraceMs.ringing * 2);

      assert.equal(store.calls.get(callId)?.status, 'ringing');
      assert.equal(alice.all('call_ended').length, 0);
      // ...until the ring runs out
      await alice.waitFor('call_missed', () => true, FAST.ringTimeoutMs + 1000);
    });

    test('the receiver reconnecting while it rings can still answer', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      signal(alice, callId, offer('kept'));
      await bob.waitFor('call_signal');
      bob.drop();
      await until(() => !server.handlers.isUserConnected('bob'), { label: 'bob to be gone' });

      const back = await server.phone('bob');
      back.emit('answer_call', { callId, hasOffer: false });

      await back.waitFor('call_connected');
      await until(() => back.all('call_signal').some(s => s.signal.sdp === 'kept'), { label: 'the kept offer' });
    });

    test('the caller vanishing ends the ring after the short grace period', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      await startCall(alice);
      await bob.waitFor('incoming_call');

      alice.drop();

      const ended = await bob.waitFor('call_ended', () => true, FAST.reconnectGraceMs.ringing + 1500);
      assert.equal(ended.reason, 'network_error');
      assert.equal(store.calls.size, 0);
    });

    test('the caller coming back inside the grace period keeps the ring', async () => {
      const alice = await server.phone('alice');
      const bob = await server.phone('bob');
      const callId = await startCall(alice);
      await bob.waitFor('incoming_call');

      alice.drop();
      await sleep(FAST.reconnectGraceMs.ringing * 0.3);
      await server.phone('alice');
      await sleep(FAST.reconnectGraceMs.ringing * 1.5);

      assert.equal(bob.all('call_ended').length, 0);
      assert.equal(store.calls.get(callId).status, 'ringing');
    });
  });

  test('the real timings are the ones the app is built around', async () => {
    const defaults = new (require('../socket/socketHandlers'))({}).timings;
    assert.equal(defaults.ringTimeoutMs, 45000);
    assert.equal(defaults.ringAckTimeoutMs, 2500);
    assert.deepEqual(defaults.reconnectGraceMs, { answered: 60000, ringing: 15000 });
  });
});
