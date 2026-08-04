const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDir = path.join(__dirname, '..', 'public');

test('pagina publica de vendas referencia somente arquivos publicados', () => {
  const htmlPath = path.join(publicDir, 'sales.html');
  assert.equal(fs.existsSync(htmlPath), true, 'public/sales.html deve existir');

  const html = fs.readFileSync(htmlPath, 'utf8');
  const references = [...html.matchAll(/(?:src|href)="\/(?!api\/)([^"]+)"/g)]
    .map((match) => match[1]);

  assert.ok(references.length > 0, 'sales.html deve referenciar assets compilados');
  for (const reference of references) {
    assert.equal(
      fs.existsSync(path.join(publicDir, reference)),
      true,
      `asset ausente: ${reference}`
    );
  }
});
