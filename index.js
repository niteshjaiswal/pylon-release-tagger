/**
 * Pylon Release Tagger
 * =====================
 * Receives a Linear webhook (issue → Done) and applies a rel-[slug] tag
 * to all Pylon Issues created within the lookback window whose title/body
 * match the release keywords.
 *
 * Deploy: any Node.js host (Railway, Render, AWS Lambda, Fly.io, etc.)
 * Runtime: Node.js 18+
 * Dependencies: none (uses native fetch)
 *
 * Environment variables required:
 *   PYLON_API_TOKEN       — Pylon Bearer token (Settings → API)
 *   LINEAR_WEBHOOK_SECRET — Linear webhook signing secret (for request verification)
 *   PYLON_REGION          — "us" or "eu" (default: "us")
 */

import crypto from "crypto";
import http from "http";

// ─── Config ───────────────────────────────────────────────────────────────────

const PYLON_BASE =
  process.env.PYLON_REGION === "eu"
    ? "https://api.eu.usepylon.com"
    : "https://api.usepylon.com";

const PYLON_TOKEN = process.env.PYLON_API_TOKEN;
const LINEAR_SECRET = process.env.LINEAR_WEBHOOK_SECRET;

// Lookback windows by Linear priority label (days)
const LOOKBACK_DAYS = { p1: 30, p2: 14, p3: 7, p4: 7, default: 7 };

// ─── Pylon API helpers ─────────────────────────────────────────────────────────

async function pylonRequest(method, path, body) {
  const res = await fetch(`${PYLON_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PYLON_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Pylon API ${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Fetch all Pylon Issues created within the lookback window.
 * GET /issues does not support server-side tag/keyword filtering —
 * we fetch by time range and filter client-side.
 */
async function fetchIssuesInWindow(startTime, endTime) {
  const issues = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      limit: "20000",
      ...(cursor ? { cursor } : {}),
    });

    const res = await pylonRequest("GET", `/issues?${params}`);
    issues.push(...res.data);
    cursor = res.pagination?.has_next_page ? res.pagination.cursor : null;

    // Respect rate limit: 30 req/min → ~2s between paginated calls
    if (cursor) await sleep(2000);
  } while (cursor);

  return issues;
}

/**
 * Apply tag to a Pylon Issue.
 * PATCH /issues/{id} is a full tag replace — we merge with existing tags.
 */
async function applyTag(issue, newTag) {
  const existingTags = issue.tags ?? [];
  if (existingTags.includes(newTag)) return; // already tagged, skip

  await pylonRequest("PATCH", `/issues/${issue.id}`, {
    tags: [...existingTags, newTag],
  });
  console.log(`Tagged issue ${issue.id} ("${issue.title}") with ${newTag}`);
}

// ─── Keyword matching ──────────────────────────────────────────────────────────

/**
 * Returns true if the issue title or description contains any keyword.
 * Case-insensitive substring match — simple, no ML needed.
 */
function issueMatchesKeywords(issue, keywords) {
  const haystack = `${issue.title ?? ""} ${issue.body ?? ""}`.toLowerCase();
  return keywords.some((kw) => haystack.includes(kw.toLowerCase()));
}

// ─── Slug builder ──────────────────────────────────────────────────────────────

/** "Schedule Layout v1" → "schedule-layout-v1" */
function toSlug(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── Linear webhook verification ──────────────────────────────────────────────

function verifyLinearSignature(rawBody, signature) {
  if (!LINEAR_SECRET) return true; // skip verification if secret not set (dev only)
  const expected = crypto
    .createHmac("sha256", LINEAR_SECRET)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Core handler ─────────────────────────────────────────────────────────────

/**
 * Main logic. Called when Linear fires a webhook for:
 *   - Project state → Done (with p1–p4 label)   → rel-[slug] tag
 *   - Issue labelled "bug-as-designed"           → bug-as-designed tag
 */
async function handleLinearWebhook(payload) {
  const { type, action, data } = payload;

  // ── Track 1: Release project → Done ──────────────────────────────────────
  if (type === "Project" && action === "update" && data?.state === "completed") {
    const title = data.name ?? "";
    const description = data.description ?? "";
    const labels = (data.projectMilestones ?? []).map((l) => l.name?.toLowerCase());

    // Determine priority level from labels
    const pLevel = ["p1", "p2", "p3", "p4"].find((p) => labels.includes(p)) ?? "default";
    const lookbackDays = LOOKBACK_DAYS[pLevel];
    const tag = `rel-${toSlug(title)}`;

    // Extract keywords: title words + description words (3+ chars)
    const keywords = [
      ...title.split(/\s+/),
      ...description.split(/\s+/).filter((w) => w.length >= 3),
    ].filter(Boolean);

    console.log(`Release "${title}" → Done (${pLevel}). Tag: ${tag}. Keywords: ${keywords.join(", ")}`);

    const endTime = new Date();
    const startTime = new Date(endTime - lookbackDays * 86400 * 1000);

    const issues = await fetchIssuesInWindow(startTime, endTime);
    const matched = issues.filter((i) => issueMatchesKeywords(i, keywords));

    console.log(`Found ${matched.length} matching Pylon issues out of ${issues.length} in window.`);

    // Apply tags (respect 120 req/min PATCH limit — batch with small delay)
    for (const issue of matched) {
      await applyTag(issue, tag);
      await sleep(500); // 120 req/min = 2 req/sec max
    }

    return { tagged: matched.length, tag };
  }

  // ── Track 2: Bug-as-designed label applied ───────────────────────────────
  if (type === "IssueLabel" && action === "create" && data?.label?.name === "bug-as-designed") {
    const linearId = data.issue?.identifier ?? data.issue?.id ?? "unknown";
    const title = data.issue?.title ?? "";
    const description = data.issue?.description ?? "";
    const tag = `bug-as-designed-lin-${linearId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

    const keywords = [
      ...title.split(/\s+/),
      ...description.split(/\s+/).filter((w) => w.length >= 3),
    ].filter(Boolean);

    console.log(`Bug-as-designed: "${title}" (${linearId}). Tag: ${tag}`);

    // 60-day lookback for bug-as-designed
    const endTime = new Date();
    const startTime = new Date(endTime - 60 * 86400 * 1000);

    const issues = await fetchIssuesInWindow(startTime, endTime);
    const matched = issues.filter((i) => issueMatchesKeywords(i, keywords));

    console.log(`Found ${matched.length} matching Pylon issues.`);

    for (const issue of matched) {
      await applyTag(issue, "bug-as-designed");
      await applyTag(issue, tag);
      await sleep(500);
    }

    return { tagged: matched.length, tag };
  }

  console.log(`Unhandled webhook: type=${type} action=${action} — skipping.`);
  return { skipped: true };
}

// ─── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook/linear") {
    res.writeHead(404).end("Not found");
    return;
  }

  let rawBody = "";
  req.on("data", (chunk) => (rawBody += chunk));
  req.on("end", async () => {
    try {
      // Verify Linear signature
      const sig = req.headers["linear-signature"] ?? "";
      if (!verifyLinearSignature(rawBody, sig)) {
        console.warn("Invalid Linear signature — rejected.");
        res.writeHead(401).end("Unauthorized");
        return;
      }

      const payload = JSON.parse(rawBody);
      const result = await handleLinearWebhook(payload);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      console.error("Error handling webhook:", err);
      res.writeHead(500).end("Internal error");
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pylon Release Tagger listening on :${PORT}`));

// ─── Utils ─────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
