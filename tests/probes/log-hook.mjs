import { appendFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += String(chunk);
const payload = JSON.parse(input);
appendFileSync(process.argv[2], `${JSON.stringify({ probe_hook: process.argv[3], ...payload })}\n`);
process.stdout.write(`${process.argv[4] ?? '{}'}\n`);
