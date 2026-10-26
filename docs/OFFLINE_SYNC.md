# Offline messaging and sync

How messages survive no connection, app restarts and retries, and what changed in
the server contract. Apps and servers of either age keep working together.

## Sending (outbox)

The app gives each message its own UUID and shows it at once as `pending` (clock
icon). It stays in a queue on the phone until the server confirms it.

- **Encryption is unchanged.** If every key the chat needs is already in memory,
  the message is encrypted immediately and only the ciphertext is stored. If not
  (offline, keys not fetched yet), the text waits in EncryptedStorage (Android
  Keystore). It is encrypted once online, with keys fresh from the server, so a
  message written offline is never sealed with a group key that was rotated after
  someone left. Plaintext is never sent for an account that has keys: such a
  message waits for the keys instead.
- **`send_message`** accepts `clientMessageId` (a UUID) and an acknowledgement
  callback. The message is stored under that id. If the same id comes again from
  the same sender, it is acknowledged as `duplicate: true` and not stored or
  broadcast twice. A concurrent duplicate that loses the insert race is handled
  the same way.
  - ack `{ ok: true, messageId, clientMessageId, createdAt, duplicate }`
  - ack `{ ok: false, code, message, retryable, retryAfter? }`. Retryable:
    `SLOW_MODE` (with `retryAfter` seconds) and `SEND_FAILED`. Final: `ACCESS_DENIED`,
    `CHAT_NOT_FOUND`, `ADMINS_ONLY`, `INVALID_ENCRYPTION`, `MESSAGE_TOO_LARGE`,
    `INVALID_MESSAGE_ID`, `MESSAGE_ID_CONFLICT`.
  - The `error` and `message_sent` events still go out for older apps, now with
    `clientMessageId`.
- **Retries:** no answer within 15 s means try again with the same id (safe,
  because the server de-duplicates). Backoff is exponential with equal jitter
  (2 s, 4 s, 8 s and so on, capped at 5 min) or the `retryAfter` the server asked for.
  After 10 real failures the message is marked `failed`: the bubble shows "Not sent ·
  Tap to retry", with Try again and Delete. Messages are never dropped silently.
- One flush runs at a time, oldest first. A chat whose earlier message is waiting
  holds its later ones, so each chat's order is kept.
- Flushes run on socket (re)connect, network regained, app foreground, keys
  loaded, a new message, and a backoff timer. Nothing polls.

## Receiving and catch-up

- **`GET /chat/sync?since=<ISO>&sinceId=<uuid>&limit=<n≤200>`** returns messages in
  all of the user's active chats after the cursor, ordered by `(createdAt, id)`:
  `{ messages, hasMore, cursor }`. Messages the user deleted for themselves are
  left out. Without `since`, it returns no messages and a cursor starting at "now".
- The app stores each page on the phone before moving its cursor, and starts each
  run 10 s before the cursor, so a message committed late is not skipped. Duplicates
  (from both the socket and sync) are recognised by id.
- **`GET /chat/:chatId/messages?before=<ISO>&beforeId=<uuid>&limit=<n>`** returns
  older history before a message (cursor-based, so new messages arriving meanwhile
  can't cause gaps or repeats). Page numbers still work as before.

## Delivery ticks

- Receipts now start as `sent`. They become `delivered` only when the recipient's
  app confirms it stored the message: socket `messages_delivered { messageIds }`
  (up to 500 per call; only the caller's own `pending`/`sent` receipts change). The
  sender then gets `message_delivered { messageId, chatId, userId, deliveredAt }`.
  Previously every receipt was written as `delivered` at send time, even for
  recipients who were offline.
- Apps state their protocol in the socket handshake (`auth.syncProtocol: 2`).
  Older apps (protocol 1) can't confirm delivery, so for them "connected when it
  was sent" still counts as delivered. On connect they still get
  `sync_pending_messages` (now capped at 500, and only those messages are marked
  delivered).
- The app derives its own messages' tick from their receipts. The message row
  always says `sent`, so messages fetched again used to show a single tick even
  after they had been read.

## Compatibility and deploy order

- The server announces `server_features { messageAck, sync }` right after
  connecting. A new app treats a server that announces nothing within 3 s as
  older: it sends each message once without retries (the old behaviour, because an
  older server would store every retry as a new message) and skips `/chat/sync`.
  So the new app is safe against the current server, but gets **no** retries or
  catch-up until this server is deployed.
- Old apps against the new server: unchanged behaviour (no `clientMessageId`, no
  callback, protocol 1).
- No schema change: `Message.id` was already a UUID primary key. The server
  must be restarted for the new socket events.
- Socket event handlers are now registered before the connection handler awaits
  anything. A send emitted right on connect, as the outbox does, used to arrive
  before its handler existed and was dropped.

## On the phone

- Messages, the chat list and the decrypted-text cache live in one SQLite
  database encrypted with SQLCipher (`@op-engineering/op-sqlite`, config
  `"op-sqlite": { "sqlcipher": true }` in package.json, so it needs a native
  rebuild). The 256-bit key is random and kept in EncryptedStorage. Logout deletes
  the file and its key. On first launch, the old AsyncStorage caches are imported
  once and removed. That includes the decrypted-text cache, which used to sit
  unencrypted in AsyncStorage.
- Chats open on their newest page and load older pages from the database, then
  the server, as the reader scrolls up. There is no 100-message cap and no 7-day
  expiry any more.
- RSA unwrapping of message keys goes through `RsaKeyModule.kt`. It is the same
  `RSA/NONE/PKCS1Padding` operation as react-native-rsa-native, but the private key
  is parsed once (with its CRT values) and calls run on a small thread pool instead
  of re-parsing the PEM on Android's serial AsyncTask thread. The output is
  identical (verified on device against the library: 0 mismatches in 40).
