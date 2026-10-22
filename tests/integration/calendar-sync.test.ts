import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../helpers/clock";
import { ENV_VACIO, seedApp } from "../helpers/fixtures";
import { calendarHttp } from "../helpers/calendar-http";
import { calendarSyncs, matches, userTeams } from "../../drizzle/schema";
import { markOutdatedEvents, removeMatchFromCalendar, reconcileCalendars, syncMatches } from "../../src/lib/calendar/sync-service";

describe("servicio → cliente HTTP → D1", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  let http: ReturnType<typeof calendarHttp>;
  relojFijo();
  beforeEach(async () => {
    fixtures = await seedApp(t.db);
    http = calendarHttp();
    vi.stubGlobal("fetch", http.fetch);
  });

  const sincronizar = (user = fixtures.user) => syncMatches(t.db, ENV_VACIO, user, ["superclasico"]);
  const filasSync = () => t.db.select().from(calendarSyncs);
  const metodos = (metodo: string) => http.requests.filter((r) => r.method === metodo);

  describe.each(["google", "microsoft"])("%s", (provider) => {
    const usuario = () => (provider === "google" ? fixtures.user : fixtures.other);
    let eventId: string;

    beforeEach(async () => {
      expect(await sincronizar(usuario())).toEqual([{ matchId: "superclasico", success: true }]);
      [{ externalEventId: eventId }] = (await filasSync()) as [{ externalEventId: string }];
    });

    // Cambios que el usuario hizo a mano en su calendario: el sync no debe pisarlos
    const editarComoUsuario = () =>
      Object.assign(
        http.events.get(eventId)!,
        provider === "google"
          ? { description: "Mis notas", reminders: { useDefault: true }, colorId: "3" }
          : { body: { contentType: "text", content: "Mis notas" }, reminderMinutesBeforeStart: 5 }
      );
    const reprogramar = () => t.db.update(matches).set({ dateTime: new Date(AHORA.getTime() + 2 * DIA_MS), venue: "Nueva sede" }).where(eq(matches.id, "superclasico"));

    it("el alta crea un solo evento y guarda su referencia", async () => {
      expect(http.events.size).toBe(1);
      expect(await filasSync()).toEqual([expect.objectContaining({ externalEventId: eventId, status: "synced", userId: usuario().id })]);
    });

    it("repetir el sync con el partido al día no consulta al proveedor", async () => {
      const antes = http.requests.length;
      await sincronizar(usuario());
      expect(http.requests).toHaveLength(antes);
    });

    it("tras reprogramar, markOutdatedEvents marca exactamente un evento", async () => {
      await reprogramar();
      expect(await markOutdatedEvents(t.db, usuario().id)).toBe(1);
    });

    it("la reprogramación actualiza hora y sede con un PATCH, sin crear otro evento", async () => {
      await reprogramar();
      await markOutdatedEvents(t.db, usuario().id);
      await sincronizar(usuario());

      expect(metodos("POST")).toHaveLength(1);
      expect(metodos("PATCH")).toHaveLength(1);
      expect(await filasSync()).toEqual([expect.objectContaining({ externalEventId: eventId, status: "synced", syncedVenue: "Nueva sede", syncedState: "scheduled" })]);
    });

    it("la reprogramación conserva lo que el usuario editó en el evento", async () => {
      editarComoUsuario();
      await reprogramar();
      await markOutdatedEvents(t.db, usuario().id);
      await sincronizar(usuario());

      expect(http.events.get(eventId)).toMatchObject(
        provider === "google"
          ? { description: "Mis notas", reminders: { useDefault: true }, colorId: "3", location: "Nueva sede" }
          : { body: { content: "Mis notas" }, reminderMinutesBeforeStart: 5, location: { displayName: "Nueva sede" } }
      );
    });

    it("después de actualizar no quedan eventos desactualizados", async () => {
      await reprogramar();
      await markOutdatedEvents(t.db, usuario().id);
      await sincronizar(usuario());
      expect(await markOutdatedEvents(t.db, usuario().id)).toBe(0);
    });

    it("quitar el partido borra el evento y la fila", async () => {
      await removeMatchFromCalendar(t.db, ENV_VACIO, usuario(), "superclasico");
      expect(http.events.size).toBe(0);
      expect(await filasSync()).toHaveLength(0);
    });
  });

  describe.each(["google", "microsoft"])("%s: concurrencia", (provider) => {
    it("dos requests concurrentes dejan un evento y una fila", async () => {
      const user = provider === "google" ? fixtures.user : fixtures.other;
      const results = await Promise.all([sincronizar(user), sincronizar(user)]);

      expect(results.flat().every((r) => r.success)).toBe(true);
      expect(http.events.size).toBe(1);
      expect(await filasSync()).toHaveLength(1);
    });
  });

  describe.each([
    [503, "transient", "failed"],
    [429, "rate_limit", "synced"],
    [401, "auth", "synced"],
  ])("HTTP %i al actualizar", (status, code, estadoTrasFallo) => {
    beforeEach(async () => {
      await sincronizar();
      await t.db.update(matches).set({ venue: "Otra sede" });
      http.failures.push({ method: "PATCH", status, message: "Calendar unavailable", match: /\/events\// });
    });

    it(`informa el código ${code} y no crea otro evento`, async () => {
      const [resultado] = await sincronizar();
      expect(resultado).toMatchObject({ success: false, code });
      expect(http.events.size).toBe(1);
      expect(metodos("POST")).toHaveLength(1);
    });

    it(`deja la fila en ${estadoTrasFallo} conservando la referencia al evento`, async () => {
      await sincronizar();
      expect((await filasSync())[0]).toMatchObject({ status: estadoTrasFallo, externalEventId: expect.any(String) });
    });

    it("el siguiente intento se recupera sin error residual", async () => {
      await sincronizar();
      await sincronizar();
      expect(await filasSync()).toEqual([expect.objectContaining({ status: "synced", syncedVenue: "Otra sede", errorMessage: null })]);
    });
  });

  describe("reconciliación del cron", () => {
    beforeEach(async () => {
      await sincronizar();
    });

    it("corrige eventos manuales aunque el usuario no tenga auto-sync", async () => {
      await t.db.update(matches).set({ venue: "Otra sede" });
      await reconcileCalendars(ENV_VACIO, t.db);
      expect((await filasSync())[0]).toMatchObject({ status: "synced", syncedVenue: "Otra sede" });
    });

    it("si el usuario borró el evento queda detached y no se recrea", async () => {
      http.events.clear();
      await t.db.update(matches).set({ venue: "Tercera sede" });
      await reconcileCalendars(ENV_VACIO, t.db);
      expect((await filasSync())[0]).toMatchObject({ status: "detached", externalEventId: null });
    });

    it("el auto-sync posterior no resucita un evento detached", async () => {
      http.events.clear();
      await t.db.update(matches).set({ venue: "Tercera sede" });
      await reconcileCalendars(ENV_VACIO, t.db);
      await t.db.insert(userTeams).values({ userId: fixtures.user.id, teamId: "river", autoSync: true });
      await reconcileCalendars(ENV_VACIO, t.db);
      expect(http.events.size).toBe(0);
    });

    it("un pedido manual explícito sí recrea un evento detached", async () => {
      http.events.clear();
      await t.db.update(matches).set({ venue: "Tercera sede" });
      await reconcileCalendars(ENV_VACIO, t.db);
      await sincronizar();
      expect(http.events.size).toBe(1);
    });
  });

  it("los calendarios de distintos usuarios quedan aislados", async () => {
    await sincronizar(fixtures.user);
    await sincronizar(fixtures.other);
    await removeMatchFromCalendar(t.db, ENV_VACIO, fixtures.other, "superclasico");
    expect(http.events.size).toBe(1);
    expect(await filasSync()).toEqual([expect.objectContaining({ userId: fixtures.user.id })]);
  });
});
