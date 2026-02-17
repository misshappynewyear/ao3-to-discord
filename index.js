import fs from "fs";
import * as cheerio from "cheerio";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const AO3_SEARCH_URL = process.env.AO3_SEARCH_URL;

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

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AO3DiscordNotifier/1.0)"
    }
  });
  if (!res.ok) throw new Error(`AO3 request failed: ${res.status}`);
  return await res.text();
}

function extractWorkIds(html) {
  const $ = cheerio.load(html);

  const ids = [];
  const seen = new Set();

  $("a[href*='/works/']").each((_, el) => {
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
    body: JSON.stringify({ content: message })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${t}`);
  }
}

function workUrl(id) {
  return `https://archiveofourown.org/works/${id}`;
}

async function main() {
  const state = loadState();

  const html = await fetchHtml(AO3_SEARCH_URL);
  const ids = extractWorkIds(html);

  if (ids.length === 0) {
    console.log("No work IDs found (layout change or empty results).");
    return;
  }

  const newest = ids[0];

  if (!state.lastWorkId) {
    saveState({ lastWorkId: newest });
    console.log(`Initialized state at work ${newest}`);
    return;
  }

  // Juntar IDs nuevos hasta encontrar el último visto
  const newOnes = [];
  for (const id of ids) {
    if (id === state.lastWorkId) break;
    newOnes.push(id);
  }

  if (newOnes.length === 0) {
    console.log("No new works since last check.");
    return;
  }

  for (const id of newOnes.reverse()) {
    await postToDiscord(`📚 Nuevo en AO3 (según tu búsqueda): ${workUrl(id)}`);
  }

  saveState({ lastWorkId: newest });
  console.log(`Updated state to work ${newest}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
