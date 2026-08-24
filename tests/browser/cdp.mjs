// A tiny Chrome DevTools Protocol driver — no npm packages, Node 22's built-in
// WebSocket only.
export async function connect(port = 9222) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) {
    page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });

  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    else events.push(msg);
  };

  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.result?.exceptionDetails) throw new Error(out.result.exceptionDetails.text + ' ' + (out.result.exceptionDetails.exception?.description || ''));
    return out.result?.result?.value;
  };

  const goto = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 120; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const ready = await evaluate('document.readyState').catch(() => null);
      if (ready === 'complete') return;
    }
    throw new Error('page did not finish loading: ' + url);
  };

  return { send, evaluate, goto, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the expression is truthy, so tests do not race the UI. */
export async function until(page, expression, what, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await page.evaluate(expression)) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
