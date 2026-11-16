'use strict';

const crypto = require('crypto');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const token = input.trim();
  if (!token) {
    console.error('Pass the device token through stdin.');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${crypto.createHash('sha256').update(token).digest('hex')}\n`);
});
