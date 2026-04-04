import fs from "fs";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const AO3_SEARCH_URL = process.env.AO3_SEARCH_URL; // HTML (primary)
const AO3_FEED_URL = process.env.AO3_FEED_URL; // Atom (fallback)

// Optional: comma-separated tag names to exclude for Atom fallback
const AO3_EXCLUDE_TAGS = (process.env.AO3_EXCLUDE_TAGS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL secret");

if (!AO3_SEARCH_URL && !AO3_FEED_URL) {
  throw new Error("Missing AO3_SEARCH_URL and AO3_FEED_URL. Provide at least one.");
}

const STATE_FILE = "./state.json";
const DETAILS_THRESHOLD = 3;
const MAX_CONCURRENCY = 2;

// --- Network tuning ---
const MAX_AO3_ATTEMPTS = 4;
const AO3_TIMEOUT_BASE_MS = 30_000;
const AO3_TIMEOUT_MAX_MS = 90_000;
const RETRY_BACKOFF_BASE_MS = 1500;

// Retryable transient errors
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525]);

// Errors that should NOT break the workflow.
// We return null and let caller fallback or skip the run without updating state.
const BLOCKED_HTTP = new Set([401, 403, 418, 525]);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastWorkId: null, lastEntryId: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function timeoutForAttempt(attempt) {
  return Math.min(AO3_TIMEOUT_BASE_MS * attempt, AO3_TIMEOUT_MAX_MS);
}

function backoffForAttempt(attempt, extraMs = 0) {
  const jitter = Math.floor(Math.random() * 1000);
  return RETRY_BACKOFF_BASE_MS * attempt + jitter + extraMs;
}

function workUrl(id) {
  return `https://archiveofourown.org/works/${id}`;
}

function normalizeTag(s) {
  return (s || "").trim().toLowerCase();
}

function shouldExcludeByTags(entryTags) {
  if (!AO3_EXCLUDE_TAGS.length) return false;
  const set = new Set(entryTags.map(normalizeTag));
  for (const t of AO3_EXCLUDE_TAGS) {
    if (set.has(normalizeTag(t))) return true;
  }
  return false;
}

/**
 * Fetch text. Returns:
 * - string: success
 * - null: blocked/unavailable (401/403/418/525) => caller should fallback/skip without updating state
 * Throws on non-retryable errors after retries.
 */
async function fetchText(url, { accept = "text/html" } = {}) {
  for (let attempt = 1; attempt <= MAX_AO3_ATTEMPTS; attempt++) {
    const timeoutMs = timeoutForAttempt(attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: accept,
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });

      if (res.ok) return await res.text();

      const retryable = RETRYABLE_HTTP.has(res.status);
      const blocked = BLOCKED_HTTP.has(res.status);
      const bodySnippet = await res.text().catch(() => "");

      console.error(
        `[AO3] HTTP ${res.status} (attempt ${attempt}/${MAX_AO3_ATTEMPTS}) timeout=${timeoutMs}ms url=${url} body=${bodySnippet
          .slice(0, 180)
          .replace(/\s+/g, " ")}`
      );

      // Do not waste time retrying blocked/unavailable cases inside the same run.
      if (blocked) return null;

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
      const isAbort = name === "AbortError" || String(e).includes("AbortError");

      console.error(
        `[AO3] ${isAbort ? "TIMEOUT/ABORT" : "ERROR"} (attempt ${attempt}/${MAX_AO3_ATTEMPTS}) timeout=${timeoutMs}ms url=${url} err=${e?.message || e}`
      );

      // If we already exhausted retries on network timeout/error, skip run cleanly.
      if (attempt === MAX_AO3_ATTEMPTS) return null;

      await sleep(backoffForAttempt(attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

// ---------------- HTML (primary) ----------------

function extractWorksFromHtml(html) {
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

    works.push({ id: idMatch[1], title, author });
  });

  return works;
}

async function fetchChapterOnly(id) {
  const html = await fetchText(`https://archiveofourown.org/works/${id}`, { accept: "text/html" });
  if (!html) return { chapter: "" };

  const $ = cheerio.load(html);
  let chapter = $("dd.chapters").first().text().trim();
  if (chapter.includes("/")) chapter = `Chapter ${chapter.split("/")[0]}`;
  else chapter = "";
  return { chapter };
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

function buildLineHtml(work, chapter = "") {
  let line = `📚 ${work.title}`;
  if (chapter) line += ` - ${chapter}`;
  line += ` - ${work.author} - ${workUrl(work.id)}`;
  return line;
}

async function runHtmlPrimary(state) {
  if (!AO3_SEARCH_URL) return { handled: false };

  const html = await fetchText(AO3_SEARCH_URL, { accept: "text/html" });
  if (!html) {
    return { handled: false, blocked: true };
  }

  const works = extractWorksFromHtml(html);
  console.log("HTML works:", works.map(w => w.id));

  // If HTML parsing yields nothing, try Atom fallback instead of pretending success.
  if (works.length === 0) {
    console.log("AO3 HTML: 0 works found (empty results, blocked page, or layout change). Falling back to Atom.");
    return { handled: false };
  }

  const newest = works[0].id;

  if (!state.lastWorkId) {
    saveState({ ...state, lastWorkId: newest });
    console.log(`Initialized HTML state at work ${newest}`);
    return { handled: true };
  }

  const newWorks = [];
  for (const w of works) {
    if (w.id === state.lastWorkId) break;
    newWorks.push(w);
  }

  if (newWorks.length === 0) {
    saveState({ ...state, lastWorkId: newest });
    console.log("HTML: No new works since last check.");
    return { handled: true };
  }

  const ordered = newWorks.reverse();
  console.log("HTML will post:", ordered.map(w => w.id));

  const chaptersById = new Map();
  if (ordered.length <= DETAILS_THRESHOLD) {
    const pairs = await mapLimit(ordered, MAX_CONCURRENCY, async (w) => {
      try {
        const { chapter } = await fetchChapterOnly(w.id);
        await sleep(250);
        return [w.id, chapter];
      } catch (e) {
        console.error(`Chapter fetch failed for ${w.id}:`, e?.message || e);
        return [w.id, ""];
      }
    });

    for (const [id, ch] of pairs) chaptersById.set(id, ch);
  }

  const lines = ordered.map((w) => buildLineHtml(w, chaptersById.get(w.id) || ""));
  await postLinesToDiscord(lines);

  saveState({ ...state, lastWorkId: newest });
  console.log(`HTML: Updated state to work ${newest}`);

  return { handled: true };
}

// ---------------- Atom (fallback) ----------------

function looksLikeAtom(xml) {
  const s = String(xml || "").trim().toLowerCase();
  return s.startsWith("<?xml") || s.includes("<feed");
}

function parseAtom(xml) {
  
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });

  const doc = parser.parse(xml);
  const feed = doc.feed;
  if (!feed) return [];

  let entries = feed.entry || [];
  if (!Array.isArray(entries)) entries = [entries];

  return entries.map((e) => {
    const id = String(e.id || "");

    let link = "";
    const links = e.link ? (Array.isArray(e.link) ? e.link : [e.link]) : [];
    const alt = links.find((l) => l["@_rel"] === "alternate") || links[0];
    if (alt?.["@_href"]) link = alt["@_href"];

    const rawTitle = e.title && (typeof e.title === "string" ? e.title : e.title["#text"]);
    const title = String(rawTitle || "Untitled").trim();

    let author = "Unknown";
    if (e.author) {
      const a = Array.isArray(e.author) ? e.author[0] : e.author;
      if (a?.name) author = String(typeof a.name === "string" ? a.name : a.name["#text"] || author).trim();
    }

    const cats = e.category ? (Array.isArray(e.category) ? e.category : [e.category]) : [];
    const tags = cats.map((c) => c?.["@_term"]).filter(Boolean);

    return { id, title, author, link, tags };
  });
}

