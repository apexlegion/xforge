# XForge — AI Idea Validator + live market signals for X

XForge stress-tests a startup/product idea and writes X (Twitter) growth assets —
grounded in **live Reddit + Hacker News discussions** that refresh automatically.

- **Flagship:** Idea Validator — a full opportunity report (demand, competition, timing,
  distribution, differentiation, monetization, feasibility) with real market signals cited.
- **Modules:** Threads, Outreach, Growth plan, Reply booster, Analytics, Niche research.
- **Fresh Signals:** `scripts/fetch-signals.js` pulls real Reddit + HN posts every ~9h
  via GitHub Actions and commits `data/signals.json`.

## How the AI works (and stays free)

The browser never holds an API key. A single serverless function does the thinking:

```
Browser ──POST /api/generate──▶ Cloudflare Pages Function ──▶ Gemini (free tier)
                                (holds GEMINI_API_KEY secret)
```

- Key lives **only** as a Cloudflare env var — safe to keep this repo public.
- If the key is missing or Gemini errors, the app **silently falls back to built-in
  templates**, so the site never breaks. The header pill shows `⚡ Live AI` or `Offline mode`.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | The whole app (UI + logic + template fallback). |
| `functions/api/generate.js` | Cloudflare Pages Function → Gemini. Route: `/api/generate`. |
| `scripts/fetch-signals.js` | Fetches Reddit + HN → `data/signals.json`. |
| `.github/workflows/update-signals.yml` | Runs the fetcher every ~9h. |

## Deploy (one-time, ~10 min)

### 1. Get a free Gemini API key
Go to **https://aistudio.google.com/apikey** → *Create API key* → copy it.

### 2. Push this folder to GitHub
```bash
cd xforge
git init
git add .
git commit -m "XForge: AI validator + live signals"
git branch -M main
git remote add origin https://github.com/<you>/xforge.git
git push -u origin main
```

### 3. Connect Cloudflare Pages
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Pick the `xforge` repo. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **`/`** (root)
3. **Settings → Environment variables → add** `GEMINI_API_KEY` = your key. **Save.**
4. Deploy. Cloudflare auto-detects `functions/` and serves `/api/generate`.

That's it. The header pill flips to `⚡ Live AI` once the key is live.

### 4. (Automatic) Fresh Signals
GitHub Actions runs the fetcher on schedule and pushes `data/signals.json`;
Cloudflare Pages redeploys on each push. Nothing to touch.

## Local preview
```bash
npx serve .        # or any static server
```
Locally there's no key, so it runs in **Offline mode** (templates) — expected.
To test live AI locally: `npm i -g wrangler` then `wrangler pages dev . --binding GEMINI_API_KEY=<key>`.

## Swapping the model
Everything AI lives in `functions/api/generate.js`. To switch providers (e.g. Groq),
change `callGemini()` and the env var name — the front-end contract (`{mode, inputs}` →
`{data}`) stays the same.
