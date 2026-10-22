import { afterEach, expect, it, vi } from "vitest";
import { connectHeadlessInspector } from "../../scripts/e2e-inspector.mjs";

class InspectorSocket extends EventTarget {
  static latest: InspectorSocket;
  static reply: "ok" | "error" | "silent" = "ok";
  readyState = 1;
  sent: { id: number; method: string }[] = [];
  constructor(public url: string, public options: unknown) {
    super();
    InspectorSocket.latest = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(data: string) {
    const command = JSON.parse(data);
    this.sent.push(command);
    if (InspectorSocket.reply !== "silent") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ id: command.id, ...(InspectorSocket.reply === "error" ? { error: { message: "rechazado" } } : { result: {} }) }),
    })));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

const fetchInspector = async () => Response.json([{ webSocketDebuggerUrl: "ws://127.0.0.1:4323/ws" }]);
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); InspectorSocket.reply = "ok"; });

it("desactiva Network antes de estar listo y conserva la conexión hasta el cierre", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", InspectorSocket);
  const onFailure = vi.fn();
  const inspector = await connectHeadlessInspector(4323, { fetchImpl: fetchInspector, onFailure });
  expect(InspectorSocket.latest.options).toEqual({ headers: { Origin: "http://localhost" } });
  expect(InspectorSocket.latest.sent).toEqual([{ id: 1, method: "Network.disable" }]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(InspectorSocket.latest.sent[1]).toEqual({ id: 2, method: "Network.disable" });
  inspector.close();
  expect(vi.getTimerCount()).toBe(0);
  expect(InspectorSocket.latest.readyState).toBe(3);
  expect(onFailure).not.toHaveBeenCalled();
});

it("una desconexión inesperada se informa en lugar de aprobar la infraestructura", async () => {
  vi.stubGlobal("WebSocket", InspectorSocket);
  const onFailure = vi.fn();
  await connectHeadlessInspector(4323, { fetchImpl: fetchInspector, onFailure });
  InspectorSocket.latest.close();
  expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "El inspector E2E se desconectó" }));
});

it("rechaza errores de protocolo y confirmaciones ausentes y libera el socket", async () => {
  vi.stubGlobal("WebSocket", InspectorSocket);
  InspectorSocket.reply = "error";
  await expect(connectHeadlessInspector(4323, { fetchImpl: fetchInspector })).rejects.toThrow("Network.disable: rechazado");
  expect(InspectorSocket.latest.readyState).toBe(3);
  InspectorSocket.reply = "silent";
  await expect(connectHeadlessInspector(4323, { fetchImpl: fetchInspector, timeoutMs: 20 })).rejects.toThrow("no confirmó");
  expect(InspectorSocket.latest.readyState).toBe(3);
});

it("solo conecta al inspector local y falla si no arranca", async () => {
  await expect(connectHeadlessInspector(4323, {
    fetchImpl: async () => Response.json([{ webSocketDebuggerUrl: "ws://external.example:4323/ws" }]),
  })).rejects.toThrow("debe ser local");
  await expect(connectHeadlessInspector(4323, {
    fetchImpl: async () => new Response(null, { status: 503 }), timeoutMs: 1,
  })).rejects.toThrow("no arrancó");
});
