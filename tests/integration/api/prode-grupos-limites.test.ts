import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { apiCtx, silenciarConsola } from "../../helpers/ctx";
import { relojFijo } from "../../helpers/clock";
import { reiniciarMemoria } from "../../../src/lib/rate-limit/memory";
import { reiniciarConfig } from "../../../src/lib/rate-limit/config";
import { MAX_GRUPOS_POR_DUENO, crearGrupo } from "../../../src/lib/prode/grupos";
import { POST as crear } from "../../../src/pages/api/prode/grupos/index";
import { POST as unirse } from "../../../src/pages/api/prode/grupos/unirse";
import { GET as detalle } from "../../../src/pages/api/prode/grupos/[id]";
import { POLICIES } from "../../../src/lib/rate-limit/policies";

const APP = "https://fisture.test";

describe("API /api/prode/grupos: topes y límites", () => {
  const t = useTestDb();
  relojFijo();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;

  beforeEach(async () => {
    silenciarConsola(vi);
    reiniciarMemoria();
    reiniciarConfig();
    fixtures = await seedApp(t.db);
  });

  const env = () => ({ DB: t.DB, ENVIRONMENT: "test", PUBLIC_APP_URL: APP, RATE_LIMIT_SALT: "sal" });
  const peticion = (opts: { user?: { id: string }; ip?: string; body?: unknown; method?: string; url?: string; params?: Record<string, string> } = {}) =>
    apiCtx({
      url: opts.url ?? `${APP}/api/prode/grupos`,
      method: opts.method ?? "POST",
      headers: { "cf-connecting-ip": opts.ip ?? "203.0.113.7", "sec-fetch-site": "same-origin" },
      user: opts.user ?? fixtures.user,
      body: opts.body,
      params: opts.params,
      env: env(),
    });

  it("las políticas de creación son propias: 10 por hora por usuario y 30 por IP", () => {
    expect(POLICIES.prode_grupo_crear).toEqual({ limit: 10, windowSec: 3600, scope: "user" });
    expect(POLICIES.prode_grupo_crear_ip).toEqual({ limit: 30, windowSec: 3600, scope: "ip" });
  });

  it("el dueño no puede crear más de 10 grupos: 409 limite_de_grupos", async () => {
    for (let i = 0; i < MAX_GRUPOS_POR_DUENO; i++) await crearGrupo(t.db, fixtures.user.id, `Grupo ${i + 1}`);
    const res = await crear(peticion({ body: { nombre: "Uno de más" } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "limite_de_grupos" });

    // El tope es por dueño: otro usuario puede crear, y unirse a grupos ajenos no cuenta
    expect((await crear(peticion({ user: fixtures.other, body: { nombre: "Del otro" } }))).status).toBe(201);
  });

  it("con 9 grupos, dos creaciones simultáneas: una entra (201) y la otra da 409, quedan 10", async () => {
    for (let i = 0; i < MAX_GRUPOS_POR_DUENO - 1; i++) await crearGrupo(t.db, fixtures.user.id, `Grupo ${i + 1}`);
    const [a, b] = await Promise.all([crear(peticion({ body: { nombre: "Carrera A" } })), crear(peticion({ body: { nombre: "Carrera B" } }))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const fila = await t.DB.prepare("SELECT count(*) AS n FROM prode_groups WHERE owner_id = ?").bind(fixtures.user.id).first<{ n: number }>();
    expect(fila?.n).toBe(MAX_GRUPOS_POR_DUENO);
    // La membresía del dueño solo existe para los grupos que sí se crearon
    const m = await t.DB.prepare("SELECT count(*) AS n FROM prode_group_members WHERE user_id = ?").bind(fixtures.user.id).first<{ n: number }>();
    expect(m?.n).toBe(MAX_GRUPOS_POR_DUENO);
  });

  it("crearGrupo devuelve 'limite' sin insertar nada cuando el dueño ya tiene 10", async () => {
    for (let i = 0; i < MAX_GRUPOS_POR_DUENO; i++) await crearGrupo(t.db, fixtures.user.id, `Grupo ${i + 1}`);
    expect(await crearGrupo(t.db, fixtures.user.id, "Uno más")).toBe("limite");
  });

  it("crear con rate limit: la creación 11 en una hora da 429", async () => {
    // 10 creaciones válidas (el tope de grupos llega justo a 10), la 11 la frena el límite de tasa
    for (let i = 0; i < 10; i++) expect((await crear(peticion({ body: { nombre: `Grupo ${i + 1}` } }))).status).toBe(201);
    const res = await crear(peticion({ body: { nombre: "Grupo 11" } }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  it("unirse con rate limit: la request 11 en 10 minutos da 429, aunque el código sea inválido", async () => {
    const intento = () => unirse(peticion({ user: fixtures.other, url: `${APP}/api/prode/grupos/unirse`, body: { codigo: "A".repeat(22) } }));
    for (let i = 0; i < 10; i++) expect((await intento()).status).toBe(404);
    const res = await intento();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("unirse con rate limit por IP: 30 por ventana entre usuarios distintos", async () => {
    const desde = (id: string) => unirse(peticion({ user: { id }, url: `${APP}/api/prode/grupos/unirse`, body: { codigo: "A".repeat(22) } }));
    for (let i = 0; i < 30; i++) expect((await desde(`u${i}`)).status).toBe(404);
    expect((await desde("u-final")).status).toBe(429);
  });

  it("un no-dueño no recibe inviteCode en el detalle, el dueño sí", async () => {
    const g = (await crearGrupo(t.db, fixtures.user.id, "Amigos"))!;
    await t.DB.prepare("INSERT INTO prode_group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)").bind(g.id, fixtures.other.id, 1).run();

    const comoOtro = await detalle(peticion({ user: fixtures.other, method: "GET", params: { id: g.id } }));
    const texto = JSON.stringify(await comoOtro.json());
    expect(comoOtro.status).toBe(200);
    expect(texto).not.toContain(g.inviteCode);
    expect(texto).not.toContain("inviteCode");

    const comoDueno = (await (await detalle(peticion({ method: "GET", params: { id: g.id } }))).json()) as { inviteCode?: string };
    expect(comoDueno.inviteCode).toBe(g.inviteCode);
  });

  it("el detalle de un grupo ajeno da el mismo 404 que uno inexistente, sin filtrar nada", async () => {
    const g = (await crearGrupo(t.db, fixtures.user.id, "Secreto"))!;
    const ajeno = await detalle(peticion({ user: fixtures.other, method: "GET", params: { id: g.id } }));
    const inexistente = await detalle(peticion({ user: fixtures.other, method: "GET", params: { id: "no-existe" } }));
    expect(ajeno.status).toBe(404);
    expect(inexistente.status).toBe(404);
    const cuerpoAjeno = await ajeno.text();
    expect(cuerpoAjeno).toBe(await inexistente.text());
    expect(cuerpoAjeno).not.toContain("Secreto");
    expect(cuerpoAjeno).not.toContain(g.inviteCode);
  });
});
