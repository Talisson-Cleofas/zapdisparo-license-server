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

## Sandbox do Mercado Pago

Use uma segunda instância do serviço para não interromper pagamentos reais. Nela, configure:

- `PAYMENT_ENVIRONMENT=sandbox`
- `MONGODB_DB_NAME=zapdisparo_sandbox`
- `MERCADO_PAGO_ACCESS_TOKEN` com o Access Token de teste usado pelo PIX/Orders
- `MERCADO_PAGO_SUBSCRIPTION_ACCESS_TOKEN` com a credencial de produção da aplicação criada dentro da conta vendedora de teste
- `MERCADO_PAGO_WEBHOOK_SECRET` com a assinatura secreta do webhook do PIX/Orders
- `MERCADO_PAGO_SUBSCRIPTION_WEBHOOK_SECRET` com a assinatura secreta do webhook da aplicação vendedora de teste
- `MERCADO_PAGO_WEBHOOK_URL` apontando para `/api/payments/mercadopago/webhook` da instância Sandbox
- `SALES_ORIGIN` com o domínio da instância Sandbox

No modo Sandbox, o PIX usa a API Orders oficial de testes e preserva o e-mail informado na compra para validar o envio da licença. O pagador enviado ao Mercado Pago permanece fictício. A assinatura recorrente usa uma credencial separada porque o teste de `/preapproval` exige uma aplicação pertencente ao vendedor de teste. Essa separação não altera o fluxo de produção.

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
