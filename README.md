# Football Bot

A minimal streaming chat app specialised in association football: an Express server
that proxies a hosted LLM, and a no-build vanilla JS frontend. Roughly 400 lines
total, no framework, no bundler.

The specialisation lives entirely in `SYSTEM_PROMPT` in `server.js` — scope, tone,
opinions, Indian-language replies, and strict instructions to hedge on facts that go
stale. No fine-tuning is involved, and none is needed.

For anything current — tables, fixtures, scorers, squads — the model calls
football-data.org through the tools in `football.js` and answers from real data
rather than memory.

## Live data

Register at <https://www.football-data.org/client/register> (free forever, no card,
10 requests/minute) and put the token in `.env`:

```
FOOTBALL_DATA_TOKEN=your-token-here
```

Without it the app still runs — it simply stops offering the tools and answers from
training data with the usual caveats. The startup log says which mode you are in.

Covers Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Champions League,
Eredivisie, Primeira Liga, Championship, Brasileirão, Euros, and the World Cup.
Results are cached briefly so repeat questions do not burn the rate limit.

Both supported backends speak the OpenAI wire format, so the `openai` package is the
only client library and switching providers is a `.env` change.

| `PROVIDER`  | Model                         | Billing                                  |
| ----------- | ----------------------------- | ---------------------------------------- |
| `sarvam`    | `sarvam-105b-conversations`   | INR prepaid credits, direct from Sarvam  |
| `aicredits` | `anthropic/claude-haiku-4-5`  | INR via the AICredits reseller gateway   |

Default is `sarvam`: cheaper (₹29/₹73 per 1M input/output tokens vs roughly ₹88/₹440
for Haiku at list), no third party between you and the provider, and far stronger on
the 22 scheduled Indian languages.

## Setup

```sh
npm install
cp .env.example .env
npm start                # http://localhost:3000
```

For Sarvam, get a key at <https://dashboard.sarvam.ai> — new accounts are given free
credits and the Starter plan asks for no card. Put it in `.env` as `SARVAM_API_KEY`.

`npm run dev` restarts on file changes. `npm run models` lists the model IDs your key
can actually reach, which is the quickest way to resolve a "model not found" error.

## How it works

```
public/app.js  ──POST /api/chat (full history)──►  server.js  ──►  provider
      ▲                                                │
      └────────────── SSE: delta / done / error ───────┘
```

- **The API is stateless.** The browser owns the conversation and resends the whole
  message list each turn; the server keeps the last 40 messages of whatever it gets.
- **The key never reaches the browser.** All API calls go through `server.js`.
- **Streaming** uses Server-Sent Events: `delta` (text chunk), then `done` or `error`.

## Configuration

| Variable            | Default    | Notes                                              |
| ------------------- | ---------- | -------------------------------------------------- |
| `PROVIDER`          | `sarvam`   | `sarvam` or `aicredits`                            |
| `SARVAM_API_KEY`    | —          | Needed when `PROVIDER=sarvam`                      |
| `ANTHROPIC_API_KEY` | —          | Needed when `PROVIDER=aicredits` (a gateway key, despite the name) |
| `MODEL`             | per-provider | Override the provider's default model            |
| `BASE_URL`          | per-provider | Override the endpoint — e.g. a local Ollama at `http://localhost:11434/v1` |
| `MAX_TOKENS`        | per-provider | 2048 on Sarvam (Starter tier's hard cap), 4096 on the gateway |
| `PORT`              | `3000`     |                                                    |

Provider defaults live in the `PROVIDERS` table in `provider.js`. `MAX_HISTORY` is a
constant at the top of `server.js`.

Sarvam's Starter tier **rejects `max_tokens` above 2048** with a 400, so replies are
capped around 1,500 words. Raising that needs a plan upgrade, not a config change.

## Files

| Path                 | What it does                                                     |
| -------------------- | ---------------------------------------------------------------- |
| `provider.js`        | Provider table, env resolution, the configured OpenAI client      |
| `football.js`        | football-data.org wrapper, tool definitions, caching              |
| `server.js`          | Express app, `/api/chat` SSE endpoint, tool loop, error mapping   |
| `models.js`          | `npm run models` — lists model IDs the key can reach              |
| `public/index.html`  | Page shell                                                        |
| `public/app.js`      | Conversation state, SSE parsing, incremental rendering            |
| `public/styles.css`  | Styling, light and dark                                           |

## Notes on the providers

**Sarvam** bills from prepaid credits, so the amount you load is a hard spend ceiling —
there's no card-on-file arrangement accruing a bill. Avoid enabling auto-recharge if
it's offered, since that undoes the cap. Rate limits are separate from credits (60
requests/min on Starter). Sarvam's own benchmark claims for the 105B model are
self-reported; treat relative quality as something to test on your own prompts.

**AICredits** is a reseller, so your prompts and key pass through a third party. It
remains configured as a fallback and for comparison.

Neither runs locally — both need internet. For offline use, point `BASE_URL` at a
local Ollama instance; the rest of the app is unchanged.

## Ideas from here

Persist conversations (SQLite), add tool use, swap the tiny markdown renderer in
`app.js` for a real one, or add auth before putting it anywhere public — right now
anyone who can reach the server can spend your credits.
