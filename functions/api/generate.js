/**
 * XForge — Serverless AI brain (Cloudflare Pages Function).
 *
 * Route:  POST /api/generate   -> real AI generation for every module
 *         GET  /api/generate   -> { enabled, model }  (lets the UI show a "Live AI" badge)
 *
 * The Groq API key lives ONLY here, as a Cloudflare env var (GROQ_API_KEY).
 * It is never shipped to the browser, so index.html stays 100% public/open-source.
 * If the key is missing or Groq fails, we return a soft error and the front-end
 * silently falls back to its built-in templates — the site never breaks.
 */

const MODEL = "llama-3.3-70b-versatile";
const MAX_INPUT = 1200; // chars per field — keeps prompts + cost bounded

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export function onRequestGet({ env }) {
  return json({ enabled: !!env.GROQ_API_KEY, model: MODEL });
}

export async function onRequestPost({ request, env }) {
  const key = env.GROQ_API_KEY;
  if (!key) return json({ error: "no-key", fallback: true }, 503);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "bad-json" }, 400);
  }

  const mode = String(payload?.mode || "");
  const spec = MODES[mode];
  if (!spec) return json({ error: "unknown-mode" }, 400);

  const inputs = clampInputs(payload?.inputs || {});
  const prompt = spec.prompt(inputs);

  try {
    const data = await callGroq(key, spec.system, prompt, spec.temp ?? 0.7);
    return json({ data, source: "groq", model: MODEL });
  } catch (err) {
    // Soft-fail: tell the client to use its template fallback.
    return json({ error: String(err && err.message || err), fallback: true }, 502);
  }
}

/* ---------------- Groq (OpenAI-compatible chat completions) ---------------- */

async function callGroq(key, system, userPrompt, temperature) {
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const body = {
    model: MODEL,
    temperature,
    max_tokens: 2048,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt },
    ],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 22000);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`groq ${res.status} ${t.slice(0, 160)}`);
  }

  const out = await res.json();
  const text = out?.choices?.[0]?.message?.content || "";
  return parseJson(text);
}

function parseJson(text) {
  let t = String(text).trim();
  // Strip accidental markdown code fences.
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    // Last-ditch: grab the outermost { } or [ ].
    const first = Math.min(...["{", "["].map((c) => (t.indexOf(c) + 1 || Infinity)) ) - 1;
    const lastO = t.lastIndexOf("}");
    const lastA = t.lastIndexOf("]");
    const last = Math.max(lastO, lastA);
    if (first >= 0 && last > first) return JSON.parse(t.slice(first, last + 1));
    throw new Error("unparseable-model-output");
  }
}

/* ---------------- Input hygiene ---------------- */

function clampInputs(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v.slice(0, MAX_INPUT);
    else if (Array.isArray(v)) out[k] = v.slice(0, 8).map((x) => String(x).slice(0, 300));
    else out[k] = v;
  }
  return out;
}

function signalBlock(signals) {
  if (!Array.isArray(signals) || !signals.length) return "None loaded.";
  return signals
    .slice(0, 6)
    .map((s, i) => `${i + 1}. ${s.title}${s.excerpt ? " — " + s.excerpt : ""}`)
    .join("\n");
}

/* ---------------- Prompts per module ----------------
 * Every prompt asks for STRICT JSON matching the exact shape the front-end
 * already renders. The client shallow-merges over its template, so any field
 * the model omits still has a safe default.
 */

const BASE_VOICE =
  "You are XForge, a brutally honest startup + X (Twitter) growth strategist. " +
  "You sound like a sharp operator, not a chatbot. No hype, no fluff, no emoji, no hedging like 'it depends'. " +
  "Be specific to the user's exact idea and words — never generic boilerplate that would fit any business. " +
  "Return ONLY valid JSON. No markdown, no commentary.";

