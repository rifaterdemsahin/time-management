import fs from 'node:fs';
import path from 'node:path';

const files = [
  'public/push.html',
  'public/explainer.html',
  'public/architecture.html',
  'public/permissions.html',
  'public/styles.css',
  'src/index.js',
  'src/google.js',
  'src/mcp.js',
  'src/calendar-api.js',
  'wrangler.jsonc',
  'scripts/deploy-with-kv.sh',
];

const forbidden = [
  /CLOUDFLARE_API_TOKEN\s*=\s*['"](?!\$)[A-Za-z0-9._-]{20,}['"]/,
  /-----BEGIN PRIVATE KEY-----/,
  /"private_key"\s*:\s*"-----/,
  /sk-[a-zA-Z0-9]{20,}/,
];

console.log('🔍 Validating Pexabo Calendar Backup Worker…');

let failed = false;
for (const file of files) {
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Missing ${file}`);
    failed = true;
    continue;
  }
  const stat = fs.statSync(filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  if (stat.size < 32) {
    console.error(`❌ ${file} is too small (${stat.size} bytes)`);
    failed = true;
    continue;
  }
  for (const re of forbidden) {
    if (re.test(text)) {
      console.error(`❌ ${file} looks like it contains a plaintext secret (${re})`);
      failed = true;
    }
  }
  console.log(`✅ ${file} verified (${stat.size} bytes)`);
}

const wrangler = fs.readFileSync(path.resolve('wrangler.jsonc'), 'utf8');
if (/account_id\s*"?\s*:/.test(wrangler) && !/REPLACE_/.test(wrangler)) {
  // account_id in wrangler is discouraged — prefer CLOUDFLARE_ACCOUNT_ID from Key Vault
  if (/"account_id"\s*:\s*"[a-f0-9]{32}"/.test(wrangler)) {
    console.error('❌ wrangler.jsonc must not contain a plaintext Cloudflare account id');
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log('✨ Build validation successful — no plaintext credentials found.');
