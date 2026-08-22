# 📅 Pexabo Calendar Backup — Cloudflare Worker POC

> 🚀 **Live on the Cloudflare edge.** Backup and manage Google Calendar events for **info@pexabo.com** (Pexabo Team) with REST + MCP JSON-RPC. Credentials never touch git — they are fetched just-in-time from **Azure Key Vault `dp-kv-deliverypilot`**.

---

## 🌐 Live production

**Base URL:** [https://pexabo-calendar-backup.polished-boat-17b2.workers.dev](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev)

| Page / API | What it is | Live URL |
| :--- | :--- | :--- |
| 📤 **Push console** | Backup window, upcoming events, snapshots, REST/MCP command studio | [Open Push ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/push) |
| 📖 **Explainer** | Why backup, snapshot contents, REST table, MCP tools | [Read explainer ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/explainer) |
| 🏗️ **Architecture** | JIT Key Vault deploy path, runtime JWT + KV, free-tier budget | [View architecture ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/architecture) |
| 🔐 **Permissions** | Live Grok Calendar access-box checks + ACL | [View permissions ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/permissions) |
| ✅ **Permission check API** | JSON probe of the four Grok Calendar grants | [GET /api/permissions/check ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/api/permissions/check) |
| 🩺 **Health API** | JSON edge diagnostics (colo, city, runtime) | [GET /api/health ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/api/health) |
| 📆 **Calendar status** | Live `accessRole` against info@pexabo.com | [GET /api/calendar ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/api/calendar) |
| 📋 **Events** | Next 14 days of Pexabo Team events | [GET /api/events ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/api/events) |
| 🧰 **MCP catalog** | JSON-RPC tools (`calendar_backup`, `calendar_list_events`, …) | [GET /mcp ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/mcp) |
| 📦 **Snapshots** | KV backup index | [GET /api/backups ↗](https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/api/backups) |

Cloudflare account: `contact@rifaterdemsahin.com` · Worker: `pexabo-calendar-backup` · Free plan (`*.workers.dev`).

---

## 🎯 What this project does

A proof of concept for **backing up Google Calendar events** owned by `info@pexabo.com` and **managing them through two command surfaces**:

1. **REST API** — `GET/POST /api/events`, `POST /api/backup`, restore, ICS export.
2. **MCP JSON-RPC** — `POST /mcp` with `tools/list` and `tools/call` (`calendar_backup`, `calendar_list_events`, `calendar_create_event`, …).

The **Push** page is the operator console: pick a window, snapshot to Cloudflare KV, inspect busy blocks, and fire the same commands the agent would.

Top menu coordinates **Push · Explainer · Architecture · Permissions**.

---

## 🔐 Zero plaintext secrets

| Secret (Azure KV name) | When it is read | Where it ends up |
| :--- | :--- | :--- |
| `cloudflare-api-token` | `npm run deploy:azure` | Process env for Wrangler only |
| `cloudflare-account-id` | `npm run deploy:azure` | Process env for Wrangler only |
| `gcp-service-account-json` | `npm run deploy:azure` | Piped to `wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON` |

- ❌ No `.env` committed
- ❌ No tokens in `wrangler.jsonc`
- ❌ `npm run build` fails if a PEM / hardcoded token appears in source
- ✅ Service account JWT is signed **inside the isolate** with WebCrypto (RS256)

---

## 🏗️ Architecture (short)

```
Azure Key Vault (dp-kv-deliverypilot)
        │  az keyvault secret show  (JIT, memory only)
        ▼
npm run deploy:azure  →  wrangler deploy + secret put
        ▼
Cloudflare Worker  pexabo-calendar-backup
  ├─ HTML: /push /explainer /architecture /permissions
  ├─ REST: /api/health /api/calendar /api/events /api/backup
  ├─ MCP:  POST /mcp  (JSON-RPC 2.0)
  ├─ KV:   BACKUPS snapshots
  └─ Google Calendar API  calendars/info@pexabo.com/events
```

**Current Google ACL:** live-checked on `/permissions` (was upgraded to `reader`). Titles backup when every event exposes a summary. Writer is still required to restore. The Permissions page maps Grok’s four Calendar boxes (list / view+edit / freebusy / see+download) to live API probes.

---

## 💰 Cost: $0 / month

| Tier | Price | Quota used by this POC |
| :--- | :--- | :--- |
| **Cloudflare Workers Free** | **$0** | 100,000 req/day, 100 scripts, free `workers.dev` |
| **Workers KV Free** | **$0** | 100k reads / 1k writes per day (one write per snapshot) |
| **Azure Key Vault** | ~$0 | Only billed on deploy (`secret show`) |

Stays inside the Cloudflare 100,000 req/day free tier on purpose.

---

## 🛠️ Commands

```bash
npm install
npm run build          # validate files + reject plaintext secrets
npm run dev            # local wrangler (needs the Worker secret for Calendar)
npm run deploy:azure   # JIT fetch from dp-kv-deliverypilot, then deploy
```

Requires: Node 20+, Azure CLI (`az login` as a principal that can read the vault), Cloudflare token already stored in the vault.

---

## 🧪 Verified against production

Hit on 2026-08-22 from the edge (LHR):

| Check | Result |
| :--- | :--- |
| `/` `/push` `/explainer` `/architecture` `/permissions` `/styles.css` | 200 |
| Unknown path | 404 HTML |
| `GET /api/health` | `ok`, runtime V8 Isolate |
| `GET /api/calendar` | `Pexabo Team` · `freeBusyReader` · Europe/London |
| `GET /api/events` | Live busy blocks for info@pexabo.com |
| `POST /api/backup` | Snapshot `bck_mt3skbco_c176c1d6` · **31 events** (14-day window) |
| `GET /mcp` + `tools/list` | 10 calendar tools |
| `tools/call calendar_status` | Same live ACL as REST |

---

## 📡 Example commands

**REST — list events**

```bash
curl -s https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/api/events \
  | jq '.items | length'
```

**REST — push a backup**

```bash
curl -s -X POST https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/api/backup \
  -H 'content-type: application/json' \
  -d '{"timeMin":"2026-08-22T00:00:00Z","timeMax":"2026-09-05T00:00:00Z"}'
```

**MCP — backup via JSON-RPC**

```bash
curl -s -X POST https://pexabo-calendar-backup.polished-boat-17b2.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": { "name": "calendar_backup", "arguments": {} }
  }'
```

---

## 👨‍💻 Author

**Rifat Erdem Sahin**
- GitHub: [@rifaterdemsahin](https://github.com/rifaterdemsahin)
- Cloudflare: `contact@rifaterdemsahin.com`
- Calendar: `info@pexabo.com`
- License: MIT
