import { vi } from "vitest";

// Dobles en la frontera HTTP: el servicio, los clientes y la persistencia siguen siendo reales.
// Toda ruta inesperada falla; ninguna llamada sale a internet.
export function calendarHttp() {
  const events = new Map<string, Record<string, any>>();
  const transactions = new Map<string, string>();
  // match (opcional) acota el fallo a las rutas que coincidan; sin él lo consume el primer request del método
  const failures: { method: string; status: number; message: string; match?: RegExp }[] = [];
  const requests: { url: URL; method: string; body?: Record<string, any> }[] = [];
  let sequence = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    const failure = failures.findIndex((f) => f.method === method && (!f.match || f.match.test(url.pathname)));
    if (failure >= 0) {
      const [{ status, message }] = failures.splice(failure, 1);
      return Response.json({ error: { message } }, { status });
    }
    const google = url.hostname === "www.googleapis.com";
    if (!google && url.hostname !== "graph.microsoft.com") throw new Error(`Host inesperado: ${url.hostname}`);
    if (method === "GET" && url.pathname.endsWith("/calendarView")) return Response.json({ value: [] });
    if (url.pathname.endsWith("/events")) {
      if (method === "GET") {
        if (google) return Response.json({ items: [] });
        const matchId = url.searchParams.get("$filter")?.match(/ep\/value eq '([^']+)'/)?.[1];
        const existing = [...events.values()].find((event) => event.singleValueExtendedProperties?.some((p: { value: string }) => p.value === matchId));
        return Response.json({ value: existing ? [{ id: existing.id }] : [] });
      }
      if (method === "POST") {
        const priorId = body.transactionId && transactions.get(body.transactionId);
        if (priorId) return Response.json({ id: priorId });
        const id = body.id ?? `graph-${++sequence}`;
        if (events.has(id)) return Response.json({ error: { message: "already exists" } }, { status: 409 });
        events.set(id, { ...body, id, status: "confirmed" });
        if (body.transactionId) transactions.set(body.transactionId, id);
        return Response.json({ id }, { status: 201 });
      }
    }
    const id = url.pathname.split("/events/")[1];
    if (id) {
      const existing = events.get(id);
      if (!existing) return Response.json({ error: { message: "event missing" } }, { status: 404 });
      if (method === "GET") return Response.json(existing);
      if (method === "PATCH") {
        events.set(id, { ...existing, ...body });
        return Response.json({ id });
      }
      if (method === "DELETE") { events.delete(id); return new Response(null, { status: 204 }); }
    }
    throw new Error(`Request inesperado: ${method} ${url}`);
  });
  return { fetch, events, failures, requests };
}
