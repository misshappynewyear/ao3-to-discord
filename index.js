import fs from "fs";
import * as cheerio from "cheerio";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const AO3_SEARCH_URL = process.env.AO3_SEARCH_URL;
const DISCORD_ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE_ID; // optional

if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL secret");
if (!AO3_SEARCH_URL) throw new Error("Missing AO3_SEARCH_URL secret");

const STATE_FILE = "./state.json";

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

// More specific selector for AO3 works listing
function extractWorkIds(html) {
  const $ = cheerio.load(html);

  const ids = [];
  const seen = new Set();

  $("li.work a[href^='/works/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/works\/(\d+)/);
    if (m) {
      const id = m[1];
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  });

  return ids;
}

async function postToDiscord(message) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: message,
      allowed_mentions: { parse: ["roles"] }, // allow <@&ROLE_ID> mentions
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${t}`);
  }
}

function workUrl(id) {
  return `https://archiveofourown.org/works/${id}`;
}

function adminPingPrefix() {
  return DISCORD_ADMIN_ROLE_ID ? `<@&${DISCORD_ADMIN_ROLE_ID}> ` : "";
}

async function main() {
  const state = loadState();

  const html = await fetchHtml(AO3_SEARCH_URL);
  const ids = extractWorkIds(html);

  // If we cannot parse any work IDs, notify admins (only this special case as requested)
  if (ids.length === 0) {
    console.log("No work IDs found (layout change or empty results).");
    await postToDiscord(
      `${adminPingPrefix()}⚠️ AO3 notifier ran but found 0 works. The page layout may have changed, results may be empty, or the parser needs updating.`
    );
    return;
  }

  const newest = ids[0];

  // First run: initialize only (no spam)
  if (!state.lastWorkId) {
    saveState({ lastWorkId: newest });
    console.log(`Initialized state at work ${newest}`);
    return;
  }

  // Collect new IDs until we reach the last seen
  const newOnes = [];
  for (const id of ids) {
    if (id === state.lastWorkId) break;
    newOnes.push(id);
  }

  if (newOnes.length === 0) {
    console.log("No new works since last check.");
    // Keep state synced to the newest (helps in case of reordering)
    saveState({ lastWorkId: newest });
    return;
  }

  // Post oldest -> newest
  for (const id of newOnes.reverse()) {
    await postToDiscord(`📚 Nuevo en AO3 (según tu búsqueda): ${workUrl(id)}`);
  }

  saveState({ lastWorkId: newest });
  console.log(`Updated state to work ${newest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
