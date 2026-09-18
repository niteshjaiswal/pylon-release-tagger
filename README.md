# pylon-release-tagger

Lightweight Node.js service that listens for Linear webhooks and applies `rel-[slug]` / `bug-as-designed` tags to matching Pylon Issues.

This replaces the Aether/Zendesk release tagging system (CXA-147) for 7shifts' migration to Pylon.

## What it does

1. **Receives a Linear webhook** when a release project moves to Done (p1–p4), or when `bug-as-designed` label is applied to an issue
2. **Fetches Pylon Issues** from the relevant lookback window (30/14/7/60 days)
3. **Keyword-matches** issue titles and bodies against the release title/description
4. **Applies tags** to matched Pylon Issues via `PATCH /issues/{id}`

No database. No ML classifier. No npm dependencies. Just Node.js 18+.

## Lookback windows

| Priority | Lookback |
|---|---|
| p1 | 30 days |
| p2 | 14 days |
| p3 | 7 days |
| p4 | 7 days |
| bug-as-designed | 60 days |

## Tag convention

| Event | Tag applied to Pylon Issues |
|---|---|
| Release project → Done | `rel-[slug]` (e.g. `rel-schedule-layout-v1`) |
| Bug-as-designed label | `bug-as-designed` + `bug-as-designed-lin-[id]` |

## Setup

### 1. Environment variables

```bash
PYLON_API_TOKEN=        # Pylon Bearer token — Settings → API → Create token (Issues read/write)
LINEAR_WEBHOOK_SECRET=  # Linear webhook signing secret
PYLON_REGION=us         # "us" or "eu" (default: "us")
PORT=3000               # HTTP port (default: 3000)
```

### 2. Linear webhook

In Linear: **Settings → API → Webhooks → Create webhook**

- **URL:** `https://your-deployed-url/webhook/linear`
- **Events to subscribe:** Project (state changes) + IssueLabel (label applied)
- Copy the **Signing Secret** → set as `LINEAR_WEBHOOK_SECRET`

### 3. Pylon tags

In Pylon: **Settings → Issue Tags** — create tags matching your release slugs:
- `rel-schedule-layout-v1`
- `bug-as-designed`
- etc.

Tags can also be created on the fly from a Pylon Issue — Pylon creates them dynamically.

### 4. Linear release checklist

Ensure release projects in Linear have a **p1/p2/p3/p4 label applied** before moving to Done. Without a priority label, the service defaults to the 7-day lookback window.

## Running locally

```bash
node index.js
# Listening on :3000
```

Test with a manual POST:
```bash
curl -X POST http://localhost:3000/webhook/linear \
  -H "Content-Type: application/json" \
  -d '{"type":"Project","action":"update","data":{"name":"Schedule Layout v1","state":"completed","description":"New schedule view with role filter","projectMilestones":[{"name":"p2"}]}}'
```

## Deployment

**7shifts internal infra:** Hand this repo + the 3 env vars to eng. ~1–2 hours to deploy. Linear ticket: [CXA-147](https://linear.app/7shifts/issue/CXA-147)

The service is a standard Node.js HTTP server — deploy it wherever 7shifts hosts internal services (AWS, etc.). Once deployed:
1. Copy the public URL
2. Go to Linear → Settings → API → Webhooks → Create webhook
3. Paste the URL as `https://your-url/webhook/linear`
4. Subscribe to: **Project** (state changes) + **IssueLabel** (label applied)
5. Copy the signing secret → set as `LINEAR_WEBHOOK_SECRET` env var

**AWS Lambda alternative:** Export `handleLinearWebhook` and wrap in a Lambda handler. Core logic is unchanged.

**7shifts internal infra:** Hand this repo + the env vars to eng. ~1–2 hours to deploy. Linear ticket: [CXA-147](https://linear.app/7shifts/issue/CXA-147)

## Important implementation notes

- `PATCH /issues/{id}` in Pylon is a **full tag replace** — the code fetches existing tags and merges before writing. Do not simplify this or existing tags will be wiped.
- Rate limits: `GET /issues` = 30 req/min, `PATCH /issues` = 120 req/min. Both are respected with `sleep()` calls.
- Keyword matching is simple substring (case-insensitive). If false positives occur after go-live, add a minimum word length filter — no classifier needed.
- Webhook signature verification uses HMAC-SHA256. Set `LINEAR_WEBHOOK_SECRET` in prod — skipped only if unset (dev only).

## File structure

```
pylon-release-tagger/
  index.js      — full service (single file, zero dependencies)
  package.json  — Node.js 18+ ESM module
  README.md     — this file
```
