import fs from "fs";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const COBY_WEBHOOK_URL = process.env.COBY_WEBHOOK_URL;
const AO3_SEARCH_URL = process.env.AO3_SEARCH_URL; // HTML (primary)
const AO3_FEED_URL = process.env.AO3_FEED_URL; // Atom (fallback)
const AO3_EXCLUDE_TAGS = (process.env.AO3_EXCLUDE_TAGS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL secret");

if (!AO3_SEARCH_URL && !AO3_FEED_URL) {
  throw new Error("Missing AO3_SEARCH_URL and AO3_FEED_URL. Provide at least one.");
}

const STATE_FILE = "./state.json";
const RUN_STATUS_FILE = "./run_status.json";
const DETAILS_THRESHOLD = 3;
const MAX_CONCURRENCY = 2;
const GITHUB_RUN_ID = String(process.env.GITHUB_RUN_ID || "").trim();
const GITHUB_RUN_ATTEMPT = Number(process.env.GITHUB_RUN_ATTEMPT || 0);
const FAILURE_ALERT_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const MAX_AO3_ATTEMPTS = 4;
const AO3_TIMEOUT_BASE_MS = 30_000;
const AO3_TIMEOUT_MAX_MS = 90_000;
const RETRY_BACKOFF_BASE_MS = 1500;

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525]);
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

