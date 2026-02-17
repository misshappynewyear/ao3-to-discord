import fs from "fs";
import * as cheerio from "cheerio";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const AO3_SEARCH_URL = process.env.AO3_SEARCH_URL;
const DISCORD_ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE_ID; // optional

if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL secret");
if (!AO3_SEARCH_URL) throw new Error("Missing AO3_SEARCH_URL secret");

const STATE_FILE = "./state.json";

// Tuneables
const DISCORD_BATCH_THRESHOLD = 2; // if > 2 new works, send one batched message
const DISCORD_MAX_LINES_PER_MESSAGE = 35; // avoid overly long messages

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastWorkId: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetch HTML with retries/backoff to reduce intermittent Cloudflare/GitHub runner issues (e.g., 525)
async function fetchHtml(url) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const u = new URL(url);
    u.searchParams.set("_", Date.now().toString()); // cache buster

    const res = await fetch(u.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AO3DiscordNotifier/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (res.ok) return await res.text();

    const retryable = [429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525].includes(res.status);
    if (!retryable || attempt === maxAttempts) {
      throw new Error(`AO3 request failed: ${res.status}`);
    }

    const waitMs = 2000 * Math.pow(2, attempt - 1);
    console.log(`AO3 returned ${res.status}. Retry ${attempt}/${maxAttempts} in ${waitMs}ms...`);
    await sleep(waitMs);
  }

  throw new Error("AO3 request failed after retries");
}

// Extract works from AO3 search list: id + title
function extractWorks(html) {
  const $ = cheerio.load(html);

  const works = [];
  const seen = new Set();

  $("li.work").each((_, el) => {
    const link = $(el).find("h4.heading a[href^='/works/']").first();
    if (!link.length) return;

    const href = link.attr("href") || "";
    const m = href.match(/\/works\/(\d+)/);
    if (!m) return;

    const id = m[1];
    if (seen.has(id)) return;

    const title = link.text().trim() || "Untitled";
    seen.add(id);
    works.push({ id, title });
  });

  return works;
}

async function postToDiscord(message) {
  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: message,
        allowed_mentions: { parse: ["roles"] }, // allow <@&ROLE_ID>
      }),
    });

    if (res.ok) return;

    const text = await res.text();

    if (res.status === 429) {
      let retryAfterSec = 1;
      try {
        const data = JSON.parse(text);
        retryAfterSec = Number(data.retry_after) || 1;
      } catch {
        // ignore
      }
      const waitMs = Math.ceil(retryAfterSec * 1000) + 150;
      console.log(`Discord rate limited. Wait ${waitMs}ms (attempt ${attempt}/${maxAttempts})...`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Discord webhook failed: ${res.status} ${text}`);
  }

  throw new Error("Discord webhook failed: too many rate limits");
}

function workUrl(id) {
  return `https://archiveofourown.org/works/${id}`;
}

function adminPingPrefix() {
  return DISCORD_ADMIN_ROLE_ID ? `<@&${DISCORD_ADMIN_ROLE_ID}> ` : "";
}

// Build one or more batched messages (splits if too many lines)
function buildBatchedMessages(newWorksOldestFirst) {
  const lines = newWorksOldestFirst.map((w) => `- ${w.title} — ${workUrl(w.id)}`);

  const chunks = [];
  for (let i = 0; i < lines.length; i += DISCORD_MAX_LINES_PER_MESSAGE) {
    chunks.push(lines.slice(i, i + DISCORD_MAX_LINES_PER_MESSAGE));
  }

  return chunks.map((chunk, idx) => {
    const header =
      chunks.length === 1
        ? `📚 New fics on AO3:\n`
        : `📚 New fics on AO3 (part ${idx + 1}/${chunks.length}):\n`;
    return header + chunk.join("\n");
  });
}

async function main() {
  const state = loadState();

  const html = await fetchHtml(AO3_SEARCH_URL);
  const works = extractWorks(html);

  // If we cannot parse any works, notify admins (only this special case)
  if (works.length === 0) {
    console.log("No works found (layout change or empty results).");
    await postToDiscord(
      `${adminPingPrefix()}⚠️ AO3 notifier ran but found 0 works. The page layout may have changed, results may be empty, or the parser needs updating.`
    );
    return;
  }

  const newest = works[0].id;

  // First run: initialize only (no spam)
  if (!state.lastWorkId) {
    saveState({ lastWorkId: newest });
    console.log(`Initialized state at work ${newest}`);
    return;
  }

  // Collect new works (newest -> oldest) until last seen
  const newWorks = [];
  for (const w of works) {
    if (w.id === state.lastWorkId) break;
    newWorks.push(w);
  }

  if (newWorks.length === 0) {
    console.log("No new works since last check.");
    // Keep state synced to newest (helps in case of reordering)
    saveState({ lastWorkId: newest });
    return;
  }

  // Send notifications
  // We want oldest -> newest in the post
  const newWorksOldestFirst = newWorks.reverse();

  if (newWorksOldestFirst.length > DISCORD_BATCH_THRESHOLD) {
    const messages = buildBatchedMessages(newWorksOldestFirst);
    for (const msg of messages) {
      await postToDiscord(msg);
      await sleep(350); // small spacing
    }
  } else {
    // small amount: individual messages (still safe with rate-limit handling)
    for (const w of newWorksOldestFirst) {
      await postToDiscord(`📚 New fic on AO3. ${w.title} - ${workUrl(w.id)}`);
      await sleep(350);
    }
  }

  saveState({ lastWorkId: newest });
  console.log(`Updated state to work ${newest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
