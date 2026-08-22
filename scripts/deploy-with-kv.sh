#!/usr/bin/env bash
# JIT deploy: pull Cloudflare + Google credentials from Azure Key Vault,
# never write them to disk or git, then deploy the Worker.
set -euo pipefail

KEY_VAULT_NAME="${AZURE_KEY_VAULT_NAME:-dp-kv-deliverypilot}"
CF_TOKEN_SECRET="${CF_SECRET_NAME:-cloudflare-api-token}"
CF_ACCOUNT_SECRET="${CF_ACCOUNT_SECRET_NAME:-cloudflare-account-id}"
GOOGLE_SA_SECRET="${GOOGLE_SA_SECRET_NAME:-gcp-service-account-json}"
WORKER_SECRET_NAME="GOOGLE_SERVICE_ACCOUNT_JSON"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "========================================================"
echo " Pexabo Calendar Backup — Azure Key Vault JIT deploy"
echo "========================================================"
echo "Vault: $KEY_VAULT_NAME"
echo "Worker: pexabo-calendar-backup"

if ! az account show > /dev/null 2>&1; then
  echo "❌ Azure CLI is not authenticated. Run: az login"
  exit 1
fi
echo "✅ Azure CLI is authenticated."

fetch_secret() {
  local name="$1"
  az keyvault secret show --vault-name "$KEY_VAULT_NAME" --name "$name" --query value -o tsv 2>/dev/null || true
}

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "🔍 Fetching '$CF_TOKEN_SECRET' from Key Vault…"
  TOKEN="$(fetch_secret "$CF_TOKEN_SECRET")"
  if [ -z "$TOKEN" ]; then
    echo "❌ Secret '$CF_TOKEN_SECRET' not found in $KEY_VAULT_NAME"
    exit 1
  fi
  export CLOUDFLARE_API_TOKEN="$TOKEN"
  echo "✅ Retrieved CLOUDFLARE_API_TOKEN (length ${#CLOUDFLARE_API_TOKEN})."
else
  echo "✅ Using CLOUDFLARE_API_TOKEN from environment."
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  ACCOUNT_ID="$(fetch_secret "$CF_ACCOUNT_SECRET")"
  if [ -z "$ACCOUNT_ID" ]; then
    echo "❌ Secret '$CF_ACCOUNT_SECRET' not found in $KEY_VAULT_NAME"
    exit 1
  fi
  export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
  echo "✅ Retrieved CLOUDFLARE_ACCOUNT_ID (length ${#CLOUDFLARE_ACCOUNT_ID})."
else
  echo "✅ Using CLOUDFLARE_ACCOUNT_ID from environment."
fi

if grep -q 'REPLACE_KV_ID' wrangler.jsonc; then
  echo "🗄️  Creating Cloudflare KV namespace BACKUPS…"
  CREATE_OUT="$(npx wrangler kv namespace create BACKUPS)"
  echo "$CREATE_OUT"
  KV_ID="$(printf '%s' "$CREATE_OUT" | python3 -c '
import re, sys
text = sys.stdin.read()
ids = re.findall(r"id[\"\s:=]+([a-f0-9]{32})", text)
if not ids:
    sys.stderr.write(text + "\n")
    raise SystemExit("Could not parse KV namespace id from wrangler output")
print(ids[0])
')"
  export KV_ID
  python3 -c '
from pathlib import Path
import os
p = Path("wrangler.jsonc")
p.write_text(p.read_text().replace("REPLACE_KV_ID", os.environ["KV_ID"]))
print("✅ Wrote KV namespace id to wrangler.jsonc (resource id, not a credential).")
'
else
  echo "✅ KV namespace already configured in wrangler.jsonc."
fi

echo "🔍 Running npm run build…"
npm run build

echo "🚀 Deploying Worker to Cloudflare Edge…"
npx wrangler deploy

echo "🔍 Fetching '$GOOGLE_SA_SECRET' from Key Vault and binding as Worker secret…"
SA_JSON="$(fetch_secret "$GOOGLE_SA_SECRET")"
if [ -z "$SA_JSON" ]; then
  echo "❌ Secret '$GOOGLE_SA_SECRET' not found in $KEY_VAULT_NAME"
  exit 1
fi
export SA_JSON
python3 - <<'PY'
import json, os
raw = os.environ["SA_JSON"]
data = json.loads(raw)
assert data.get("type") == "service_account", "not a service account json"
assert "private_key" in data and "client_email" in data
email = data.get("client_email")
print(f"✅ Service account JSON ok ({email}, {len(raw)} chars).")
PY
printf '%s' "$SA_JSON" | npx wrangler secret put "$WORKER_SECRET_NAME"

# Drop secret from this shell as soon as it is uploaded
unset SA_JSON TOKEN ACCOUNT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID || true

echo ""
echo "✨ Deploy complete. Secrets lived only in process memory."
echo "   Query the live worker /api/health for the production URL."
