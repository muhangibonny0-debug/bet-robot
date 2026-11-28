# BetRobot — Optional Google Cloud Run Setup & Zero-Spend Safeguards

> **Status:** Prepared locally only. **No Google Cloud services have been enabled, no billing has been configured, and nothing has been deployed.** Local testing (`research/local_server.js`) and Phone Gateway remain fully functional without Cloud Run.

## 1. Important Billing & Zero-Spend Disclosure

- **Google Cloud requires a billing account to be linked to your GCP project in order to use Cloud Run**, even if your monthly usage stays within Google Cloud Run's free tier.
- **Application-level limits CANNOT guarantee zero billing on their own.** Even with `MAX_JOBS_PER_DAY`, `MAX_JOBS_PER_MONTH`, `MAX_ACTIVE_MINUTES_PER_DAY`, and `minScale: 0` / `maxScale: 1`, GCP platform charges could still occur from:
  - Container image storage (Artifact Registry) exceeding free tier
  - Egress network traffic or Cloud Build minutes exceeding free tier
  - Cloud Logging / Monitoring ingestion
  - Unauthenticated HTTP traffic hitting the Cloud Run endpoint (even HTTP 401 rejections still consume request/CPU time!)
- **Before ever deploying**, you must manually configure:
  1. A **GCP Cloud Billing Budget & Alert** (e.g., \$1 threshold with email/PubSub alerts).
  2. `minScale=0` and `maxScale=1` (already set in `cloudrun-service.yaml`).
  3. Strong random `BETROBOT_CLOUD_TOKEN` (at least 32 hex chars).

## 2. Architecture

```text
BetBrain Android App
  └─ HTTPS (Authorization: Bearer <BETROBOT_CLOUD_TOKEN>)
       └─ Cloud Run (cloud/server.js)
            ├─ Enforces safe quotas (usage.json) & duplicate-job protection
            ├─ Spawns research/run.js (exact same engine as local_server.js)
            │    └─ Playwright Chromium -> BangBet (zero stakes, guest Share Bet)
            └─ Persists job state -> GET /jobs/:id -> BetBrain live progress
```

## 3. Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port (Cloud Run injects `PORT=8080`) |
| `BETROBOT_CLOUD_TOKEN` | *(required)* | Bearer token for `Authorization: Bearer <token>`; server returns `503` if unset |
| `BETROBOT_STATE_DIR` | `/tmp/betrobot_state` | Directory for `job-*.json`, logs, and `usage.json` |
| `MAX_CONCURRENT_JOBS` | `1` | Max simultaneous research jobs |
| `MAX_JOBS_PER_DAY` | `10` | Daily job refusal threshold (HTTP 429) |
| `MAX_JOBS_PER_MONTH` | `100` | Monthly job refusal threshold (HTTP 429) |
| `MAX_JOB_MINUTES` | `15` | Hard upper limit on per-job duration |
| `MAX_ACTIVE_MINUTES_PER_DAY` | `90` | Daily cumulative worker runtime cap (HTTP 429) |
| `BOT_CONCURRENCY` | `2` | Bounded browser tabs per job (1–3) |

## 4. Manual Deployment Steps (Only When You Explicitly Approve)

1. Link a GCP project and set up a Billing Budget Alert first.
2. Build & push container from `D:\BetRobot`:
   ```bash
   gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/betrobot/betrobot-cloud:latest -f cloud/Dockerfile .
   ```
3. Deploy with strict scale & resource caps:
   ```bash
   gcloud run deploy betrobot-cloud \
     --image REGION-docker.pkg.dev/PROJECT_ID/betrobot/betrobot-cloud:latest \
     --region REGION \
     --min-instances 0 --max-instances 1 --concurrency 1 \
     --cpu 1 --memory 2Gi --timeout 900 \
     --set-env-vars "BETROBOT_CLOUD_TOKEN=<your-strong-secret>,MAX_JOBS_PER_DAY=10,MAX_JOBS_PER_MONTH=100,MAX_ACTIVE_MINUTES_PER_DAY=90"
   ```
4. In **BetBrain → Settings → Optional Google Cloud Run Backend**, enable the toggle, paste the HTTPS Cloud Run URL and token, and tap **Test Connection**.
