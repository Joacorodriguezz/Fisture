// POST /api/admin/encrypt-tokens: backfill del cifrado de tokens (docs/15 D5, K13 y K14).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { claro, ENV_CON_CLAVE, nuevaClave, TOKEN_ENCRYPTION_KEY } from "../../helpers/token-key";
import { decryptToken, encryptToken } from "../../../src/lib/auth/token-crypto";
import { LOTE_FILAS, procesarTokens } from "../../../src/lib/auth/token-backfill";
import { createDb, type Database } from "../../../src/lib/db";
import { POST } from "../../../src/pages/api/admin/encrypt-tokens";
import { GET as statusGET } from "../../../src/pages/api/admin/status";

const ADMIN = "admin-de-prueba";

describe("POST /api/admin/encrypt-tokens", () => {
  const t = useTestDb();
  let lineas: string[];

  beforeEach(() => {
    silenciarConsola(vi);
    lineas = [];
    for (const metodo of ["log", "warn", "error"] as const) {
      vi.spyOn(console, metodo).mockImplementation((l: unknown) => void lineas.push(String(l)));
    }
  });

  const llamar = async (opts: { auth?: string | null; env?: Record<string, unknown>; query?: string } = {}) => {
    const res = await POST(
      apiCtx({
        url: `https://fisture.test/api/admin/encrypt-tokens${opts.query ?? ""}`,
        method: "POST",
        headers: opts.auth === null ? {} : { Authorization: opts.auth ?? `Bearer ${ADMIN}` },
        env: { ENVIRONMENT: "test", DB: t.DB, KV: kvEnMemoria(), ADMIN_SECRET: ADMIN, TOKEN_ENCRYPTION_KEY, ...opts.env },
      })
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  const usuario = (id: string, access: string | null, refresh: string | null) =>
    t.DB.prepare("INSERT INTO users (id, email, provider, provider_id, access_token, refresh_token) VALUES (?1, ?2, 'google', ?3, ?4, ?5)")
      .bind(id, `${id}@example.test`, `p-${id}`, access, refresh).run();
  const identidad = (id: string, userId: string, access: string | null, refresh: string | null) =>
    t.DB.prepare("INSERT INTO oauth_identities (id, user_id, provider, provider_id, access_token, refresh_token) VALUES (?1, ?2, 'google', ?3, ?4, ?5)")
      .bind(id, userId, `p-${id}`, access, refresh).run();
  const fila = async (tabla: string, id: string) => (await t.DB.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).bind(id).first<any>())!;
  const todas = async () => [...(await t.DB.prepare("SELECT * FROM users ORDER BY id").all<any>()).results, ...(await t.DB.prepare("SELECT * FROM oauth_identities ORDER BY id").all<any>()).results];

  it("K14: sin Bearer o con uno incorrecto responde 401 y no toca la base", async () => {
    await usuario("u1", "at-1", "rt-1");
    for (const auth of [null, "Bearer otro", ADMIN]) expect((await llamar({ auth })).status).toBe(401);
    expect((await llamar({ env: { ADMIN_SECRET: undefined } })).status).toBe(401);
    expect(await fila("users", "u1")).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
  });

  it("sin clave responde 503 y no toca la base", async () => {
    await usuario("u1", "at-1", "rt-1");
    const res = await llamar({ env: { TOKEN_ENCRYPTION_KEY: undefined } });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "token_key_missing" });
    expect(await fila("users", "u1")).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
  });

  it("K13: cifra las filas legadas de users y oauth_identities, y una segunda corrida no cambia nada", async () => {
    await usuario("u1", "at-1", "rt-1");
    await usuario("u2", "at-2", null);
    await identidad("u1", "u1", "at-1", "rt-1");
    await identidad("i2", "u2", "at-i2", "rt-i2");

    const primera = await llamar();
    expect(primera.body).toEqual({ direccion: "encrypt", cursor: null, siguienteCursor: null, procesadas: 4, ilegibles: 0, pendientes: 0 });

    for (const [tabla, id] of [["users", "u1"], ["users", "u2"], ["oauth_identities", "u1"], ["oauth_identities", "i2"]] as const) {
      const f = await fila(tabla, id);
      expect(f.access_token).toMatch(/^enc:v1:/);
      if (f.refresh_token) expect(f.refresh_token).toMatch(/^enc:v1:/);
    }
    expect(await claro((await fila("oauth_identities", "i2")).refresh_token, "i2", "refresh_token")).toBe("rt-i2");
    expect((await fila("users", "u2")).refresh_token).toBeNull();

    const antes = await todas();
    const segunda = await llamar();
    expect(segunda.body).toEqual({ direccion: "encrypt", cursor: null, siguienteCursor: null, procesadas: 0, ilegibles: 0, pendientes: 0 });
    expect(await todas()).toEqual(antes);
  });

  it("procesa por lotes acotados y se repite hasta pendientes 0", async () => {
    const total = LOTE_FILAS + 5;
    for (let i = 0; i < total; i++) await usuario(`u${String(i).padStart(2, "0")}`, `at-${i}`, `rt-${i}`);

    const primera = await llamar();
    expect(primera.body).toMatchObject({ procesadas: LOTE_FILAS, pendientes: 5, siguienteCursor: `users:u${String(LOTE_FILAS - 1).padStart(2, "0")}` });
    const segunda = await llamar({ query: `?cursor=${primera.body.siguienteCursor}` });
    expect(segunda.body).toMatchObject({ procesadas: 5, pendientes: 0, siguienteCursor: null });
    expect((await llamar()).body).toMatchObject({ procesadas: 0, pendientes: 0, siguienteCursor: null });
  });

  it("rotación: con la clave anterior cargada re-cifra lo que sigue con ella y deja legible solo con la nueva", async () => {
    const vieja = nuevaClave();
    await usuario("u1", await encryptToken({ TOKEN_ENCRYPTION_KEY: vieja } as Env, "at-1", "u1:access_token"), await encryptToken({ TOKEN_ENCRYPTION_KEY: vieja } as Env, "rt-1", "u1:refresh_token"));
    await usuario("u2", "at-legado", null);
    const nueva = nuevaClave();
    const env = { TOKEN_ENCRYPTION_KEY: nueva, TOKEN_ENCRYPTION_KEY_PREVIOUS: vieja };

    expect((await llamar({ env })).body).toMatchObject({ procesadas: 2, ilegibles: 0, pendientes: 0 });
    expect(await decryptToken({ TOKEN_ENCRYPTION_KEY: nueva } as Env, (await fila("users", "u1")).refresh_token, "u1:refresh_token")).toBe("rt-1");
    expect(await decryptToken({ TOKEN_ENCRYPTION_KEY: nueva } as Env, (await fila("users", "u2")).access_token, "u2:access_token")).toBe("at-legado");
    expect((await llamar({ env })).body).toMatchObject({ procesadas: 0, pendientes: 0 });
  });

  it("una fila cifrada que no se puede leer se cuenta aparte y no se toca", async () => {
    const ajeno = await encryptToken({ TOKEN_ENCRYPTION_KEY: nuevaClave() } as Env, "at-x", "u1:access_token");
    await usuario("u1", "at-1", "rt-1");
    await usuario("u2", ajeno, null);
    const env = { TOKEN_ENCRYPTION_KEY: nuevaClave(), TOKEN_ENCRYPTION_KEY_PREVIOUS: nuevaClave() };
    const res = await llamar({ env });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ procesadas: 1, ilegibles: 1, pendientes: 0 });
    expect((await fila("users", "u2")).access_token).toBe(ajeno);
  });

  it("?direction=decrypt devuelve las filas a texto plano (solo para el rollback)", async () => {
    await usuario("u1", await encryptToken(ENV_CON_CLAVE, "at-1", "u1:access_token"), await encryptToken(ENV_CON_CLAVE, "rt-1", "u1:refresh_token"));
    await identidad("i1", "u1", await encryptToken(ENV_CON_CLAVE, "at-i", "i1:access_token"), null);
    await usuario("u2", "at-ya-claro", null);

    const res = await llamar({ query: "?direction=decrypt" });
    expect(res.body).toEqual({ direccion: "decrypt", cursor: null, siguienteCursor: null, procesadas: 2, ilegibles: 0, pendientes: 0 });
    expect(await fila("users", "u1")).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
    expect(await fila("oauth_identities", "i1")).toMatchObject({ access_token: "at-i" });
    expect((await fila("users", "u2")).access_token).toBe("at-ya-claro");
  });

  // docs/15 revisión: paginación con cursor, ilegibles aparte, filas mixtas y escrituras condicionales
  const ajenoEnc = (id: string, col: "access_token" | "refresh_token", valor = "x") => encryptToken({ TOKEN_ENCRYPTION_KEY: nuevaClave() } as Env, valor, `${id}:${col}`);
  const recorrer = async (opts: { query?: string; env?: Record<string, unknown> } = {}) => {
    const paginas: any[] = [];
    let cursor: string | null = null;
    do {
      const sep = opts.query ? "&" : "?";
      const res = await llamar({ env: opts.env, query: `${opts.query ?? ""}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ""}` });
      expect(res.status).toBe(200);
      paginas.push(res.body);
      cursor = res.body.siguienteCursor;
    } while (cursor && paginas.length < 50);
    return paginas;
  };
  const id2 = (i: number) => `u${String(i).padStart(2, "0")}`;

  it("decrypt con filas ilegibles avanza con el cursor y no las cuenta como pendientes", async () => {
    const total = LOTE_FILAS + 5;
    for (let i = 0; i < total; i++) await usuario(id2(i), await ajenoEnc(id2(i), "access_token"), null);
    await usuario("z-ok", await encryptToken(ENV_CON_CLAVE, "at-ok", "z-ok:access_token"), null);

    const paginas = await recorrer({ query: "?direction=decrypt" });
    expect(paginas.length).toBeGreaterThan(1);
    expect(paginas.reduce((n, p) => n + p.ilegibles, 0)).toBe(total);
    expect(paginas.reduce((n, p) => n + p.procesadas, 0)).toBe(1);
    // Las ilegibles de páginas anteriores siguen cifradas: la última respuesta las cuenta (el código viejo tampoco las lee)
    expect(paginas[paginas.length - 1]).toMatchObject({ siguienteCursor: null, pendientes: total });
    expect((await fila("users", "z-ok")).access_token).toBe("at-ok");
  });

  it("decrypt: la última página cuenta lo que sigue cifrado aunque se haya salteado en páginas anteriores", async () => {
    // Las ilegibles ocupan las primeras páginas; la fila legible queda sola en la última
    for (let i = 0; i < LOTE_FILAS; i++) await usuario(id2(i), await ajenoEnc(id2(i), "access_token"), null);
    await usuario("z-ok", await encryptToken(ENV_CON_CLAVE, "at-ok", "z-ok:access_token"), null);
    const paginas = await recorrer({ query: "?direction=decrypt" });
    const ultima = paginas[paginas.length - 1];
    expect(ultima).toMatchObject({ siguienteCursor: null, procesadas: 1 });
    expect(ultima.pendientes).toBe(LOTE_FILAS);
  });

  it("una fila mixta (access cifrado, refresh en claro) se convierte una vez y no deja pendientes", async () => {
    const mixta = async () => usuario("u1", await encryptToken(ENV_CON_CLAVE, "at-1", "u1:access_token"), "rt-claro");
    await mixta();
    const rotando = { TOKEN_ENCRYPTION_KEY_PREVIOUS: nuevaClave() }; // la fila entra por las dos condiciones
    const e = await llamar({ env: rotando });
    expect(e.body).toMatchObject({ procesadas: 1, ilegibles: 0, pendientes: 0, siguienteCursor: null });
    expect((await fila("users", "u1")).refresh_token).toMatch(/^enc:v1:/);
    expect((await llamar({ env: rotando })).body).toMatchObject({ procesadas: 0, pendientes: 0 });

    await t.DB.prepare("UPDATE users SET refresh_token = 'rt-claro' WHERE id = 'u1'").run();
    expect((await llamar({ query: "?direction=decrypt" })).body).toMatchObject({ procesadas: 1, pendientes: 0 });
    expect(await fila("users", "u1")).toMatchObject({ access_token: "at-1", refresh_token: "rt-claro" });
  });

  it("rotación paginada: lee de a LOTE_FILAS filas con el cursor y rota todas", async () => {
    const vieja = nuevaClave();
    const nueva = nuevaClave();
    const total = LOTE_FILAS * 2 + 3;
    for (let i = 0; i < total; i++) await usuario(id2(i), await encryptToken({ TOKEN_ENCRYPTION_KEY: vieja } as Env, `at-${i}`, `${id2(i)}:access_token`), null);
    await identidad("i1", "u00", await encryptToken({ TOKEN_ENCRYPTION_KEY: vieja } as Env, "at-i", "i1:access_token"), null);
    const env = { TOKEN_ENCRYPTION_KEY: nueva, TOKEN_ENCRYPTION_KEY_PREVIOUS: vieja };

    const paginas = await recorrer({ env });
    expect(paginas.length).toBe(Math.ceil((total + 1) / LOTE_FILAS));
    for (const p of paginas) expect(p.procesadas).toBeLessThanOrEqual(LOTE_FILAS);
    expect(paginas.reduce((n, p) => n + p.procesadas, 0)).toBe(total + 1);
    expect(await decryptToken({ TOKEN_ENCRYPTION_KEY: nueva } as Env, (await fila("users", id2(total - 1))).access_token, `${id2(total - 1)}:access_token`)).toBe(`at-${total - 1}`);
    expect(await decryptToken({ TOKEN_ENCRYPTION_KEY: nueva } as Env, (await fila("oauth_identities", "i1")).access_token, "i1:access_token")).toBe("at-i");
    expect((await recorrer({ env })).reduce((n, p) => n + p.procesadas, 0)).toBe(0);
  });

  it("un cursor mal formado responde 400", async () => {
    await usuario("u1", "at", null);
    for (const cursor of ["basura", "otra:u1", "users:"]) expect((await llamar({ query: `?cursor=${cursor}` })).status).toBe(400);
  });

  it("TOKEN_ENCRYPTION_KEY_PREVIOUS mal formada responde 503 y no toca la base", async () => {
    await usuario("u1", "at-1", null);
    const res = await llamar({ env: { TOKEN_ENCRYPTION_KEY_PREVIOUS: btoa("corta") } });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "token_key_previous_invalid" });
    expect((await fila("users", "u1")).access_token).toBe("at-1");
  });

  describe("carrera con un login: no pisa lo que cambió entre la lectura y el batch", () => {
    // Un login escribe tokens nuevos justo después de que el backfill leyó la fila
    const conLoginEnMedio = (sqlLogin: string) => {
      let hecho = false;
      const db = createDb(t.DB);
      return new Proxy(db, {
        get(target, prop) {
          const valor = (target as any)[prop];
          if (prop !== "all") return typeof valor === "function" ? valor.bind(target) : valor;
          return async (...args: unknown[]) => {
            const filasLeidas = await valor.apply(target, args);
            if (!hecho && Array.isArray(filasLeidas) && filasLeidas.length > 0 && "access_token" in filasLeidas[0]) {
              hecho = true;
              await t.DB.prepare(sqlLogin).run();
            }
            return filasLeidas;
          };
        },
      }) as Database;
    };

    it("encrypt, users: el batch no pisa los tokens nuevos y la fila queda pendiente", async () => {
      await usuario("u1", "at-viejo", "rt-viejo");
      const enc = await encryptToken(ENV_CON_CLAVE, "at-login", "u1:access_token");
      const r = await procesarTokens(ENV_CON_CLAVE, conLoginEnMedio(`UPDATE users SET access_token = '${enc}', refresh_token = 'rt-login' WHERE id = 'u1'`), "encrypt");
      expect(r).toMatchObject({ procesadas: 0, pendientes: 1 });
      expect(await fila("users", "u1")).toMatchObject({ access_token: enc, refresh_token: "rt-login" });
      // La próxima corrida termina el trabajo
      expect((await llamar()).body).toMatchObject({ procesadas: 1, pendientes: 0 });
    });

    it("encrypt, oauth_identities: lo mismo en la otra tabla", async () => {
      await usuario("u1", null, null);
      await identidad("i1", "u1", "at-viejo", "rt-viejo");
      const r = await procesarTokens(ENV_CON_CLAVE, conLoginEnMedio("UPDATE oauth_identities SET access_token = 'at-login' WHERE id = 'i1'"), "encrypt");
      expect(r).toMatchObject({ procesadas: 0, pendientes: 1 });
      expect(await fila("oauth_identities", "i1")).toMatchObject({ access_token: "at-login", refresh_token: "rt-viejo" });
    });

    it("decrypt: un login que re-cifra no es pisado con el texto plano leído antes", async () => {
      const viejo = await encryptToken(ENV_CON_CLAVE, "at-viejo", "u1:access_token");
      const nuevo = await encryptToken(ENV_CON_CLAVE, "at-nuevo", "u1:access_token");
      await usuario("u1", viejo, null);
      const r = await procesarTokens(ENV_CON_CLAVE, conLoginEnMedio(`UPDATE users SET access_token = '${nuevo}' WHERE id = 'u1'`), "decrypt");
      expect(r).toMatchObject({ procesadas: 0, pendientes: 1 });
      expect((await fila("users", "u1")).access_token).toBe(nuevo);
    });

    it("solo cuenta las filas efectivamente actualizadas", async () => {
      await usuario("u1", "at-1", null);
      await usuario("u2", "at-2", null);
      const r = await procesarTokens(ENV_CON_CLAVE, conLoginEnMedio("UPDATE users SET access_token = 'at-login' WHERE id = 'u1'"), "encrypt");
      expect(r).toMatchObject({ procesadas: 1, pendientes: 1 });
    });
  });

  it("K15: el log del backfill lleva solo conteos, sin tokens ni clave", async () => {
    await usuario("u1", "at-secreto", "rt-secreto");
    await llamar();
    const log = lineas.join("\n");
    expect(log).toContain("token_backfill");
    for (const prohibido of ["at-secreto", "rt-secreto", TOKEN_ENCRYPTION_KEY, (await fila("users", "u1")).access_token]) expect(log).not.toContain(prohibido);
  });

  it("/api/admin/status informa cuántos tokens siguen en claro", async () => {
    await usuario("u1", "at-1", "rt-1");
    await usuario("u2", await encryptToken(ENV_CON_CLAVE, "at-2", "u2:access_token"), null);
    await identidad("u1", "u1", "at-1", null);
    const status = async () =>
      (await (await statusGET(apiCtx({
        url: "https://fisture.test/api/admin/status",
        headers: { Authorization: `Bearer ${ADMIN}` },
        env: { ENVIRONMENT: "test", DB: t.DB, KV: kvEnMemoria(), ADMIN_SECRET: ADMIN, OAUTH_STATE_SECRET: "s", TOKEN_ENCRYPTION_KEY },
      }))).json()) as any;
    expect((await status()).tokensSinCifrar).toEqual({ usuarios: 1, identidades: 1 });
    await llamar();
    expect((await status()).tokensSinCifrar).toEqual({ usuarios: 0, identidades: 0 });
  });
});
