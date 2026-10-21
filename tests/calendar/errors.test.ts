import { describe, expect, it } from "vitest";
import { CalendarApiError, classifyCalendarError, throwIfNotOk } from "../../src/lib/calendar/errors";

const api = (status: number, reason?: string, retryAfter?: number) =>
  new CalendarApiError("x", status, { reason, retryAfter });

describe("classifyCalendarError", () => {
  it.each([
    [401, undefined, "auth"],
    [404, undefined, "gone"],
    [410, undefined, "gone"],
    [429, undefined, "rate_limit"],
    [403, "rateLimitExceeded", "rate_limit"],
    [403, "userRateLimitExceeded", "rate_limit"],
    [403, "forbidden", "permanent"],
    [500, undefined, "transient"],
    [503, undefined, "transient"],
    [409, undefined, "conflict"],
    [400, undefined, "permanent"],
  ])("HTTP %s (%s) → %s", (status, reason, esperado) => {
    expect(classifyCalendarError(api(status, reason))).toBe(esperado);
  });

  it("un error de red (no HTTP) es transitorio", () => {
    expect(classifyCalendarError(new TypeError("fetch failed"))).toBe("transient");
  });

  it("los errores de token (sin token, permiso vencido, invalid_grant) son auth", () => {
    expect(classifyCalendarError(new Error("No calendar access token"))).toBe("auth");
    expect(classifyCalendarError(new Error("Calendar permission expired. Volvé a iniciar sesión."))).toBe("auth");
    expect(classifyCalendarError(new Error("OAuth request failed: invalid_grant"))).toBe("auth");
  });
});

describe("throwIfNotOk", () => {
  it("no hace nada si la respuesta es ok", async () => {
    await expect(throwIfNotOk(new Response("{}", { status: 200 }), "falló")).resolves.toBeUndefined();
  });

  it("lanza CalendarApiError con status, motivo y Retry-After, aunque el cuerpo no sea JSON", async () => {
    const res = new Response(
      JSON.stringify({ error: { message: "cuota", errors: [{ reason: "rateLimitExceeded" }] } }),
      { status: 403, headers: { "Retry-After": "30" } }
    );
    const err = await throwIfNotOk(res, "falló").catch((e) => e);
    expect(err).toBeInstanceOf(CalendarApiError);
    expect(err).toMatchObject({ status: 403, reason: "rateLimitExceeded", retryAfter: 30, message: "cuota" });

    const html = await throwIfNotOk(new Response("<html>502</html>", { status: 502 }), "falló").catch((e) => e);
    expect(html).toMatchObject({ status: 502, message: "falló" });
  });
});
