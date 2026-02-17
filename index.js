import fs from "fs";
import * as cheerio from "cheerio";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const AO3_SEARCH_URL = process.env.AO3_SEARCH_URL;
const DISCORD_ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE_ID;

if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL secret");
if (!AO3_SEARCH_URL) throw new Error("Missing AO3_SEARCH_URL secret");

const STATE_FILE = "./state.json";
const DISCORD_BATCH_THRESHOLD = 2;

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
  return new Promise(r => setTimeout(r, ms));
}

async function fetchHtml(url) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const u = new URL(url);
    u.searchParams.set("_", Date.now().toString());

    const res = await fetch(u.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 AO3DiscordNotifier",
        "Accept": "text/html"
      }
    });

    if (res.ok) return await res.text();

    const retryable = [429,500,502,503,504,520,521,522,523,524,525].includes(res.status);

    if (!retryable || attempt === maxAttempts)
      throw new Error(`AO3 request failed: ${res.status}`);

    const wait = 2000 * Math.pow(2, attempt - 1);
    await sleep(wait);
  }
}

function extractWorks(html) {
  const $ = cheerio.load(html);
  const works = [];

  $("li.work").each((_, el) => {
    const link = $(el).find("h4.heading a[href^='/works/']").first();
    if (!link.length) return;

    const href = link.attr("href");
    const idMatch = href.match(/\/works\/(\d+)/);
    if (!idMatch) return;

    works.push({
      id: idMatch[1],
      title: link.text().trim()
    });
  });

  return works;
}

async function fetchWorkDetails(id) {
  const html = await fetchHtml(`https://archiveofourown.org/works/${id}`);
  const $ = cheerio.load(html);

  const author =
    $("a[rel='author']").first().text().trim() || "Unknown";

  let chapter = $("dd.chapters").first().text().trim();

  if (chapter.includes("/"))
    chapter = `Chapter ${chapter.split("/")[0]}`;
  else
    chapter = "";

  return { author, chapter };
}

async function postToDiscord(message) {
  const maxAttempts = 5;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        content: message,
        allowed_mentions:{parse:["roles"]}
      })
    });

    if (res.ok) return;

    if (res.status === 429) {
      const data = await res.json();
      await sleep(data.retry_after * 1000 + 100);
      continue;
    }

    throw new Error(`Discord webhook failed: ${res.status}`);
  }
}

function adminPing() {
  return DISCORD_ADMIN_ROLE_ID ? `<@&${DISCORD_ADMIN_ROLE_ID}> ` : "";
}

function workUrl(id) {
  return `https://archiveofourown.org/works/${id}`;
}

async function buildLine(work) {
  const details = await fetchWorkDetails(work.id);

  let line = `📚 ${work.title}`;

  if (details.chapter)
    line += ` - ${details.chapter}`;

  line += ` - ${details.author} - ${workUrl(work.id)}`;

  return line;
}

async function main() {
  const state = loadState();

  const html = await fetchHtml(AO3_SEARCH_URL);
  const works = extractWorks(html);

  if (works.length === 0) {
    await postToDiscord(
      `${adminPing()}⚠️ AO3 notifier ran but found 0 works`
    );
    return;
  }

  const newest = works[0].id;

  if (!state.lastWorkId) {
    saveState({ lastWorkId:newest });
    return;
  }

  const newWorks = [];

  for (const w of works) {
    if (w.id === state.lastWorkId) break;
    newWorks.push(w);
  }

  if (newWorks.length === 0) {
    saveState({ lastWorkId:newest });
    return;
  }

  const ordered = newWorks.reverse();

  if (ordered.length > DISCORD_BATCH_THRESHOLD) {

    const lines = [];

    for (const w of ordered) {
      lines.push(await buildLine(w));
      await sleep(300);
    }

    const message =
      `📚 New fics on AO3:\n` +
      lines.map(l => `- ${l}`).join("\n");

    await postToDiscord(message);

  } else {

    for (const w of ordered) {
      const line = await buildLine(w);
      await postToDiscord(line);
      await sleep(400);
    }

  }

  saveState({ lastWorkId:newest });
}

main().catch(console.error);
