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
- `MERCADO_PAGO_ACCESS_TOKEN` com o Access Token de teste
- `MERCADO_PAGO_WEBHOOK_SECRET` com a assinatura secreta da URL de teste
- `MERCADO_PAGO_WEBHOOK_URL` apontando para `/api/payments/mercadopago/webhook` da instância Sandbox
- `SALES_ORIGIN` com o domínio da instância Sandbox

No modo Sandbox, o PIX usa a API Orders oficial de testes e preserva o e-mail informado na compra para validar o envio da licença. O pagador enviado ao Mercado Pago permanece fictício.

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