function loadRunStatus() {
  try {
    return JSON.parse(fs.readFileSync(RUN_STATUS_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveRunStatus(status) {
  fs.writeFileSync(RUN_STATUS_FILE, JSON.stringify(status, null, 2));
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

function isHtmlLike(text) {
  const s = String(text || "").trim().toLowerCase();
  return (
    s.startsWith("<!doctype html") ||
    s.startsWith("<html") ||
    s.includes("<head") ||
    s.includes("<body")
  );
}

function looksLikeXml(text) {
  const s = String(text || "").trim();
  return s.startsWith("<?xml") || s.startsWith("<feed") || s.startsWith("<rss");
}

function looksLikeAtom(xml) {
  const s = String(xml || "").trim().toLowerCase();
  return s.startsWith("<?xml") || s.includes("<feed");
}

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

      const contentType = res.headers.get("content-type") || "";
      const text = await res.text().catch(() => "");

      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          text,
          contentType,
        };
      }

      const retryable = RETRYABLE_HTTP.has(res.status);
      const blocked = BLOCKED_HTTP.has(res.status);

      console.error(
        `[AO3] HTTP ${res.status} (attempt ${attempt}/${MAX_AO3_ATTEMPTS}) timeout=${timeoutMs}ms url=${url} contentType=${contentType} body=${text
          .slice(0, 180)
          .replace(/\s+/g, " ")}`
      );

      if (blocked) {
        return {
          ok: false,
          status: res.status,
          text,
          contentType,
          blocked: true,
          skipped: true,
        };
      }

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

      if (attempt === MAX_AO3_ATTEMPTS) {
        return {
          ok: false,
          status: null,
          text: null,
          contentType: "",
          skipped: true,
        };
      }

      await sleep(backoffForAttempt(attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    status: null,
    text: null,
    contentType: "",
    skipped: true,
  };
}

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
  const result = await fetchText(`https://archiveofourown.org/works/${id}`, { accept: "text/html" });
  if (!result.ok || !result.text) return { chapter: "" };

  const $ = cheerio.load(result.text);
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

  const result = await fetchText(AO3_SEARCH_URL, { accept: "text/html" });

  if (!result.ok || !result.text) {
    console.log("HTML: AO3 unavailable/blocked. Falling back to Atom.");
    return { handled: false, blocked: true };
  }

  if (isHtmlLike(result.text) === false && !String(result.contentType).includes("html")) {
    console.log(`HTML: unexpected content-type=${result.contentType}. Falling back to Atom.`);
    return { handled: false };
  }

  const works = extractWorksFromHtml(result.text);
  console.log("HTML works:", works.map((w) => w.id));

  if (works.length === 0) {
    console.log("AO3 HTML: 0 works found (empty results, blocked page, or layout change). Falling back to Atom.");
    return { handled: false };
  }

  const newest = works[0].id;

  if (!state.lastWorkId) {
    saveState({ ...state, lastWorkId: newest });
    console.log(`Initialized HTML state at work ${newest}`);
    return { handled: true, modeUsed: "html", postedCount: 0, skipped: false };
  }

  const newWorks = [];
  for (const w of works) {
    if (w.id === state.lastWorkId) break;
    newWorks.push(w);
  }

  if (newWorks.length === 0) {
    saveState({ ...state, lastWorkId: newest });
    console.log("HTML: No new works since last check.");
    return { handled: true, modeUsed: "html", postedCount: 0, skipped: false };
  }

  const ordered = newWorks.reverse();
  console.log("HTML will post:", ordered.map((w) => w.id));

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

  return {
    handled: true,
    modeUsed: "html",
    postedCount: lines.length,
    postedSomething: lines.length > 0,
    skipped: false
  };
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

  const result = await fetchText(AO3_FEED_URL, {
    accept: "application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
  });

  if (!result.ok || !result.text) {
    console.log("Atom: AO3 blocked/unavailable (401/403/418/525/timeout). Skipping run without updating state.");
    return { handled: true, skipped: true, modeUsed: "atom", postedCount: 0 };
  }

  const xml = result.text;
  const contentType = result.contentType || "";

  if (isHtmlLike(xml)) {
    console.error(`Atom: received HTML instead of XML. content-type=${contentType}. Skipping.`);
    console.error(xml.slice(0, 300).replace(/\s+/g, " "));
    return { handled: true, skipped: true, modeUsed: "atom", postedCount: 0 };
  }

  if (
    !contentType.includes("xml") &&
    !contentType.includes("atom") &&
    !looksLikeXml(xml) &&
    !looksLikeAtom(xml)
  ) {
    console.error(`Atom: response is not valid XML/Atom. content-type=${contentType}. Skipping.`);
    console.error(xml.slice(0, 300).replace(/\s+/g, " "));
    return { handled: true, skipped: true, modeUsed: "atom", postedCount: 0 };
  }

  let entries;
  try {
    entries = parseAtom(xml);
  } catch (err) {
    console.error(`Atom: parse failed. Skipping. err=${err?.message || err}`);
    console.error(xml.slice(0, 300).replace(/\s+/g, " "));
    return { handled: true, skipped: true, modeUsed: "atom", postedCount: 0 };
  }

  console.log("ATOM entries:", entries.map((e) => e.id));

  if (!entries.length) {
    console.log("Atom: 0 entries (empty feed or parse change).");
    return { handled: true, modeUsed: "atom", postedCount: 0, skipped: false };
  }

  const newestId = entries[0].id;

  if (!state.lastEntryId) {
    saveState({ ...state, lastEntryId: newestId });
    console.log(`Initialized Atom state at entry ${newestId}`);
    return { handled: true, modeUsed: "atom", postedCount: 0, skipped: false };
  }

  const fresh = [];
  for (const e of entries) {
    if (e.id === state.lastEntryId) break;
    fresh.push(e);
  }

  if (!fresh.length) {
    saveState({ ...state, lastEntryId: newestId });
    console.log("Atom: No new entries since last check.");
    return { handled: true, modeUsed: "atom", postedCount: 0, skipped: false };
  }

  const filtered = fresh.filter((e) => !shouldExcludeByTags(e.tags));

  if (!filtered.length) {
    saveState({ ...state, lastEntryId: newestId });
    console.log("Atom: New entries existed but were excluded. State updated.");
    return { handled: true, modeUsed: "atom", postedCount: 0, skipped: false };
  }

  const ordered = filtered.reverse();
  console.log("ATOM will post:", ordered.map((e) => e.id));
  const lines = ordered.map(buildLineAtom);

  await postLinesToDiscord(lines);

  saveState({ ...state, lastEntryId: newestId });
  console.log(`Atom: Updated state to entry ${newestId}`);

  return {
    handled: true,
    modeUsed: "atom",
    postedCount: lines.length,
    postedSomething: lines.length > 0,
    skipped: false
  };
}

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

async function sendCobyAlert(content) {
  if (!COBY_WEBHOOK_URL) {
    console.warn("Missing COBY_WEBHOOK_URL. Skipping Coby alert.");
    return;
  }

  const response = await fetch(COBY_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Coby webhook error: ${response.status} - ${text}`);
  }
}

function buildAo3ContinuousFailureAlert(errorMessage, startedAtIso) {
  const startedAt = String(startedAtIso || "").trim() || "an unknown time";
  const safeError = String(errorMessage || "Unknown error").trim() || "Unknown error";

  return [
    "CAPTAINS! The AO3 to Discord service has been failing for over 24 hours now...",
    `It started failing around: ${startedAt}`,
    "It says:",
    `> ${safeError}`,
    "THIS CAN'T BE HAPPENING... I HAVEN'T EVEN FINISHED READING THE FIC YET...",
    "P-please check what broke before the next chapter disappears too...!"
  ].join("\n");
}

function buildSuccessRunStatus(result) {
  return {
    runId: GITHUB_RUN_ID,
    runAttempt: GITHUB_RUN_ATTEMPT,
    finishedAt: new Date().toISOString(),
    success: true,
    skipped: result?.skipped === true,
    postedSomething: result?.postedSomething === true,
    postedCount: Number(result?.postedCount || 0),
    modeUsed: String(result?.modeUsed || "").trim(),
    failureStreakStartedAt: "",
    failureAlertedAt: ""
  };
}

function buildFailureRunStatus(previousRunStatus, error) {
  const nowIso = new Date().toISOString();
  const previousFailed = previousRunStatus?.success === false;
  const failureStreakStartedAt = previousFailed && previousRunStatus?.failureStreakStartedAt
    ? String(previousRunStatus.failureStreakStartedAt)
    : nowIso;
  const failureAlertedAt = previousFailed && previousRunStatus?.failureAlertedAt
    ? String(previousRunStatus.failureAlertedAt)
    : "";

  return {
    runId: GITHUB_RUN_ID,
    runAttempt: GITHUB_RUN_ATTEMPT,
    finishedAt: nowIso,
    success: false,
    skipped: false,
    postedSomething: false,
    postedCount: 0,
    modeUsed: "",
    error: String(error?.message || error),
    failureStreakStartedAt,
    failureAlertedAt
  };
}

async function maybeAlertContinuousFailure(runStatus) {
  const startedAtValue = String(runStatus?.failureStreakStartedAt || "").trim();
  const alertedAtValue = String(runStatus?.failureAlertedAt || "").trim();

  if (!startedAtValue || alertedAtValue) {
    return runStatus;
  }

  const startedAtMs = Date.parse(startedAtValue);
  if (!Number.isFinite(startedAtMs)) {
    return runStatus;
  }

  const durationMs = Date.now() - startedAtMs;
  if (durationMs < FAILURE_ALERT_THRESHOLD_MS) {
    return runStatus;
  }

  await sendCobyAlert(
    buildAo3ContinuousFailureAlert(runStatus.error, runStatus.failureStreakStartedAt)
  );

  return {
    ...runStatus,
    failureAlertedAt: new Date().toISOString()
  };
}

async function main() {
  const state = loadState();

  const htmlResult = await runHtmlPrimary(state);
  if (htmlResult.handled) {
    saveRunStatus(buildSuccessRunStatus(htmlResult));
    return;
  }

  const atomResult = await runAtomFallback(loadState());
  if (atomResult.handled) {
    saveRunStatus(buildSuccessRunStatus(atomResult));
    return;
  }

  const finalStatus = {
    runId: GITHUB_RUN_ID,
    runAttempt: GITHUB_RUN_ATTEMPT,
    finishedAt: new Date().toISOString(),
    success: true,
    skipped: true,
    postedSomething: false,
    postedCount: 0,
    modeUsed: "",
    failureStreakStartedAt: "",
    failureAlertedAt: ""
  };
  saveRunStatus(finalStatus);
  console.log("Neither AO3_SEARCH_URL nor AO3_FEED_URL were available to run.");
}

main().catch(async (err) => {
  try {
    const previousRunStatus = loadRunStatus();
    const failedRunStatus = buildFailureRunStatus(previousRunStatus, err);
    const finalRunStatus = await maybeAlertContinuousFailure(failedRunStatus);
    saveRunStatus(finalRunStatus);
  } catch (alertErr) {
    console.error("Failed sending AO3 continuous failure alert", alertErr);
  }

  console.error(err);
  process.exit(1);
});
