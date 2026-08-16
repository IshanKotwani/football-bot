import express from "express";
import OpenAI from "openai";
import { client, PROVIDER, MODEL, MAX_TOKENS, BASE_URL, KEY_VAR, KNOWLEDGE } from "./provider.js";
import * as football from "./football.js";

const MAX_HISTORY = 40; // messages kept per request (the API is stateless)
const MAX_TOOL_ROUNDS = 4; // model asks for data -> we fetch -> it answers

const SYSTEM_PROMPT = `You are a football chatbot. Football means association
football — soccer. Not American football, rugby, or Australian rules. If someone
clearly means a different code, say which sport you cover and offer to help with
that instead.

Cover the whole game: the laws and how they are interpreted, tactics and
formations, history, competitions, clubs, players, and football culture. Men's and
women's football alike, worldwide, and Indian football too — the ISL, the I-League,
and the national teams.

Match the depth of the question. A casual question gets a short, direct answer; a
tactical or historical one can run longer. Assume the person likes football but not
that they are an expert — explain jargon the first time it appears unless they have
already shown they know it. Answer in plain prose; use markdown only when it genuinely
helps, such as a list of a squad or a season's results.

Never invent specifics. Scorelines, transfer fees, appearance counts, goal tallies,
and dates are exactly the details that sound plausible and turn out wrong. If you
are not confident of an exact figure, say so or give a range — "somewhere around 200
goals" beats a precise number you made up. Never fabricate quotes from players,
managers, or journalists.

Football is argued about, and you may have opinions — a best XI, whether a decision
was correct, the merits of a system. Make the case and be clear it is a view rather
than fact. Do not be inflammatory about clubs, players, or supporters.

Stay on football. If asked about something unrelated, say briefly that you are a
football bot and steer back. The exception is football's overlap with other
subjects — money, politics, sports science, a player's life off the pitch — which
you should treat as football and engage with.

If the user writes in Hindi, Hinglish, or another Indian language, reply in that
same language.

${KNOWLEDGE}

That matters more in football than almost anywhere. Squads, managers, league
tables, injuries, suspensions, top-scorer lists, records, and who won what change
constantly. Treat all of them as potentially stale: say what you knew and roughly
when, rather than asserting a present state. Say "when I last had reliable
information, X was at Y" rather than "X plays for Y". Where it matters, point the
person at a live source. Never infer that something has not happened merely because
you have no record of it — your silence is not evidence, and tournaments you have
no memory of have very likely been played and won.

Being unsure is not a licence to be vague, and it is not a reason to refuse. If you
are asked about a squad, a lineup, or who plays where, give the names you last knew
and mark them as dated — "when I last had reliable information the front line was
X, Y and Z, though that will have moved on". Do not reply with a nameless sketch of
"a goalkeeper who commands his area", and do not decline to answer and simply point
at Transfermarkt. A dated list with a clear caveat is genuinely useful; an empty
answer is not. Say plainly that you do not know only when you actually do not.

None of that applies to durable football knowledge — the laws, historical matches
and eras, tactical concepts, how a competition is structured. Answer those directly
and confidently, without hedging.`;

/**
 * The system prompt with today's date attached. Built per request, not at
 * startup: a long-running server would otherwise keep serving a stale date.
 */
function systemPrompt() {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });

  let prompt = `${SYSTEM_PROMPT}\n\nToday's date is ${today}. The user's clock is the authority on this, not your own sense of what year it is.`;

  if (football.enabled) {
    prompt += `

You have tools that fetch live football data: league tables, fixtures and recent
results, top scorers, and squads. They cover ${football.COMPETITION_NAMES.join(", ")}.

Use them whenever a question turns on current facts — who is top, who plays whom
next, who is leading the scoring charts, who is in a squad — instead of answering
from memory and hedging. Data returned by a tool is current and authoritative:
state it plainly, with none of the "as of my knowledge" caveats that apply to your
training data. Where a tool result contradicts what you remember, the tool is right.

Do not call a tool for durable questions — the laws, history, tactics — or for
competitions outside that list. If a tool returns an error, say briefly what could
not be fetched and answer from memory with the usual caveats.`;
  }

  return prompt;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

