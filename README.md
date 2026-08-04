# Servidor de Licenças ZapDisparo

Use esta pasta para publicar a API de licenças no Render, Railway ou VPS.

## Local

```bash
cd license-server
npm install
copy .env.example .env
npm run dev
```

## Render

- Root directory: `license-server`
- Build command: `npm install`
- Start command: `npm start`
- Variáveis: `MONGODB_URI` e `ADMIN_KEY`
- Página pública de vendas: `/sales.html` (a raiz `/` direciona para a mesma página)

## Checkout Pro do Mercado Pago

A página pública usa o Checkout Pro hospedado. O cliente escolhe PIX, cartão ou boleto no ambiente do Mercado Pago, e o ZapDisparo não recebe dados de cartão. Cada pagamento aprovado concede ou renova a licença pelo período do plano comprado:

- Mensal: R$ 99,99 por 30 dias
- Semestral: R$ 599,99 por 180 dias
- Anual: R$ 1.199,99 por 365 dias

O servidor envia `external_reference` com o código exclusivo do pedido, valida a assinatura do webhook, consulta o pagamento diretamente na API do Mercado Pago, confere referência e valor e só então libera a licença. A operação é idempotente: o mesmo pagamento não renova a licença duas vezes.

Configure em produção:

- `MERCADO_PAGO_CHECKOUT_ACCESS_TOKEN`
- `MERCADO_PAGO_CHECKOUT_WEBHOOK_SECRET`
- `MERCADO_PAGO_CHECKOUT_WEBHOOK_URL=https://seu-dominio/api/payments/mercadopago/checkout/webhook`
- `MERCADO_PAGO_CHECKOUT_BACK_URL=https://seu-dominio/sales.html`
- `PAYMENT_TEST_MODE=` vazio
- `CHECKOUT_TEST_AMOUNT_CENTS=0`

## Homologação com compra real de R$ 1,00

Use uma segunda instância do serviço para não interromper pagamentos reais. Nela, configure:

- `PAYMENT_ENVIRONMENT=sandbox`
- `MONGODB_DB_NAME=zapdisparo_sandbox`
- `PAYMENT_TEST_MODE=controlled-real`
- `CHECKOUT_TEST_AMOUNT_CENTS=100`
- `MERCADO_PAGO_CHECKOUT_ACCESS_TOKEN` com o Access Token de produção da conta vendedora real usada na homologação
- `MERCADO_PAGO_CHECKOUT_WEBHOOK_SECRET` com a assinatura secreta do webhook dessa aplicação
- `MERCADO_PAGO_CHECKOUT_WEBHOOK_URL` apontando para `/api/payments/mercadopago/checkout/webhook` da instância Sandbox
- `MERCADO_PAGO_CHECKOUT_BACK_URL` apontando para `/sales.html` da instância Sandbox
- `SALES_ORIGIN` com o domínio da instância Sandbox

As travas impedem a inicialização se o valor não for exatamente 100 centavos, se `PAYMENT_ENVIRONMENT` não for `sandbox` ou se a URL de retorno não contiver `sandbox` ou `homologacao`. Os preços oficiais permanecem inalterados.

Depois do pagamento real, confirme no Sandbox: pedido `paid`, licença criada/renovada uma única vez, e-mail enviado e registro do evento. Não faça a compra usando a mesma conta Mercado Pago que recebe o pagamento.

Os endpoints antigos de PIX e assinatura foram preservados para compatibilidade, mas a página de vendas não os oferece mais.

## Criar licença

POST `/api/admin/licenses`

Header:

```txt
x-admin-key: sua-chave-admin
```

Body:

```json
{
  "name": "Cliente Teste",
  "email": "cliente@email.com",
  "plan": "Mensal",
  "expiresAt": "2026-08-11",
  "dailyLimit": 300,
  "connectionLimit": 1,
  "allowedDevices": 1
}
```
