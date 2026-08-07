/**
 * XForge — Fetch Fresh Signals from public sources.
 * Sources: Reddit JSON + Hacker News (Algolia API)
 * Run by GitHub Actions every 9 hours.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const SUBREDDITS = ["entrepreneur", "SaaS", "indiehackers", "smallbusiness"];

const HN_QUERIES = [
  "startup growth",
  "SaaS",
  "indie hacker",
  "twitter marketing",
  "bootstrapped",
  "side project",
];

const USER_AGENT =
  "XForgeSignalBot/1.0 (public research aggregator; +https://github.com)";
const OUT_PATH = path.join(__dirname, "..", "data", "signals.json");
const MAX_SIGNALS = 30;
const MIN_REDDIT_SCORE = 10;
const MAX_AGE_DAYS = 21;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchJson(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRecent(unixSec) {
  if (!unixSec) return false;
  const ageMs = Date.now() - unixSec * 1000;
  return ageMs >= 0 && ageMs <= MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&rsquo;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

function cleanExcerpt(text, max = 220) {
  if (!text) return "Open the discussion for full context and comments.";
  const clean = decodeEntities(String(text))
    .replace(/<\/?em>/gi, "")
    .replace(/<\/?p>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  if (!clean) return "Open the discussion for full context and comments.";
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function extractTags(title, body = "") {
  const text = `${title} ${body}`.toLowerCase();
  const pairs = [
    ["saas", "saas"],
    ["growth", "growth"],
    ["marketing", "marketing"],
    ["ai ", "ai"],
    ["startup", "startup"],
    ["indie", "indie"],
    ["monetiz", "monetization"],
    ["content", "content"],
    ["twitter", "x"],
    [" x ", "x"],
    ["audience", "audience"],
    ["niche", "niche"],
    ["validat", "validation"],
    ["b2b", "b2b"],
    ["bootstrap", "bootstrap"],
    ["product", "product"],
    ["founder", "founder"],
    ["sales", "sales"],
    ["outreach", "outreach"],
  ];
  const tags = [];
  for (const [needle, tag] of pairs) {
    if (text.includes(needle) && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= 3) break;
  }
  if (!tags.length) tags.push("discussion");
  return tags;
}

function qualityScore({ score = 0, comments = 0, title = "" }) {
  const titleLen = title.length;
  let q = Math.min(100, Math.round(score * 0.06 + comments * 0.2 + 25));
  if (titleLen > 35 && titleLen < 140) q += 6;
  if (score > 80) q += 8;
  if (comments > 25) q += 6;
  return Math.min(99, Math.max(42, q));
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchSubreddit(name) {
  // Free public JSON only — no API keys. Try www, then old.reddit fallback (CI-friendly).
  const urls = [
    `https://www.reddit.com/r/${name}/hot.json?limit=30&raw_json=1`,
    `https://old.reddit.com/r/${name}/hot.json?limit=30&raw_json=1`,
  ];
  let data = null;
  let lastErr = null;
  for (const url of urls) {
    try {
      data = await fetchJson(url);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!data) throw lastErr || new Error(`Reddit fetch failed for r/${name}`);

  const children = (data && data.data && data.data.children) || [];
  return children
    .map((c) => c.data)
    .filter(
      (p) =>
        p &&
        !p.stickied &&
        !p.over_18 &&
        (p.score || 0) >= MIN_REDDIT_SCORE &&
        p.title &&
        p.permalink &&
        isRecent(p.created_utc)
    )
    .map((p) => {
      const link = safeUrl(`https://www.reddit.com${p.permalink}`);
      if (!link) return null;
      return {
        id: `reddit-${p.id}`,
        title: decodeEntities(p.title.trim()),
        excerpt: cleanExcerpt(p.selftext || p.title),
        source: "reddit",
        subreddit: `r/${p.subreddit || name}`,
        score: p.score || 0,
        comments: p.num_comments || 0,
        url: link,
        createdUtc: p.created_utc || Math.floor(Date.now() / 1000),
        tags: extractTags(p.title, p.selftext),
        quality: qualityScore({
          score: p.score,
          comments: p.num_comments,
          title: p.title,
        }),
      };
    })
    .filter(Boolean);
}

async function fetchHackerNews() {
  const all = [];
  const numericFilters = `created_at_i>${Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 86400}`;

  for (const q of HN_QUERIES) {
    const url =
      "https://hn.algolia.com/api/v1/search?" +
      new URLSearchParams({
        query: q,
        tags: "story",
        hitsPerPage: "12",
        numericFilters,
      }).toString();

    try {
      const data = await fetchJson(url);
      const hits = data.hits || [];
      for (const h of hits) {
        if (!h || !h.title || !h.objectID) continue;
        const points = h.points || 0;
        const comments = h.num_comments || 0;
        if (points < 5 && comments < 3) continue;

        // Prefer discussion page (never dead); external url is secondary
        const discussion = safeUrl(`https://news.ycombinator.com/item?id=${h.objectID}`);
        if (!discussion) continue;

        const created = h.created_at_i || Math.floor(Date.now() / 1000);
        if (!isRecent(created)) continue;

        all.push({
          id: `hn-${h.objectID}`,
          title: decodeEntities(h.title.trim()),
          excerpt: cleanExcerpt(
            h.story_text ||
              h._highlightResult?.title?.value?.replace(/<\/?em>/g, "") ||
              `Hacker News discussion · ${points} points · ${comments} comments`
          ),
          source: "hackernews",
          subreddit: "HN",
          score: points,
          comments,
          url: discussion,
          externalUrl: h.url ? safeUrl(h.url) : null,
          createdUtc: created,
          tags: extractTags(h.title, q),
          quality: qualityScore({ score: points, comments, title: h.title }),
        });
      }
      await sleep(400);
    } catch (err) {
      console.warn(`HN query failed (${q}):`, err.message);
    }
  }
  return all;
}

async function main() {
  const all = [];

  for (const sub of SUBREDDITS) {
    try {
      console.log(`Fetching r/${sub}...`);
      const posts = await fetchSubreddit(sub);
      console.log(`  → ${posts.length} posts`);
      all.push(...posts);
      await sleep(1200);
    } catch (err) {
      console.warn(`Failed r/${sub}:`, err.message);
    }
  }

  try {
    console.log("Fetching Hacker News (Algolia)...");
    const hn = await fetchHackerNews();
    console.log(`  → ${hn.length} stories`);
    all.push(...hn);
  } catch (err) {
    console.warn("HN fetch failed:", err.message);
  }

  // Deduplicate by id + similar titles
  const byId = new Map();
  for (const s of all) {
    if (!s.url || !s.title) continue;
    if (!byId.has(s.id) || byId.get(s.id).quality < s.quality) {
      byId.set(s.id, s);
    }
  }

  const seenTitles = new Set();
  const ranked = [...byId.values()]
    .sort((a, b) => {
      const sa = a.quality * Math.log10((a.score || 1) + 10) + (a.comments || 0) * 0.12;
      const sb = b.quality * Math.log10((b.score || 1) + 10) + (b.comments || 0) * 0.12;
      return sb - sa;
    })
    .filter((s) => {
      const key = s.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    })
    .slice(0, MAX_SIGNALS);

  let payload;
  if (ranked.length < 4) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
      const kept = (prev.signals || []).filter((s) => s && s.url && s.title);
      payload = {
        updatedAt: new Date().toISOString(),
        source: "fallback-previous",
        sources: ["reddit", "hackernews"],
        subreddits: SUBREDDITS.map((s) => `r/${s}`),
        note: "Fresh fetch returned too few items; kept prior valid signals.",
        signals: kept.length ? kept : ranked,
      };
      console.warn("Too few posts; preserving previous signals.json");
    } catch {
      payload = {
        updatedAt: new Date().toISOString(),
        source: "partial",
        sources: ["reddit", "hackernews"],
        signals: ranked,
      };
    }
  } else {
    payload = {
      updatedAt: new Date().toISOString(),
      source: "reddit+hackernews",
      sources: ["reddit", "hackernews"],
      subreddits: SUBREDDITS.map((s) => `r/${s}`),
      count: ranked.length,
      signals: ranked,
    };
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${payload.signals.length} signals → ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
