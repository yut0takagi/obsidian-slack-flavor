// A small Chrome DevTools Protocol client for Obsidian's window, using Node's built-in fetch and WebSocket.
// The debugger is enabled up front: a busy renderer only handles Debugger.pause through an interrupt,
// and only when the debugger was already on, so that is what lets a hung step report where it spins.
import { PLUGIN_ID } from "./sandbox.mjs";

export class HangError extends Error {
  name = "HangError";
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page) return page;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`Obsidian's window did not appear within ${timeoutMs} ms`);
    await delay(250);
  }
}

export async function connect(port, timeoutMs) {
  const page = await pageTarget(port, timeoutMs);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("could not open the DevTools connection"));
  });

  let nextId = 1;
  const pending = new Map();
  const scripts = new Map();
  const pausedWaiters = [];
  const pluginErrors = [];

  const mentionsPlugin = (text, frames = []) =>
    text.includes(PLUGIN_ID) || frames.some((f) => (f.url || scripts.get(f.scriptId) || "").includes(PLUGIN_ID));

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
      return;
    }
    const p = msg.params;
    if (msg.method === "Debugger.scriptParsed") scripts.set(p.scriptId, p.url);
    else if (msg.method === "Debugger.paused") pausedWaiters.splice(0).forEach((w) => w(p));
    else if (msg.method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails;
      const text = `${d.text} ${d.exception?.description ?? ""}`.trim();
      if (mentionsPlugin(text, d.stackTrace?.callFrames)) pluginErrors.push(text);
    } else if (msg.method === "Runtime.consoleAPICalled" && p.type === "error") {
      const text = p.args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (mentionsPlugin(text, p.stackTrace?.callFrames)) pluginErrors.push(text);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const frameLine = (name, scriptId, url, line, col) =>
    `    at ${name || "<anonymous>"} (${url || scripts.get(scriptId) || scriptId}:${line + 1}:${col + 1})`;

  async function pausedStack() {
    const paused = new Promise((resolve) => pausedWaiters.push(resolve));
    send("Debugger.pause");
    const p = await Promise.race([paused, delay(10_000).then(() => null)]);
    if (!p) return "    (the renderer did not pause: it may be blocked outside JavaScript)";
    const lines = p.callFrames
      .slice(0, 25)
      .map((f) => frameLine(f.functionName, f.location.scriptId, f.url, f.location.lineNumber, f.location.columnNumber));
    for (let st = p.asyncStackTrace, depth = 0; st && depth < 6; st = st.parent, depth++) {
      lines.push(`    -- async ${st.description ?? ""}`);
      for (const f of st.callFrames.slice(0, 10)) lines.push(frameLine(f.functionName, f.scriptId, f.url, f.lineNumber, f.columnNumber));
    }
    return lines.join("\n");
  }

  await send("Runtime.enable");
  await send("Debugger.enable");
  await send("Debugger.setAsyncCallStackDepth", { maxDepth: 16 });

  return {
    pluginErrors,

    /** Evaluates an expression in Obsidian's window, awaiting a returned promise. Throws HangError on timeout. */
    async evaluate(expression, timeoutMs) {
      const call = send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      const res = await Promise.race([call, delay(timeoutMs).then(() => null)]);
      if (!res) throw new HangError(`timed out after ${timeoutMs} ms; the window was busy here:\n${await pausedStack()}`);
      if (res.error) throw new Error(res.error.message);
      const { result, exceptionDetails } = res.result;
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    },

    close() {
      ws.close();
    },
  };
}
