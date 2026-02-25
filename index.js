import fs from "fs";
import * as cheerio from "cheerio";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const AO3_SEARCH_URL = process.env.AO3_SEARCH_URL;

if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL secret");
if (!AO3_SEARCH_URL) throw new Error("Missing AO3_SEARCH_URL secret");

const STATE_FILE = "./state.json";
const DISCORD_BATCH_THRESHOLD = 2;

const DETAILS_THRESHOLD = 3;

// --- AO3 fetch tuning ---
const MAX_AO3_ATTEMPTS = 4;

// (1) 30s, (2) 60s, (3) 90s, (4) 90s
const AO3_TIMEOUT_BASE_MS = 30_000;
const AO3_TIMEOUT_MAX_MS = 90_000;

const MAX_CONCURRENCY = 2;

const RETRY_BACKOFF_BASE_MS = 1500;

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525]);

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

function workUrl(id) {
  return `https://archiveofourown.org/works/${id}`;
}

function timeoutForAttempt(attempt) {
  // 30s, 60s, 90s, 90s...
  return Math.min(AO3_TIMEOUT_BASE_MS * attempt, AO3_TIMEOUT_MAX_MS);
}

function backoffForAttempt(attempt, extraMs = 0) {
  // 1: 1500-2500ms, 2: 3000-4500ms, 3: 4500-6500ms...
  const jitter = Math.floor(Math.random() * 1000);
  return RETRY_BACKOFF_BASE_MS * attempt + jitter + extraMs;
}

function addCacheBuster(url) {
  const u = new URL(url);
  u.searchParams.set("_", Date.now().toString());
  return u.toString();
}

async function fetchHtml(url) {
  for (let attempt = 1; attempt <= MAX_AO3_ATTEMPTS; attempt++) {
    const timeoutMs = timeoutForAttempt(attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const requestUrl = addCacheBuster(url);

    try {
      const res = await fetch(requestUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache"
        }
      });

      if (res.ok) return await res.text();

      const retryable = RETRYABLE_HTTP.has(res.status);
      const bodySnippet = await res.text().catch(() => "");
      console.error(
        `[AO3] HTTP ${res.status} (attempt ${attempt}/${MAX_AO3_ATTEMPTS}) timeout=${timeoutMs}ms url=${url} body=${bodySnippet.slice(
          0,
          180
        ).replace(/\s+/g, " ")}`
      );

      if (!retryable || attempt === MAX_AO3_ATTEMPTS) {
        throw new Error(`AO3 request failed: ${res.status}`);
      }

      let extra = 0;
      const ra = res.headers.get("retry-after");
      if (ra) {
        const sec = Number(ra);
        if (!Number.isNaN(sec) && sec > 0) extra = sec * 1000;
      }

      await sleep(backoffForAttempt(attempt, extra));
    } catch (e) {
      const name = e?.name || "";
      const isAbort = name === "AbortError" || name === "AbortErrorEvent" || String(e).includes("AbortError");

      console.error(
        `[AO3] ${isAbort ? "TIMEOUT/ABORT" : "ERROR"} (attempt ${attempt}/${MAX_AO3_ATTEMPTS}) timeout=${timeoutMs}ms url=${url} err=${
          e?.message || e
        }`
      );

      if (attempt === MAX_AO3_ATTEMPTS) throw e;

      await sleep(backoffForAttempt(attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("fetchHtml exhausted retries");
}

function extractWorks(html) {
  const $ = cheerio.load(html);
  const works = [];

  $("li.work").each((_, el) => {
    const $el = $(el);

    const link = $el.find("h4.heading a[href^='/works/']").first();
    if (!link.length) return;

    const href = link.attr("href") || "";
    const idMatch = href.match(/\/works\/(\d+)/);
    if (!idMatch) return;

    const title = link.text().trim();

    const author = $el.find("a[rel='author']").first().text().trim() || "Unknown";

    works.push({
      id: idMatch[1],
      title,
      author
    });
  });

  return works;
}

async function fetchChapterOnly(id) {
  const html = await fetchHtml(`https://archiveofourown.org/works/${id}`);
  const $ = cheerio.load(html);

  let chapter = $("dd.chapters").first().text().trim();
  if (chapter.includes("/")) chapter = `Chapter ${chapter.split("/")[0]}`;
  else chapter = "";

  return { chapter };
}

async function postToDiscord(message) {
  const maxAttempts = 5;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message })
    });

    if (res.ok) return;

    if (res.status === 429) {
      // Discord: retry_after viene en segundos
      const data = await res.json().catch(() => ({}));
      const retryAfterSec = Number(data.retry_after);
      const waitMs = (Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 1000) + 200;
      await sleep(waitMs);
      continue;
    }

    const t = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${t}`);
  }

  throw new Error("Discord webhook failed: exhausted retries");
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function buildLine(work, chapter = "") {
  let line = `📚 ${work.title}`;
  if (chapter) line += ` - ${chapter}`;
  line += ` - ${work.author} - ${workUrl(work.id)}`;
  return line;
}

async function main() {
  const state = loadState();

  const searchHtml = await fetchHtml(AO3_SEARCH_URL);
  const works = extractWorks(searchHtml);

  if (works.length === 0) {
    console.log("AO3 notifier: 0 works found (empty results or layout change).");
    return;
  }

  const newest = works[0].id;

  if (!state.lastWorkId) {
    saveState({ lastWorkId: newest });
    console.log(`Initialized state at work ${newest}`);
    return;
  }

  const newWorks = [];
  for (const w of works) {
    if (w.id === state.lastWorkId) break;
    newWorks.push(w);
  }

  if (newWorks.length === 0) {
    saveState({ lastWorkId: newest });
    console.log("No new works since last check.");
    return;
  }

  const ordered = newWorks.reverse();

  const chaptersById = new Map();
  if (ordered.length <= DETAILS_THRESHOLD) {
    const pairs = await mapLimit(ordered, MAX_CONCURRENCY, async (w) => {
      const { chapter } = await fetchChapterOnly(w.id);

      // Respetar un pequeño delay para no martillar AO3
      await sleep(300);

      return [w.id, chapter];
    });

    for (const [id, ch] of pairs) chaptersById.set(id, ch);
  }

  const lines = ordered.map((w) => buildLine(w, chaptersById.get(w.id) || ""));

  // Si hay muchos, mandamos un solo mensaje para evitar rate limits
  if (lines.length > DISCORD_BATCH_THRESHOLD) {
    const message = `📚 New fics on AO3:\n` + lines.map((l) => `- ${l}`).join("\n");
    await postToDiscord(message);
  } else {
    for (const line of lines) {
      await postToDiscord(line);
      await sleep(450);
    }
  }

  saveState({ lastWorkId: newest });
  console.log(`Updated state to work ${newest}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
