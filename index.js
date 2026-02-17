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

async function fetchHtml(url) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const u = new URL(url);
    u.searchParams.set("_", Date.now().toString());

    const res = await fetch(u.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AO3DiscordNotifier/1.0)",
        "Accept": "text/html,application/xhtml+xml",
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


// NEW: extract id + title together
function extractWorks(html) {
  const $ = cheerio.load(html);

  const works = [];
  const seen = new Set();

  $("li.work").each((_, el) => {
    const link = $(el).find("h4.heading a[href^='/works/']").first();

    if (!link.length) return;

    const href = link.attr("href");
    const title = link.text().trim();

    const m = href.match(/\/works\/(\d+)/);
    if (!m) return;

    const id = m[1];

    if (!seen.has(id)) {
      seen.add(id);
      works.push({
        id,
        title
      });
    }
  });

  return works;
}

async function postToDiscord(message) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: message,
      allowed_mentions: { parse: ["roles"] },
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
  const works = extractWorks(html);

  if (works.length === 0) {
    console.log("No works found.");
    await postToDiscord(
      `${adminPingPrefix()}⚠️ AO3 notifier ran but found 0 works. Parser may need updating.`
    );
    return;
  }

  const newest = works[0].id;

  if (!state.lastWorkId) {
    saveState({ lastWorkId: newest });
    console.log(`Initialized state at work ${newest}`);
    return;
  }

  const newWorks = [];

  for (const work of works) {
    if (work.id === state.lastWorkId) break;
    newWorks.push(work);
  }

  if (newWorks.length === 0) {
    console.log("No new works.");
    saveState({ lastWorkId: newest });
    return;
  }

  for (const work of newWorks.reverse()) {
    await postToDiscord(
      `📚 New fic on AO3. ${work.title} - ${workUrl(work.id)}`
    );
  }

  saveState({ lastWorkId: newest});
  console.log(`Updated state to ${newest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