const MODES = {
  validator: {
    temp: 0.65,
    system: BASE_VOICE,
    prompt: (i) => `Validate this idea. Be honest — say "high risk" when it is.

IDEA: ${i.idea || ""}
TARGET CUSTOMER: ${i.customer || "unspecified"}
STAGE: ${i.stage || "idea"}
DECLARED DISTRIBUTION CHANNEL: ${i.channel || "none declared"}

LIVE MARKET SIGNALS (real recent Reddit/HN discussions — ground your timing/demand read in these, cite them by number in marketTiming):
${signalBlock(i.signals)}

Return JSON with EXACTLY these keys:
{
  "overall": int 0-100 (weighted opportunity),
  "demand": int, "competition": int (0=empty market, 100=saturated), "timing": int,
  "distribution": int, "differentiation": int, "monetizationScore": int, "feasibility": int,
  "verdict": { "label": "Strong pursue" | "Validate harder" | "High risk / narrow",
               "color": "#00ba7c" (if overall>=75) | "#ffd400" (58-74) | "#f4212e" (<58),
               "note": one sharp sentence },
  "executive": 2-3 sentence honest summary naming the single biggest lever AND the biggest risk,
  "stageNote": one sentence tailored to the stage,
  "problems": [5 specific pains THIS customer feels — concrete, not generic],
  "competitors": [4 x { "type": "Direct"|"Indirect"|"Behavioral"|"Emerging", "name": string, "note": string }],
  "marketTiming": [4 strings; reference the live signals by number where relevant],
  "distributionReality": [4 strings; be blunt about cold-start if no channel],
  "diffNotes": [4 strings incl. one positioning statement draft],
  "monetization": [5 concrete paths with price ranges],
  "redFlags": [5 kill/pivot risks],
  "nextSteps": [6 concrete actions doable this week]
}`,
  },

  threads: {
    temp: 0.9,
    system: BASE_VOICE,
    prompt: (i) => `Write 3 distinct X thread variations about: "${i.topic}".
Tone: ${i.tone}. Goal: ${i.goal}. Each thread must have exactly ${i.count || 8} tweets.
Tweet 1 is a scroll-stopping hook. Last tweet is a CTA matching the goal. No numbering inside the text.

Return JSON array of exactly 3 objects:
[{ "name": "Variation A · Hook-led", "why": "short reason", "tweets": ["...", "..."] }, ...]`,
  },

  outreach: {
    temp: 0.85,
    system: BASE_VOICE,
    prompt: (i) => `Write a ${i.seq || 5}-message cold outreach sequence on X DMs.
TARGET: ${i.target}
OFFER: ${i.offer}
STYLE: ${i.style}
Human, specific, one ask per message, value before pitch. Space follow-ups a few days apart.

Return JSON array of exactly ${i.seq || 5} objects:
[{ "label": "Touch 1 · Opener", "timing": "Send now", "body": "..." }, ...]`,
  },

  growth: {
    temp: 0.85,
    system: BASE_VOICE,
    prompt: (i) => `Build a 7-day X content plan.
CORE IDEA: ${i.idea}
AUDIENCE: ${i.audience || "the audience"}
GOAL: ${i.goal}
Each day: a distinct theme, one main post, one thread concept, one engagement play. Concrete and copy-ready.

Return JSON array of exactly 7 objects (Monday..Sunday):
[{ "day": "Monday", "theme": "...", "post": "...", "thread": "...", "engage": "..." }, ...]`,
  },

  replies: {
    temp: 0.9,
    system: BASE_VOICE,
    prompt: (i) => `Given this post, write high-engagement replies and quote-tweet angles.
POST: "${i.tweet}"
Preferred angle: ${i.angle}. Insight over compliments. Never pitch first.

Return JSON:
{ "replies": [3 x { "style": string, "text": string }],
  "qts": [3 x { "style": string, "text": string }] }`,
  },

  analytics: {
    temp: 0.6,
    system: BASE_VOICE,
    prompt: (i) => `Analyze this ${i.type || "post"} and score it honestly.
CONTENT: "${i.text}"

Return JSON:
{ "overall": int 0-100, "clarity": int, "hook": int, "cta": int,
  "strengths": [3-4 specific strengths],
  "fixes": [3-4 specific fixes],
  "rewrites": [3 x { "label": string, "text": string }],
  "plan": [5 concrete steps for the next 7 days] }`,
  },

  niche: {
    temp: 0.75,
    system: BASE_VOICE,
    prompt: (i) => `Map the opportunity in this niche on X.
NICHE: ${i.niche}
USER'S EDGE: ${i.strength || "none stated"}

Return JSON:
{ "title": string, "opp": int 0-100, "competition": int, "demand": int,
  "problems": [4 specific problems buyers face],
  "angles": [5 content angles],
  "monetization": [5 x { "name": string, "desc": string }],
  "edge": one sentence on the wedge to lead with }`,
  },
};
