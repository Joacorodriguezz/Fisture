// Paso 1 de docs/31: datos que necesita el rediseño (hora anterior del evento, auto-sync por
// defecto y onboarding). Sin cambios visibles todavía.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../helpers/clock";
import { ENV_VACIO, seedApp } from "../helpers/fixtures";
import { calendarHttp } from "../helpers/calendar-http";
import { callApi } from "../helpers/api";
import { silenciarConsola } from "../helpers/ctx";
import { calendarSyncs, matches, userTeams } from "../../drizzle/schema";
import { markOutdatedEvents, syncMatches } from "../../src/lib/calendar/sync-service";
import { GET as leerPreferencias, PATCH as cambiarPreferencias } from "../../src/pages/api/preferencias";
import { POST as seguirEquipo } from "../../src/pages/api/equipos/index";

describe("rediseño, paso 1: datos base", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();

  beforeEach(async () => {
    silenciarConsola(vi);
    fixtures = await seedApp(t.db);
  });

  describe("hora anterior del evento (Horario actualizado)", () => {
    let http: ReturnType<typeof calendarHttp>;
    beforeEach(() => {
      http = calendarHttp();
      vi.stubGlobal("fetch", http.fetch);
    });

    const sincronizar = () => syncMatches(t.db, ENV_VACIO, fixtures.user, ["superclasico"]);
    const fila = async () => (await t.db.select().from(calendarSyncs).where(eq(calendarSyncs.userId, fixtures.user.id)))[0]!;
    const cambiarPartido = async (cambios: Partial<typeof matches.$inferInsert>) => {
      await t.db.update(matches).set(cambios).where(eq(matches.id, "superclasico"));
      await markOutdatedEvents(t.db, fixtures.user.id);
      await sincronizar();
    };

    it("el alta no tiene hora anterior", async () => {
      await sincronizar();
      expect(await fila()).toMatchObject({ status: "synced", previousDateTime: null, dateTimeChangedAt: null });
    });

    it("al cambiar la hora guarda la anterior y cuándo cambió", async () => {
      await sincronizar();
      const original = (await fila()).syncedDateTime!;
      const nueva = new Date(AHORA.getTime() + 2 * DIA_MS);
      await cambiarPartido({ dateTime: nueva });

      const despues = await fila();
      expect(despues.syncedDateTime).toEqual(nueva);
      expect(despues.previousDateTime).toEqual(original);
      expect(despues.dateTimeChangedAt).toEqual(AHORA);
    });

    it("un cambio solo de sede no toca la hora anterior", async () => {
      await sincronizar();
      await cambiarPartido({ venue: "Otra sede" });
      expect(await fila()).toMatchObject({ syncedVenue: "Otra sede", previousDateTime: null, dateTimeChangedAt: null });
    });

    it("un cambio de sede posterior conserva la hora anterior ya guardada", async () => {
      await sincronizar();
      const original = (await fila()).syncedDateTime!;
      await cambiarPartido({ dateTime: new Date(AHORA.getTime() + 2 * DIA_MS) });
      await cambiarPartido({ venue: "Otra sede" });
      expect((await fila()).previousDateTime).toEqual(original);
    });
  });

  describe("auto-sync por defecto", () => {
    const preferencias = async () => (await callApi(leerPreferencias, t.DB, { user: fixtures.user })).json();
    const seguir = (teamId: string) => callApi(seguirEquipo, t.DB, { user: fixtures.user, method: "POST", body: { teamId } });
    const autoSyncDe = async (teamId: string) =>
      (await t.db.select().from(userTeams)).find((ut) => ut.userId === fixtures.user.id && ut.teamId === teamId)?.autoSync;

    it("arranca activado", async () => {
      expect(await preferencias()).toMatchObject({ autoSyncDefault: true });
    });

    it("se puede apagar y queda guardado", async () => {
      const res = await callApi(cambiarPreferencias, t.DB, { user: fixtures.user, method: "PATCH", body: { autoSyncDefault: false } });
      expect(await res.json()).toMatchObject({ autoSyncDefault: false });
      expect(await preferencias()).toMatchObject({ autoSyncDefault: false });
    });

    it("un valor no booleano se ignora", async () => {
      const res = await callApi(cambiarPreferencias, t.DB, { user: fixtures.user, method: "PATCH", body: { autoSyncDefault: "no", theme: "papel" } });
      expect(await res.json()).toMatchObject({ autoSyncDefault: true });
    });

    it("seguir un equipo usa el valor por defecto del usuario", async () => {
      await callApi(cambiarPreferencias, t.DB, { user: fixtures.user, method: "PATCH", body: { autoSyncDefault: false } });
      expect((await seguir("boca")).status).toBe(201);
      expect(await autoSyncDe("boca")).toBe(false);
    });

    it("sin preferencias guardadas, seguir activa el auto-sync", async () => {
      expect((await seguir("boca")).status).toBe(201);
      expect(await autoSyncDe("boca")).toBe(true);
    });
  });
});
