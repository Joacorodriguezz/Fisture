// Grupos del prode (docs/37 §3.2): crear, unirse, salir, administrar y la cascada al borrar la cuenta.
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, relojFijo } from "../../helpers/clock";
import { LIGA, COPA, sembrarProde } from "../../helpers/prode";
import { deleteAccount } from "../../../src/lib/db/account";
import {
  borrarGrupo,
  crearGrupo,
  expulsarMiembro,
  grupoParaMiembro,
  grupoPorCodigo,
  miembrosDeGrupo,
  misGrupos,
  regenerarCodigo,
  salirDeGrupo,
  unirseAGrupo,
} from "../../../src/lib/prode/repo";
import { MAX_GRUPOS_POR_USUARIO, MAX_MIEMBROS } from "../../../src/lib/prode/reglas";

describe("grupos del prode", () => {
  const t = useTestDb();
  relojFijo();

  beforeEach(async () => {
    await sembrarProde(t.DB);
  });

  async function nuevo(userId = "ana", nombre = "Los del Cinco") {
    const r = await crearGrupo(t.DB, { userId, nombre, ligaId: LIGA, ahora: AHORA });
    if (!r.ok) throw new Error(r.error);
    return r;
  }

  it("crear deja al creador como dueño y único miembro, con código y fecha de inicio", async () => {
    const { id, codigo } = await nuevo();
    expect(codigo).toMatch(/^[A-Z2-9]{8}$/);
    const g = await grupoParaMiembro(t.DB, id, "ana");
    expect(g).toMatchObject({ id, name: "Los del Cinco", leagueId: LIGA, ligaNombre: "Liga Profesional", inviteCode: codigo, miembros: 1, esAdmin: true });
    expect(g?.startsAt.getTime()).toBe(Math.floor(AHORA.getTime() / 1000) * 1000);
  });

  it("solo acepta competencias activas y destacadas", async () => {
    expect(await crearGrupo(t.DB, { userId: "ana", nombre: "Copa", ligaId: COPA, ahora: AHORA })).toEqual({ ok: false, error: "liga_invalida" });
    expect(await crearGrupo(t.DB, { userId: "ana", nombre: "Vieja", ligaId: "inactiva", ahora: AHORA })).toEqual({ ok: false, error: "liga_invalida" });
    expect(await crearGrupo(t.DB, { userId: "ana", nombre: "Nada", ligaId: "no-existe", ahora: AHORA })).toEqual({ ok: false, error: "liga_invalida" });
  });

  it(`no deja estar en más de ${MAX_GRUPOS_POR_USUARIO} grupos`, async () => {
    for (let i = 0; i < MAX_GRUPOS_POR_USUARIO; i++) await nuevo("ana", `Grupo ${i}`);
    expect(await crearGrupo(t.DB, { userId: "ana", nombre: "Uno más", ligaId: LIGA, ahora: AHORA })).toEqual({ ok: false, error: "limite_grupos" });
    const otro = await nuevo("beto");
    expect(await unirseAGrupo(t.DB, { userId: "ana", codigo: otro.codigo, ahora: AHORA })).toEqual({ ok: false, error: "limite_grupos" });
  });

  it("unirse con el código es idempotente y suma al miembro", async () => {
    const { id, codigo } = await nuevo();
    expect(await unirseAGrupo(t.DB, { userId: "beto", codigo, ahora: AHORA })).toEqual({ ok: true, grupoId: id, yaEraMiembro: false });
    expect(await unirseAGrupo(t.DB, { userId: "beto", codigo, ahora: AHORA })).toEqual({ ok: true, grupoId: id, yaEraMiembro: true });
    expect((await miembrosDeGrupo(t.DB, id)).map((m) => m.userId)).toEqual(["ana", "beto"]);
    expect(await grupoParaMiembro(t.DB, id, "beto")).toMatchObject({ miembros: 2, esAdmin: false });
  });

  it("un código inexistente no une a nadie", async () => {
    expect(await unirseAGrupo(t.DB, { userId: "beto", codigo: "ZZZZZZZZ", ahora: AHORA })).toEqual({ ok: false, error: "codigo_inexistente" });
    expect(await grupoPorCodigo(t.DB, "ZZZZZZZZ")).toBeNull();
  });

  it("la invitación muestra grupo, competencia, miembros y quién organiza, sin email", async () => {
    const { id, codigo } = await nuevo();
    const info = await grupoPorCodigo(t.DB, codigo);
    expect(info).toEqual({ id, name: "Los del Cinco", leagueId: LIGA, ligaNombre: "Liga Profesional", ligaLogo: null, ligaExternalId: "arg.1", miembros: 1, organizador: "Ana P." });
  });

  it(`un grupo lleno (${MAX_MIEMBROS}) no admite más miembros`, async () => {
    const { id, codigo } = await nuevo();
    const relleno = Array.from({ length: MAX_MIEMBROS - 1 }, (_, i) => `relleno-${i}`);
    await t.DB.batch(
      relleno.flatMap((u) => [
        t.DB.prepare("INSERT INTO users (id, email, provider, provider_id) VALUES (?1, ?2, 'google', ?1)").bind(u, `${u}@example.test`),
        t.DB.prepare("INSERT INTO prode_members (group_id, user_id, joined_at) VALUES (?1, ?2, 1)").bind(id, u),
      ])
    );
    expect(await unirseAGrupo(t.DB, { userId: "beto", codigo, ahora: AHORA })).toEqual({ ok: false, error: "grupo_lleno" });
    // Un miembro que ya estaba no recibe el error
    expect(await unirseAGrupo(t.DB, { userId: "ana", codigo, ahora: AHORA })).toMatchObject({ ok: true, yaEraMiembro: true });
  });

  it("quien no es miembro no ve el grupo", async () => {
    const { id } = await nuevo();
    expect(await grupoParaMiembro(t.DB, id, "beto")).toBeNull();
    expect(await grupoParaMiembro(t.DB, "no-existe", "ana")).toBeNull();
  });

  it("mis grupos lista los grupos del usuario, el más reciente primero, con la cantidad de miembros", async () => {
    const a = await nuevo("ana", "Primero");
    const b = await nuevo("beto", "Segundo");
    await unirseAGrupo(t.DB, { userId: "ana", codigo: b.codigo, ahora: new Date(AHORA.getTime() + 1000) });
    const lista = await misGrupos(t.DB, "ana");
    expect(lista.map((g) => [g.id, g.name, g.miembros])).toEqual([
      [b.id, "Segundo", 2],
      [a.id, "Primero", 1],
    ]);
    expect(await misGrupos(t.DB, "caro")).toEqual([]);
  });

  describe("administración", () => {
    it("regenerar el código invalida el anterior; solo el admin puede", async () => {
      const { id, codigo } = await nuevo();
      await unirseAGrupo(t.DB, { userId: "beto", codigo, ahora: AHORA });
      expect(await regenerarCodigo(t.DB, id, "beto")).toEqual({ ok: false, error: "no_admin" });
      const r = await regenerarCodigo(t.DB, id, "ana");
      if (!r.ok) throw new Error(r.error);
      expect(r.codigo).not.toBe(codigo);
      expect(await unirseAGrupo(t.DB, { userId: "caro", codigo, ahora: AHORA })).toEqual({ ok: false, error: "codigo_inexistente" });
      expect(await unirseAGrupo(t.DB, { userId: "caro", codigo: r.codigo, ahora: AHORA })).toMatchObject({ ok: true });
      expect(await regenerarCodigo(t.DB, "no-existe", "ana")).toEqual({ ok: false, error: "no_miembro" });
    });

    it("el admin saca a un miembro; no a sí mismo ni a quien no está", async () => {
      const { id, codigo } = await nuevo();
      await unirseAGrupo(t.DB, { userId: "beto", codigo, ahora: AHORA });
      expect(await expulsarMiembro(t.DB, id, "beto", "ana")).toEqual({ ok: false, error: "no_admin" });
      expect(await expulsarMiembro(t.DB, id, "ana", "ana")).toEqual({ ok: false, error: "es_vos" });
      expect(await expulsarMiembro(t.DB, id, "ana", "caro")).toEqual({ ok: false, error: "no_miembro" });
      expect(await expulsarMiembro(t.DB, id, "ana", "beto")).toEqual({ ok: true });
      expect(await grupoParaMiembro(t.DB, id, "beto")).toBeNull();
    });

    it("borrar el grupo es solo del admin y se lleva a los miembros", async () => {
      const { id, codigo } = await nuevo();
      await unirseAGrupo(t.DB, { userId: "beto", codigo, ahora: AHORA });
      expect(await borrarGrupo(t.DB, id, "beto")).toEqual({ ok: false, error: "no_admin" });
      expect(await borrarGrupo(t.DB, id, "ana")).toEqual({ ok: true });
      expect(await misGrupos(t.DB, "beto")).toEqual([]);
      expect(await borrarGrupo(t.DB, id, "ana")).toEqual({ ok: false, error: "no_miembro" });
    });

    it("si sale el dueño, administra el miembro más antiguo; si sale el último, el grupo se borra", async () => {
      const { id, codigo } = await nuevo();
      await unirseAGrupo(t.DB, { userId: "beto", codigo, ahora: new Date(AHORA.getTime() + 1000) });
      await unirseAGrupo(t.DB, { userId: "caro", codigo, ahora: new Date(AHORA.getTime() + 2000) });
      expect(await salirDeGrupo(t.DB, id, "ana")).toEqual({ ok: true, grupoBorrado: false });
      expect(await grupoParaMiembro(t.DB, id, "beto")).toMatchObject({ esAdmin: true, miembros: 2 });
      expect(await salirDeGrupo(t.DB, id, "caro")).toEqual({ ok: true, grupoBorrado: false });
      expect(await salirDeGrupo(t.DB, id, "beto")).toEqual({ ok: true, grupoBorrado: true });
      expect(await grupoPorCodigo(t.DB, codigo)).toBeNull();
      expect(await salirDeGrupo(t.DB, id, "beto")).toEqual({ ok: false, error: "no_miembro" });
    });

    it("si el dueño borra su cuenta, el grupo sigue y administra el miembro más antiguo", async () => {
      const { id, codigo } = await nuevo();
      await unirseAGrupo(t.DB, { userId: "beto", codigo, ahora: new Date(AHORA.getTime() + 1000) });
      await unirseAGrupo(t.DB, { userId: "caro", codigo, ahora: new Date(AHORA.getTime() + 2000) });
      await deleteAccount(t.DB, "ana");
      expect(await grupoParaMiembro(t.DB, id, "beto")).toMatchObject({ esAdmin: true, miembros: 2, ownerId: null });
      expect(await grupoParaMiembro(t.DB, id, "caro")).toMatchObject({ esAdmin: false });
      // El admin de respaldo puede administrar
      expect(await regenerarCodigo(t.DB, id, "beto")).toMatchObject({ ok: true });
      // Sin dueño, salir no traspasa nada: el siguiente más antiguo pasa a administrar solo
      expect(await salirDeGrupo(t.DB, id, "beto")).toEqual({ ok: true, grupoBorrado: false });
      expect(await grupoParaMiembro(t.DB, id, "caro")).toMatchObject({ esAdmin: true });
    });
  });
});
