import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import {
  NOMBRE_GENERICO,
  crearGrupo,
  detalleGrupo,
  generarCodigoInvitacion,
  misGrupos,
  normalizarNombre,
  unirseConCodigo,
} from "../../../src/lib/prode/grupos";

describe("prode: grupos privados", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;

  beforeEach(async () => {
    fixtures = await seedApp(t.db);
  });

  describe("normalizarNombre", () => {
    it("recorta y colapsa espacios", () => {
      expect(normalizarNombre("  Los   del   barrio ")).toBe("Los del barrio");
    });
    it("rechaza menos de 3 o más de 40 caracteres y lo que no es texto", () => {
      expect(normalizarNombre("ab")).toBeNull();
      expect(normalizarNombre("   ab   ")).toBeNull();
      expect(normalizarNombre("x".repeat(41))).toBeNull();
      expect(normalizarNombre(123)).toBeNull();
      expect(normalizarNombre("abc")).toBe("abc");
      expect(normalizarNombre("x".repeat(40))).toBe("x".repeat(40));
    });
  });

  describe("normalizarNombre: reglas de nombre público", () => {
    it("cuenta code points: 40 emojis entran, 41 no", () => {
      expect(normalizarNombre("😀".repeat(40))).not.toBeNull();
      expect(normalizarNombre("😀".repeat(41))).toBeNull();
    });
    it("rechaza emails, URLs e invisibles o bidi", () => {
      for (const n of ["escribime@mail.com", "https://sitio.com", "www.sitio", "mi-sitio.com.ar", "Los​amigos", "Los‮amigos", "Los\namigos"]) {
        expect(normalizarNombre(n), n).toBeNull();
      }
    });
    it("acepta puntos entre palabras", () => {
      expect(normalizarNombre("Los.Pibes")).toBe("Los.Pibes");
    });
  });

  it("el código de invitación es aleatorio, url-safe y largo", () => {
    const a = generarCodigoInvitacion();
    const b = generarCodigoInvitacion();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
  });

  it("crear un grupo deja al dueño como integrante", async () => {
    const g = await crearGrupo(t.db, fixtures.user.id, "Amigos");
    expect(g).toMatchObject({ name: "Amigos" });
    const detalle = await detalleGrupo(t.db, fixtures.user.id, g!.id);
    expect(detalle?.integrantes).toEqual([{ nombre: NOMBRE_GENERICO, esDueno: true, esVos: true }]);
    expect(detalle?.inviteCode).toBe(g!.inviteCode);
  });

  it("crear con nombre inválido devuelve null", async () => {
    expect(await crearGrupo(t.db, fixtures.user.id, "a")).toBeNull();
  });

  it("unirse con el código suma al integrante y es idempotente", async () => {
    const g = (await crearGrupo(t.db, fixtures.user.id, "Amigos"))!;
    const r1 = await unirseConCodigo(t.db, fixtures.other.id, g.inviteCode);
    const r2 = await unirseConCodigo(t.db, fixtures.other.id, g.inviteCode);
    expect(r1).toEqual({ id: g.id, name: "Amigos" });
    expect(r2).toEqual(r1);
    const detalle = await detalleGrupo(t.db, fixtures.other.id, g.id);
    expect(detalle?.integrantes).toHaveLength(2);
    expect(detalle?.integrantes.filter((i) => i.esVos)).toEqual([{ nombre: NOMBRE_GENERICO, esDueno: false, esVos: true }]);
    // El código solo lo ve el dueño
    expect(detalle?.inviteCode).toBeUndefined();
  });

  it("el dueño uniéndose a su propio grupo no se duplica", async () => {
    const g = (await crearGrupo(t.db, fixtures.user.id, "Amigos"))!;
    await unirseConCodigo(t.db, fixtures.user.id, g.inviteCode);
    expect((await detalleGrupo(t.db, fixtures.user.id, g.id))?.integrantes).toHaveLength(1);
  });

  it("un código inexistente o mal formado no une a nadie", async () => {
    expect(await unirseConCodigo(t.db, fixtures.other.id, "x".repeat(22))).toBeNull();
    expect(await unirseConCodigo(t.db, fixtures.other.id, "'; DROP TABLE users; --")).toBeNull();
    expect(await unirseConCodigo(t.db, fixtures.other.id, 42)).toBeNull();
  });

  it("un ajeno no ve el detalle del grupo", async () => {
    const g = (await crearGrupo(t.db, fixtures.user.id, "Amigos"))!;
    expect(await detalleGrupo(t.db, fixtures.other.id, g.id)).toBeNull();
    expect(await detalleGrupo(t.db, fixtures.other.id, "no-existe")).toBeNull();
  });

  it("los integrantes no exponen email ni ids", async () => {
    const g = (await crearGrupo(t.db, fixtures.user.id, "Amigos"))!;
    await unirseConCodigo(t.db, fixtures.other.id, g.inviteCode);
    const texto = JSON.stringify(await detalleGrupo(t.db, fixtures.user.id, g.id));
    expect(texto).not.toContain("@");
    expect(texto).not.toContain(fixtures.other.id);
  });

  it("misGrupos lista solo los grupos donde participa", async () => {
    const a = (await crearGrupo(t.db, fixtures.user.id, "Grupo A"))!;
    await crearGrupo(t.db, fixtures.other.id, "Grupo B");
    await unirseConCodigo(t.db, fixtures.other.id, a.inviteCode);
    expect(await misGrupos(t.db, fixtures.user.id)).toEqual([{ id: a.id, name: "Grupo A", esDueno: true, integrantes: 2 }]);
    const deOther = await misGrupos(t.db, fixtures.other.id);
    expect(deOther.map((g) => g.name).sort()).toEqual(["Grupo A", "Grupo B"]);
  });
});
