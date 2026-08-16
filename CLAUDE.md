# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install      # dependencies
npm start        # serve on http://localhost:3000 (PORT env var overrides)
npm run dev      # same, with --watch restart on file change
npm run models   # list model IDs the configured key can actually reach
```

There is no build step, no bundler, and no test suite. `public/` is served as-is —
edits to the frontend need only a browser refresh; edits to `server.js` need a restart.

The server exits at startup if the current provider's key is missing from `.env`.

## Providers, and why the OpenAI SDK is here

The app targets **two interchangeable backends**, both of which speak the OpenAI wire
format — hence the `openai` package rather than a vendor SDK. `provider.js` holds the
table; `PROVIDER` in `.env` selects a row.

| `PROVIDER`  | Endpoint                      | Default model                 | Key var             |
| ----------- | ----------------------------- | ----------------------------- | ------------------- |
| `sarvam`    | `https://api.sarvam.ai/v1`    | `sarvam-105b-conversations`   | `SARVAM_API_KEY`    |
| `aicredits` | `https://api.aicredits.in/v1` | `anthropic/claude-haiku-4-5`  | `ANTHROPIC_API_KEY` |

Default is `sarvam`. The whole arrangement exists because of one constraint: the user
is in India and cannot fund USD-billed API credits, so every backend here must be
payable in INR. Do not "simplify" this by switching to `@anthropic-ai/sdk` and a
first-party Anthropic key — that path is closed.

Per-provider quirks worth knowing before editing `provider.js`:

- **Sarvam authenticates with an `api-subscription-key` header**, not
  `Authorization: Bearer`. That is what the `headers` function in the provider table
  is for. The key is still passed as `apiKey` too, since the SDK requires one.
- **Sarvam's own models live on `/v1`** — verified against a live key, which returns
  exactly two IDs: `sarvam-105b` and `sarvam-105b-conversations`. Their hosted
  open-weight models (`gemma4`, `glm5.2`) are on `/v2` instead, so reaching those
  means setting both `BASE_URL=https://api.sarvam.ai/v2` and `MODEL`.
- **Sarvam caps `max_tokens` by subscription tier** — Starter rejects anything above
  2048 with a 400. Hence `maxTokens` in the provider table rather than one shared
  constant. Raising it requires a plan upgrade, not a code change.
- **`sarvam-105b-conversations` opens replies with a stray newline.** The stream loop
  strips leading whitespace until the first real character, so it never reaches the
  UI as a blank first line.
- **AICredits namespaces model IDs** as `anthropic/<model>`. That prefix is the
  gateway's convention, not part of the model name — do not strip it.
- **Anthropic-native parameters are unavailable on both.** No `output_config.effort`,
  no adaptive-thinking config, no server-side `fallbacks`, no `stop_reason: "refusal"`.
- `BASE_URL` and `MODEL` in `.env` override the table, which is also how a local
  Ollama instance can be substituted for offline use.

## Architecture

`provider.js` (config + client), `server.js` (Express), `models.js` (a CLI helper),
and three files in `public/`. Anything provider-specific — endpoint, model, key
variable, auth headers, token ceiling — belongs in the `PROVIDERS` table in
`provider.js`, not scattered through `server.js`.

**The server holds no conversation state.** `public/app.js` owns the `messages`
array and POSTs the entire history to `/api/chat` on every turn; the server
normalizes it (`parseMessages`), truncates to `MAX_HISTORY`, prepends the system
prompt as `messages[0]`, and forwards it. Server-side memory would be new
infrastructure, not a tweak.

**The system prompt is built per request, not at startup** (`systemPrompt()` in
`server.js`), so a long-running server never serves a stale date. It pins today's
date and instructs the model to hedge on facts that change over time while answering
durable questions directly. This is deliberate and load-bearing: `sarvam-105b`
believes the date is June 2025 and will otherwise state year-old transfers and
appointments as current fact, including a flat "the 2026 World Cup has not taken
place". The "your silence is not evidence" clause is what fixes that last failure —
without it the model treats absence of training data as proof an event never
happened. Verify any edit here against those cases before assuming it still works.

**Live data arrives through a tool loop, not a plugin.** `football.js` wraps
football-data.org and exports `TOOLS` (OpenAI-format definitions), `run()`, and an
`enabled` flag. `/api/chat` loops up to `MAX_TOOL_ROUNDS`: stream a completion, and
if it ends with `finish_reason === "tool_calls"`, execute them, append the assistant
turn *verbatim* plus one `role: "tool"` message per call, and go round again.

