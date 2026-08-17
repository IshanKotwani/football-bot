# Football Bot

A minimal streaming chat app specialised in association football: an Express server
that proxies a hosted LLM, and a no-build vanilla JS frontend. Roughly 400 lines
total, no framework, no bundler.

The specialisation lives entirely in `SYSTEM_PROMPT` in `server.js` — scope, tone,
opinions, multilingual replies, and strict instructions to hedge on facts that go
stale. No fine-tuning is involved, and none is needed.

For anything current — tables, fixtures, scorers, squads — the model calls
football-data.org through the tools in `football.js` and answers from real data
rather than memory.

## Setup

```sh
npm install
cp .env.example .env     # add your provider key
npm start                # http://localhost:3000
```

`npm run dev` restarts on file changes. `npm run models` lists the model IDs your key
can actually reach, which is the quickest way to resolve a "model not found" error.

## Live data

Register at <https://www.football-data.org/client/register> (free, no card,
10 requests/minute) and put the token in `.env`:

```
FOOTBALL_DATA_TOKEN=your-token-here
```

Without it the app still runs — it simply stops offering the tools and answers from
training data with the usual caveats. The startup log says which mode you are in.

Covers Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Champions League,
Eredivisie, Primeira Liga, Championship, Brasileirão, Euros, and the World Cup.
Results are cached briefly so repeat questions do not burn the rate limit.

Manager and head-coach data is not available on the free plan — those fields come
back null — so the bot answers that from model knowledge, with a caveat.

## Providers

Both supported backends speak the OpenAI wire format, so the `openai` package is the
only client library and switching providers is a one-line `.env` change.

| `PROVIDER`  | Endpoint                      | Default model                |
| ----------- | ----------------------------- | ---------------------------- |
| `aicredits` | `https://api.aicredits.in/v1` | `x-ai/grok-4.5`              |
| `sarvam`    | `https://api.sarvam.ai/v1`    | `sarvam-105b-conversations`  |

Default is `aicredits`, which tested noticeably stronger on European club football.
Sarvam is the better choice for Indian-language conversation.

AICredits is a gateway rather than a single vendor, so `MODEL` can point at any ID
in its catalogue — `npm run models` lists the ones your key can reach. Live football
data needs a model that supports function calling; one without it will still answer,
just from memory rather than from the API.

Point `BASE_URL` at any other OpenAI-compatible endpoint — including a local Ollama
instance at `http://localhost:11434/v1` — and the rest of the app is unchanged.

## How it works

```
public/app.js  ──POST /api/chat (full history)──►  server.js  ──►  provider
      ▲                                                │
      └──── SSE: delta / status / done / error ────────┘
```

- **The API is stateless.** The browser owns the conversation and resends the whole
  message list each turn; the server keeps the last 40 messages of whatever it gets.
- **The key never reaches the browser.** All API calls go through `server.js`.
- **Streaming** uses Server-Sent Events: `delta` (text chunk), `status` (what the
  model is fetching), then `done` or `error`.
- **Tool calls run in a bounded loop.** The model asks for data, the server fetches
  it, the result goes back as a `tool` message, and the model answers from it.

## Configuration

| Variable              | Default      | Notes                                          |
| --------------------- | ------------ | ---------------------------------------------- |
| `PROVIDER`            | `aicredits`  | `aicredits` or `sarvam`                        |
| `ANTHROPIC_API_KEY`   | —            | Gateway key, needed when `PROVIDER=aicredits`  |
| `SARVAM_API_KEY`      | —            | Needed when `PROVIDER=sarvam`                  |
| `FOOTBALL_DATA_TOKEN` | —            | Optional; enables live data                    |
| `MODEL`               | per-provider | Override the provider's default model          |
| `BASE_URL`            | per-provider | Override the endpoint                          |
| `MAX_TOKENS`          | per-provider | Some plans cap this; Sarvam's entry tier is 2048 |
| `PORT`                | `3000`       |                                                |

Provider defaults live in the `PROVIDERS` table in `provider.js`. `MAX_HISTORY` and
`MAX_TOOL_ROUNDS` are constants at the top of `server.js`.

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

## Ideas from here

Persist conversations (SQLite), swap the tiny markdown renderer in `app.js` for a
real one, or add auth before putting it anywhere public — right now anyone who can
reach the server can spend your API credits.
