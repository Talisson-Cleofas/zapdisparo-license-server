#!/usr/bin/env node
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicDer = publicKey.export({ format: 'der', type: 'spki' });
const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });

console.log('LICENSE_PUBLIC_KEY_B64=' + publicDer.toString('base64'));
console.log('LICENSE_PRIVATE_KEY_B64=' + privateDer.toString('base64'));
console.log('\nGuarde a chave privada somente no servidor de licenças. O aplicativo recebe apenas a chave pública.');