- **`enabled` is false without `FOOTBALL_DATA_TOKEN`**, in which case no tools are
  advertised and the bot answers from memory. That degradation path is deliberate —
  do not make the token mandatory.
- **Accumulating streamed tool calls: assign the name, append the arguments.** Both
  providers repeat the *complete* function name on every chunk while fragmenting the
  arguments. Appending the name yields `get_standingsget_standings…`, which fails as
  an unknown tool and burns a round before the model retries.
- **`toCode()` matches competition names exactly, after stripping noise words.** An
  earlier substring test mapped "Bundesliga 5" to BL1. A silently wrong competition
  is worse than a null: on null the model receives the valid list and retries. The
  noise regex must not contain multi-word alternatives like `league table`, which
  match ahead of the league name and leave "premier".
- **`matchTeam()` scores candidates; it never takes the first substring hit.**
  "Barcelona" matched *RCD Espanyol de Barcelona* — the cross-city rival, earlier in
  the list. Exact matches on name, shortName or TLA must outrank word-boundary
  containment, hence the 4/3/2/1 scoring. Names are accent-stripped ("Barça" →
  "barca") and club-type tokens removed, but **"real" is deliberately kept**: it
  distinguishes Real Madrid, Real Sociedad and Real Betis.
- A rejected team is often correct rather than a matching failure — Wolves are
  genuinely absent from the 2026/27 Premier League. The error carries the full
  `available` list so the model can say which teams are actually in the competition.
- `run()` never throws; errors come back as `{ error }` so the model can explain the
  failure rather than the stream dying.
- **Manager/coach data does not exist on the free tier.** Verified against the live
  API: both `/competitions/{code}/teams` and `/teams/{id}` return a `coach` object
  with every field `null`. `get_squad` therefore returns a `note` telling the model
  to answer that part from memory, and its tool description says so explicitly.
  Adding a second request to "fetch the coach properly" only spends a rate-limit
  slot to receive the same nulls.

**`/api/chat` speaks SSE, not JSON.** It writes `event: <name>\ndata: <json>\n\n`
frames of four kinds — `delta` (text chunk), `status` (a phrase like "checking the
PL table", or `null` to clear it), `done` (`finish_reason`), `error` (user-facing
message string). `public/app.js` parses these by hand in `streamChat` by splitting
the byte stream on blank lines. A new event type means touching both `send(...)` in
`server.js` and the dispatch in `streamChat`.

`status` exists because a tool round can run for seconds before any text appears,
which would otherwise leave an empty bubble blinking.

This SSE contract is the seam that keeps the backend swappable. Two provider
migrations so far — Anthropic SDK to AICredits, then AICredits to Sarvam — changed
only `provider.js` and the inside of the try block. `public/` has never been touched.
Preserve that property.

**Error mapping is deliberate.** The catch block turns typed SDK exceptions
(`OpenAI.AuthenticationError`, `RateLimitError`, `NotFoundError`,
`APIConnectionError`) into short strings the UI renders directly, interpolating the
provider name so failures say which backend broke. Sarvam returns **403** for a bad
key where most OpenAI-compatible APIs return 401, so the auth branch checks both.
`NotFoundError` usually means the provider does not carry the configured `MODEL`.
Keep raw errors and stack traces on the server via `console.error`.

**Client disconnects abort the upstream call** via `AbortController`, wired to
`res.on("close")` guarded by `!res.writableFinished`. Do not move this to
`req.on("close")`: on Node ≥15 that fires as soon as the request body is consumed,
which aborts every stream before a single token arrives.

## Frontend notes

`render()` in `public/app.js` is a deliberately tiny markdown subset — fenced blocks,
headings, ordered and unordered lists, inline code, bold — that escapes HTML
**first**. Assistant text is untrusted input to the DOM, so any change must keep
escaping ahead of markup generation, or swap in a real sanitizing renderer.

Two traps it already fell into, both regression-tested:

- Fenced blocks are stashed behind a `%%CB<n>%%` sentinel while the block pass runs.
  The sentinel must not look like prose — an earlier version used a bare space-padded
  number, which a scoreline like "won 3 - 1" collided with.
- Because `render()` emits real block elements, `white-space: pre-wrap` must **not**
  apply to assistant bubbles or every paragraph gains phantom blank lines. It stays
  on `.msg.user` and `.msg.error`, which are set via `textContent` and need it.

Styling uses CSS custom properties on `:root` with a `prefers-color-scheme` override;
there is no theme toggle and no JS involvement in theming.
