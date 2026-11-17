'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAuthHelpers } = require('../auth');

function deviceRequest(token, deviceId = 'esp01') {
  return {
    headers: {
      authorization: token ? `Bearer ${token}` : '',
      'x-device-id': deviceId,
    },
  };
}

test('production device auth validates SHA-256 token hash from Firestore', async () => {
  const token = 'device-secret-123';
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const db = {
    collection(name) {
      assert.equal(name, 'device_credentials');
      return {
        doc(id) {
          assert.equal(id, 'esp01');
          return { get: async () => ({ data: () => ({ token_hash: tokenHash }) }) };
        },
      };
    },
  };
  const helpers = createAuthHelpers({ firestoreDb: db, nodeEnv: 'production' });

  assert.equal(await helpers.deviceAuthorized(deviceRequest(token)), true);
  assert.equal(await helpers.deviceAuthorized(deviceRequest('wrong-secret')), false);
});

test('production device auth rejects query-string credentials and missing device IDs', async () => {
  const helpers = createAuthHelpers({
    firestoreDb: { collection() { throw new Error('must not query without a device id'); } },
    nodeEnv: 'production',
  });

  assert.equal(await helpers.deviceAuthorized({ headers: {} }, 'dev-device-token'), false);
  assert.equal(await helpers.deviceAuthorized(deviceRequest('device-secret', '')), false);
});

test('development allows the legacy query token fallback', async () => {
  const helpers = createAuthHelpers({ nodeEnv: 'development', deviceToken: 'dev-device-token' });
  assert.equal(await helpers.deviceAuthorized({ headers: {} }, 'dev-device-token'), true);
});