function buildLineAtom(entry) {
  return `📚 ${entry.title} - ${entry.author} - ${entry.link || "(no link)"}`;
}

async function runAtomFallback(state) {
  if (!AO3_FEED_URL) return { handled: false };

  const xml = await fetchText(AO3_FEED_URL, {
    accept: "application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
  });
  
  if (!xml) {
    console.log("Atom: AO3 blocked/unavailable (401/403/418/525/timeout). Skipping run without updating state.");
    return { handled: true, skipped: true };
  }
  
  // 👇 NUEVO CHECK
  if (!looksLikeAtom(xml)) {
    console.error("Atom: response is not valid XML/Atom. Skipping.");
    return { handled: true, skipped: true };
  }
  
  const entries = parseAtom(xml);
  console.log("ATOM entries:", entries.map(e => e.id));
  
  if (!entries.length) {
    console.log("Atom: 0 entries (empty feed or parse change).");
    return { handled: true };
  }
  const newestId = entries[0].id;

  if (!state.lastEntryId) {
    saveState({ ...state, lastEntryId: newestId });
    console.log(`Initialized Atom state at entry ${newestId}`);
    return { handled: true };
  }

  const fresh = [];
  for (const e of entries) {
    if (e.id === state.lastEntryId) break;
    fresh.push(e);
  }

  if (!fresh.length) {
    saveState({ ...state, lastEntryId: newestId });
    console.log("Atom: No new entries since last check.");
    return { handled: true };
  }

  const filtered = fresh.filter((e) => !shouldExcludeByTags(e.tags));

  if (!filtered.length) {
    saveState({ ...state, lastEntryId: newestId });
    console.log("Atom: New entries existed but were excluded. State updated.");
    return { handled: true };
  }

  const ordered = filtered.reverse();
  console.log("ATOM will post:", ordered.map(e => e.id));
  const lines = ordered.map(buildLineAtom);

  await postLinesToDiscord(lines);

  saveState({ ...state, lastEntryId: newestId });
  console.log(`Atom: Updated state to entry ${newestId}`);

  return { handled: true };
}

// ---------------- Discord ----------------

async function postToDiscord(message) {
  const maxAttempts = 5;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });

    if (res.ok) return;

    if (res.status === 429) {
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

async function postLinesToDiscord(lines) {
  for (const line of lines) {
    await postToDiscord(line);
    await sleep(450);
  }
}

// ---------------- Main ----------------

async function main() {
  const state = loadState();

  // 1) Try HTML primary
  const htmlResult = await runHtmlPrimary(state);
  if (htmlResult.handled) return;

  // 2) Fallback to Atom
  const atomResult = await runAtomFallback(loadState());
  if (atomResult.handled) return;

  console.log("Neither AO3_SEARCH_URL nor AO3_FEED_URL were available to run.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
