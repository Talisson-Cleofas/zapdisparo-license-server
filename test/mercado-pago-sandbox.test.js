const assert = require('node:assert/strict');
const test = require('node:test');

const {
  sandboxPixOrderPayload,
  mercadoPagoOrderPayment,
  mercadoPagoOrderStatus,
  mercadoPagoOrderAmount
} = require('../src/server');

test('monta order PIX de Sandbox sem substituir os dados comerciais do pedido', () => {
  const payload = sandboxPixOrderPayload({
    orderCode: 'PED-SANDBOX-001',
    amount: 99.99,
    email: 'cliente-real@example.com',
    name: 'Cliente Real'
  });

  assert.equal(payload.external_reference, 'PED-SANDBOX-001');
  assert.equal(payload.total_amount, '99.99');
  assert.equal(payload.payer.email, 'test_user_br@testuser.com');
  assert.equal(payload.payer.first_name, 'APRO');
  assert.deepEqual(payload.transactions.payments[0], {
    amount: '99.99',
    payment_method: { id: 'pix', type: 'bank_transfer' }
  });
});

test('normaliza estados e valores retornados pela API Orders', () => {
  const waitingOrder = {
    status: 'action_required',
    total_amount: '99.99',
    transactions: {
      payments: [{ id: 'PAY-1', amount: '99.99', status: 'action_required' }]
    }
  };
  assert.equal(mercadoPagoOrderPayment(waitingOrder).id, 'PAY-1');
  assert.equal(mercadoPagoOrderStatus(waitingOrder), 'action_required');
  assert.equal(mercadoPagoOrderAmount(waitingOrder), 99.99);

  const approvedOrder = {
    ...waitingOrder,
    status: 'processed',
    transactions: { payments: [{ id: 'PAY-1', amount: '99.99', status: 'approved' }] }
  };
  assert.equal(mercadoPagoOrderStatus(approvedOrder), 'approved');
});
