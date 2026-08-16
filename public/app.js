const log = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const resetBtn = document.getElementById("reset");

/** Full conversation — the API is stateless, so we resend it every turn. */
let messages = [];
let streaming = false;

resetBtn.addEventListener("click", () => {
  if (streaming) return;
  messages = [];
  log.innerHTML = '<p class="empty">Ask me about tactics, the laws, history, or any club or player.</p>';
  input.focus();
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || streaming) return;

  input.value = "";
  input.style.height = "auto";
  setStreaming(true);

  messages.push({ role: "user", content: text });
  addBubble("user", text);

  const bubble = addBubble("assistant", "");
  bubble.classList.add("cursor");
  let reply = "";
  let status = null;

  // The model may fetch live data before it has anything to say, so show what
  // it is doing rather than leaving an empty bubble blinking.
  const paint = () => {
    const note = status ? `<p class="status">${escapeHtml(status)}…</p>` : "";
    bubble.innerHTML = render(reply) + note;
    scrollToEnd();
  };

  try {
    await streamChat(messages, {
      onDelta(chunk) {
        reply += chunk;
        paint();
      },
      onStatus(text) {
        status = text;
        paint();
      },
      onError(message) {
        bubble.remove();
        addBubble("error", message);
      },
    });
    status = null;
    if (reply) paint();

    if (reply) messages.push({ role: "assistant", content: reply });
    else bubble.remove();
  } catch (err) {
    bubble.remove();
    addBubble("error", err.message || "Connection lost.");
  } finally {
    bubble.classList.remove("cursor");
    setStreaming(false);
  }
});

/** POST the history and consume the server's SSE response. */
async function streamChat(history, { onDelta, onStatus, onError }) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${res.status}).`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // SSE frames are separated by a blank line.
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const event = frame.match(/^event: (.*)$/m)?.[1];
      const raw = frame.match(/^data: (.*)$/m)?.[1];
      if (!raw) continue;
      const data = JSON.parse(raw);

      if (event === "delta") onDelta(data.text);
      else if (event === "status") onStatus(data.text);
      else if (event === "error") onError(data.message);
    }
  }
}

function setStreaming(active) {
  streaming = active;
  sendBtn.disabled = active;
  sendBtn.textContent = active ? "…" : "Send";
}

function addBubble(role, text) {
  log.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  log.append(el);
  scrollToEnd();
  return el;
}

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
}

/**
 * Minimal markdown: fenced blocks, headings, lists, inline code, bold.
 *
 * Assistant text is untrusted input to the DOM, so escaping happens FIRST and
 * every tag emitted below is one we constructed ourselves. Any change here must
 * preserve that ordering, or swap in a real sanitizing renderer.
 */
function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(text) {
  let s = escapeHtml(text);

  // Stash fenced blocks so their contents skip the inline and block passes.
  // The sentinel must not collide with ordinary prose — a bare " 1 " would.
  const blocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, "")}</code></pre>`);
    return `%%CB${blocks.length - 1}%%`;
  });

  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

  const out = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const pushItem = (tag, item) => {
    flushPara();
    if (!list || list.tag !== tag) {
      flushList();
      list = { tag, items: [] };
    }
    list.items.push(item);
  };

  for (const rawLine of s.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);

    if (/^%%CB\d+%%$/.test(line)) {
      flushPara();
      flushList();
      out.push(line);
    } else if (heading) {
      flushPara();
      flushList();
      // Bubbles are small — start at h3 so headings read as bold, not billboards.
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${heading[2]}</h${level}>`);
    } else if (bullet) {
      pushItem("ul", bullet[1]);
    } else if (numbered) {
      pushItem("ol", numbered[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  return out.join("").replace(/%%CB(\d+)%%/g, (_, i) => blocks[i] ?? "");
}