/** Reject anything that isn't a well-formed [{role, content}] list. */
function parseMessages(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return { error: "Body must be { messages: [{ role, content }, ...] }" };
  }
  const messages = body.messages.slice(-MAX_HISTORY).map((m) => ({
    role: m?.role === "assistant" ? "assistant" : "user",
    content: String(m?.content ?? "").slice(0, 100_000),
  }));
  if (messages[0].role !== "user") messages.shift(); // first turn must be user
  if (messages.length === 0) return { error: "No usable messages after normalization." };
  return { messages };
}

app.post("/api/chat", async (req, res) => {
  const { messages, error } = parseMessages(req.body);
  if (error) return res.status(400).json({ error });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Abort the upstream request if the browser navigates away mid-stream.
  // Listen on the response, not the request: `req` emits "close" as soon as its
  // body is consumed, which would abort every stream immediately.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  // Unlike Anthropic's native API, the system prompt is just the first message.
  const convo = [{ role: "system", content: systemPrompt() }, ...messages];
  let started = false; // some models open replies with a stray newline

  try {
    let finishReason = null;

    // Tool loop: the model may ask for data, we fetch it, then it answers from
    // the result. Bounded so a model that keeps requesting cannot spin forever.
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = await client.chat.completions.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          stream: true,
          messages: convo,
          ...(football.enabled ? { tools: football.TOOLS } : {}),
        },
        { signal: controller.signal },
      );

      let text = "";
      const calls = []; // accumulated by index — arguments arrive in fragments
      finishReason = null;

      // A model that narrates ("let me look that up") before calling a tool would
      // otherwise have that run straight into the answer from the next round.
      if (started && round > 0) send("delta", { text: "\n\n" });

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        let piece = delta?.content;
        if (piece) {
          if (!started) {
            piece = piece.replace(/^\s+/, "");
            if (!piece) continue; // whitespace-only lead-in, drop it entirely
            started = true;
          }
          text += piece;
          send("delta", { text: piece });
        }

        for (const tc of delta?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) calls[i].id = tc.id;
          // The name arrives complete on every chunk, so assign it once;
          // appending yields "get_standingsget_standings...". Arguments are
          // genuinely fragmented and must be concatenated.
          if (tc.function?.name && !calls[i].function.name) calls[i].function.name = tc.function.name;
          if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
        }

        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }

      const wanted = calls.filter(Boolean);
      if (finishReason !== "tool_calls" || wanted.length === 0) break;

      // The assistant turn that requested the calls must be replayed verbatim.
      convo.push({ role: "assistant", content: text || null, tool_calls: wanted });

      for (const call of wanted) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* run() reports the parse failure to the model as data */
        }
        console.log(`[tool] ${call.function.name}(${call.function.arguments})`);
        send("status", { text: football.describe(call.function.name, args) });

        const result = await football.run(call.function.name, call.function.arguments);
        convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }

      send("status", { text: null }); // clear the indicator before the next round
    }

    send("done", { finish_reason: finishReason });
  } catch (err) {
    if (controller.signal.aborted) return res.end();

    let message = `Something went wrong talking to ${PROVIDER}.`;
    if (err instanceof OpenAI.AuthenticationError || err?.status === 403) {
      message = `${PROVIDER} rejected the key in ${KEY_VAR}.`;
    } else if (err instanceof OpenAI.RateLimitError) {
      message = "Rate limited, or credits exhausted — check your balance.";
    } else if (err instanceof OpenAI.NotFoundError) {
      message = `${PROVIDER} does not offer the model "${MODEL}". Run \`npm run models\` to list what your key can reach.`;
    } else if (err instanceof OpenAI.APIConnectionError) {
      message = `Network error reaching ${PROVIDER}.`;
    } else if (err instanceof OpenAI.APIError) {
      message = `${PROVIDER} error ${err.status}: ${err.message}`;
    }

    console.error(err);
    send("error", { message });
  } finally {
    res.end();
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Chatbot running at http://localhost:${port}`);
  console.log(`Provider: ${PROVIDER}  Model: ${MODEL}  Base: ${BASE_URL}`);
  console.log(
    football.enabled
      ? `Live data: on (football-data.org, ${football.COMPETITION_NAMES.length} competitions)`
      : "Live data: off — set FOOTBALL_DATA_TOKEN in .env to enable",
  );
});
