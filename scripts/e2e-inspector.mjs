// Wrangler 3 habilita Network sin DevTools y acumula eventos en el proxy.
// Solo para el runner headless: no cambia requests, bindings ni código del worker.
// https://github.com/cloudflare/workers-sdk/issues/14191
export async function connectHeadlessInspector(port, {
  fetchImpl = fetch, WebSocketImpl = WebSocket, timeoutMs = 10_000,
  onFailure = (error) => console.error(error),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let target;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) [target] = await response.json();
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* El inspector arranca después del runtime. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("El inspector E2E no arrancó");
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== String(port)) {
    throw new Error("El inspector E2E debe ser local");
  }
  const socket = new WebSocketImpl(url.href, { headers: { Origin: "http://localhost" } });
  let closed = false;
  let interval;
  const close = () => {
    closed = true;
    clearInterval(interval);
    socket.close();
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("El inspector E2E no confirmó Network.disable")), timeoutMs);
      const finish = (error) => {
        clearTimeout(timer);
        socket.removeEventListener("message", message);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        error ? reject(error) : resolve();
      };
      const failed = () => finish(new Error("Se perdió la conexión con el inspector E2E"));
      const message = (event) => {
        const result = JSON.parse(event.data);
        if (result.id === 1) finish(result.error ? new Error(`Network.disable: ${result.error.message}`) : undefined);
      };
      socket.addEventListener("message", message);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Network.disable" })), { once: true });
    });
    // El proxy puede rehabilitar Network si se reconecta al runtime.
    let id = 1;
    interval = setInterval(() => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ id: ++id, method: "Network.disable" }));
    }, 10_000);
    socket.addEventListener("close", () => { if (!closed) { close(); onFailure(new Error("El inspector E2E se desconectó")); } });
    socket.addEventListener("error", () => { if (!closed) { close(); onFailure(new Error("Falló el inspector E2E")); } });
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}
