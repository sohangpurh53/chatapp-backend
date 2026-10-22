// Loaded before every backend test file (see package.json "test").
// dotenv never overrides variables that are already set, so these keep the
// tests away from the real database, Redis and secrets in .env: any query a
// test forgets to stub fails fast against a closed local port.
process.env.NODE_ENV = 'test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1';
process.env.DB_NAME = 'chatapp_test';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';
process.env.AI_CREDENTIALS_KEY = '';
process.env.AI_CREDENTIALS_KEY_PREVIOUS = '';
process.env.AI_ALLOW_PRIVATE_ENDPOINTS = '';
