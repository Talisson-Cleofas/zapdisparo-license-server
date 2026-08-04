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
