import fs from 'node:fs';

const path = 'packages/worker/wrangler.jsonc';
const commit = process.env.GITHUB_SHA ?? process.env.COMMIT_SHA ?? 'dev';
const deployedAt = new Date().toISOString();
let text = fs.readFileSync(path, 'utf8');
text = text.replace(/"COMMIT_SHA": "[^"]*"/, `"COMMIT_SHA": "${commit}"`);
text = text.replace(/"DEPLOYED_AT": "[^"]*"/, `"DEPLOYED_AT": "${deployedAt}"`);
fs.writeFileSync(path, text);
console.log(`stamped ${commit.slice(0, 7)} at ${deployedAt}`);
