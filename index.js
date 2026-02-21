import fs from "fs";
import * as cheerio from "cheerio";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const AO3_SEARCH_URL = process.env.AO3_SEARCH_URL;

if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL secret");
if (!AO3_SEARCH_URL) throw new Error("Missing AO3_SEARCH_URL secret");

const STATE_FILE = "./state.json";
const DISCORD_BATCH_THRESHOLD = 2;

// Solo buscamos "capítulo" en /works/{id} si hay pocos fics nuevos.
// Si hay muchos, evitamos requests extra a AO3 para que no tarde minutos.
const DETAILS_THRESHOLD = 3;

// Timeout duro por request a AO3 (evita colgadas largas)
const AO3_TIMEOUT_MS = 20000;
const MAX_AO3_ATTEMPTS = 4;
const MAX_CONCURRENCY = 2;

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

function workUrl(id) {
  return `https://archiveofourown.org/works/${id}`;
}

async function fetchHtml(url, { timeoutMs = AO3_TIMEOUT_MS } = {}) {
  for (let attempt = 1; attempt <= MAX_AO3_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const u = new URL(url);
      u.searchParams.set("_", Date.now().toString());

      const res = await fetch(u.toString(), {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 AO3DiscordNotifier",
          "Accept": "text/html",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });

      if (res.ok) return await res.text();

      const retryable = [429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525].includes(res.status);
      if (!retryable || attempt === MAX_AO3_ATTEMPTS) {
        throw new Error(`AO3 request failed: ${res.status}`);
      }

      await sleep(1500 * attempt);
    } catch (e) {
      if (attempt === MAX_AO3_ATTEMPTS) throw e;
      await sleep(1500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
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

    // El autor suele estar en el listado de resultados (evita requests extra)
    const author =
      $el.find("a[rel='author']").first().text().trim() ||
      "Unknown";

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
      const data = await res.json();
      await sleep(data.retry_after * 1000 + 150);
      continue;
    }

    const t = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${t}`);
  }
}

// Concurrency limiter simple
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

  // Primer run: solo inicializa state, no postea nada
  if (!state.lastWorkId) {
    saveState({ lastWorkId: newest });
    console.log(`Initialized state at work ${newest}`);
    return;
  }

  // Junta nuevos hasta encontrar el último visto
  const newWorks = [];
  for (const w of works) {
    if (w.id === state.lastWorkId) break;
    newWorks.push(w);
  }

  // Siempre actualizamos state al "newest" aunque no haya nuevos,
  // porque la lista está ordenada por updated/revised_at.
  if (newWorks.length === 0) {
    saveState({ lastWorkId: newest });
    console.log("No new works since last check.");
    return;
  }

  const ordered = newWorks.reverse();

  // Buscar capítulo solo si hay pocos (evita runs lentos)
  const chaptersById = new Map();
  if (ordered.length <= DETAILS_THRESHOLD) {
    const pairs = await mapLimit(
      ordered,
      MAX_CONCURRENCY,
      async (w) => {
        const { chapter } = await fetchChapterOnly(w.id);
        await sleep(250);
        return [w.id, chapter];
      }
    );
    for (const [id, ch] of pairs) chaptersById.set(id, ch);
  }

  const lines = ordered.map(w => buildLine(w, chaptersById.get(w.id) || ""));

  // Si hay muchos, mandamos un solo mensaje para evitar rate limits
  if (lines.length > DISCORD_BATCH_THRESHOLD) {
    const message =
      `📚 New fics on AO3:\n` +
      lines.map(l => `- ${l}`).join("\n");

    await postToDiscord(message);
  } else {
    for (const line of lines) {
      await postToDiscord(line);
      await sleep(400);
    }
  }

  saveState({ lastWorkId: newest });
  console.log(`Updated state to work ${newest}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
