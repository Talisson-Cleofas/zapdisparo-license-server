const assert = require('node:assert/strict');
const test = require('node:test');

const { License } = require('../src/server');

test('aceita plano legado sem alterar validade vitalicia', async () => {
  const license = new License({
    email: 'admin@example.com',
    name: 'Administrador',
    plan: 'Full Admin',
    token: 'ZAP-LEGACY-ADMIN',
    licenseKey: 'ZAP-LEGACY-ADMIN',
    expiresAt: null
  });

  await license.validate();

  assert.equal(license.plan, 'Full Admin');
  assert.equal(license.expiresAt, null);
});
