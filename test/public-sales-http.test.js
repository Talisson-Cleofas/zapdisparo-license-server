const assert = require('node:assert/strict');
const test = require('node:test');

const { app } = require('../src/server');

test('servidor entrega a pagina de vendas e seu bundle principal', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  const page = await fetch(`${origin}/sales.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);

  const html = await page.text();
  const bundlePath = html.match(/src="(\/assets\/vendas-[^"]+\.js)"/)?.[1];
  assert.ok(bundlePath, 'bundle principal da pagina de vendas não encontrado');

  const bundle = await fetch(`${origin}${bundlePath}`);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('content-type') || '', /javascript/);
});
