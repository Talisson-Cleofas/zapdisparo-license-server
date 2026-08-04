const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validatePaymentTestConfiguration,
  checkoutAmountForPlan,
  mercadoPagoCheckoutCredentials,
  mercadoPagoCheckoutPayload
} = require('../src/server');

test('teste real controlado exige Sandbox, URL de homologacao e exatamente R$ 1,00', () => {
  assert.deepEqual(validatePaymentTestConfiguration({
    paymentTestMode: 'controlled-real',
    checkoutTestAmountCents: 100,
    paymentEnvironment: 'sandbox',
    checkoutBackUrl: 'https://zapdisparo-license-server-sandbox.onrender.com/sales.html'
  }), { controlledPaymentTest: true, checkoutTestAmountCents: 100 });

  assert.throws(() => validatePaymentTestConfiguration({
    paymentTestMode: 'controlled-real', checkoutTestAmountCents: 100,
    paymentEnvironment: 'production', checkoutBackUrl: 'https://zapdisparo.com/sales.html'
  }), /ambiente Sandbox/i);
  assert.throws(() => validatePaymentTestConfiguration({
    paymentTestMode: 'controlled-real', checkoutTestAmountCents: 200,
    paymentEnvironment: 'sandbox', checkoutBackUrl: 'https://zapdisparo-sandbox.example/sales.html'
  }), /100 centavos/i);
  assert.throws(() => validatePaymentTestConfiguration({
    paymentTestMode: 'controlled-real', checkoutTestAmountCents: 100,
    paymentEnvironment: 'sandbox', checkoutBackUrl: 'https://zapdisparo.com/sales.html'
  }), /homologa/i);
});

test('modo controlado cobra R$ 1,00 sem alterar os valores oficiais dos planos', () => {
  assert.equal(checkoutAmountForPlan('Mensal', { paymentTestMode: '', checkoutTestAmountCents: 0 }), 99.99);
  assert.equal(checkoutAmountForPlan('Semestral', { paymentTestMode: '', checkoutTestAmountCents: 0 }), 599.99);
  assert.equal(checkoutAmountForPlan('Anual', { paymentTestMode: '', checkoutTestAmountCents: 0 }), 1199.99);
  assert.equal(checkoutAmountForPlan('Anual', { paymentTestMode: 'controlled-real', checkoutTestAmountCents: 100 }), 1);
});

test('compra real controlada nunca reutiliza silenciosamente o token de testes do PIX', () => {
  const controlled = mercadoPagoCheckoutCredentials({
    paymentTestMode: 'controlled-real',
    checkoutAccessToken: '',
    accessToken: 'token-automatico-pix',
    checkoutWebhookSecret: '',
    webhookSecret: 'segredo-pix'
  });
  assert.equal(controlled.accessToken, '');
  assert.equal(controlled.accessTokenVariable, 'MERCADO_PAGO_CHECKOUT_ACCESS_TOKEN');

  const production = mercadoPagoCheckoutCredentials({
    paymentTestMode: '',
    checkoutAccessToken: '',
    accessToken: 'token-producao',
    checkoutWebhookSecret: '',
    webhookSecret: 'segredo-producao'
  });
  assert.equal(production.accessToken, 'token-producao');
  assert.equal(production.webhookSecret, 'segredo-producao');
});

test('preferencia Checkout Pro leva referencia exclusiva, valor e retornos seguros', () => {
  const payload = mercadoPagoCheckoutPayload({
    orderCode: 'PED-CHECKOUT-001',
    plan: 'Mensal',
    amount: 1,
    email: 'cliente@example.com',
    name: 'Cliente Teste'
  }, {
    controlledPaymentTest: true,
    webhookUrl: 'https://zapdisparo-sandbox.example/api/payments/mercadopago/checkout/webhook',
    backUrl: 'https://zapdisparo-sandbox.example/sales.html',
    sandboxCheckout: false
  });

  assert.equal(payload.external_reference, 'PED-CHECKOUT-001');
  assert.equal(payload.items[0].unit_price, 1);
  assert.match(payload.items[0].title, /TESTE CONTROLADO/);
  assert.equal(payload.notification_url, 'https://zapdisparo-sandbox.example/api/payments/mercadopago/checkout/webhook');
  assert.equal(new URL(payload.back_urls.success).searchParams.get('payment'), 'success');
  assert.equal(new URL(payload.back_urls.pending).searchParams.get('payment'), 'pending');
  assert.equal(new URL(payload.back_urls.failure).searchParams.get('payment'), 'failure');
  assert.deepEqual(payload.payer, { email: 'cliente@example.com', name: 'Cliente Teste' });

  const sandboxPayload = mercadoPagoCheckoutPayload({
    orderCode: 'PED-SANDBOX-001', plan: 'Mensal', amount: 99.99,
    email: 'cliente@example.com', name: 'Cliente Teste'
  }, {
    controlledPaymentTest: false,
    webhookUrl: 'https://zapdisparo-sandbox.example/webhook',
    backUrl: 'https://zapdisparo-sandbox.example/sales.html',
    sandboxCheckout: true
  });
  assert.equal('payer' in sandboxPayload, false);
});
