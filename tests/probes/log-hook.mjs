import { appendFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += String(chunk);
appendFileSync(process.argv[2], `${input.trim()}\n`);
process.stdout.write('{}\n');
