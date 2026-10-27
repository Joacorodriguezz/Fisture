import { describe, expect, it } from "vitest";
import {
  OAUTH_STATE_TTL_SEGUNDOS,
  crearEstado,
  leerEstado,
  nombreCookieEstado,
} from "../../../src/lib/auth/oauth-state";

const SECRET = "secret-de-prueba-0123456789abcdef";
const AHORA = 1_800_000_000_000;
const datos = { state: "st-1", codeVerifier: "cv-1", provider: "google", next: "/equipos/12" };
const esperado = { state: "st-1", provider: "google" };

describe("oauth-state: cookie firmada del intento de login", () => {
  it("la cookie lleva el nombre del proveedor", () => {
    expect(nombreCookieEstado("google")).toBe("oauth_state_google");
    expect(nombreCookieEstado("microsoft")).toBe("oauth_state_microsoft");
  });

  it("vive 10 minutos, como el registro que tenía en KV", () => {
    expect(OAUTH_STATE_TTL_SEGUNDOS).toBe(600);
  });

  it("ida y vuelta: devuelve el verifier y el next", async () => {
    const cookie = await crearEstado(SECRET, datos, AHORA);
    expect(await leerEstado(SECRET, cookie, esperado, AHORA + 1000)).toEqual({ codeVerifier: "cv-1", next: "/equipos/12" });
  });

  it("conserva un next nulo", async () => {
    const cookie = await crearEstado(SECRET, { ...datos, next: null }, AHORA);
    expect(await leerEstado(SECRET, cookie, esperado, AHORA)).toEqual({ codeVerifier: "cv-1", next: null });
  });

  it("L6: una firma alterada se rechaza", async () => {
    const cookie = await crearEstado(SECRET, datos, AHORA);
    const [payload, firma] = cookie.split(".");
    const alterada = `${payload}.${firma.slice(0, -2)}${firma.endsWith("AA") ? "BB" : "AA"}`;
    expect(await leerEstado(SECRET, alterada, esperado, AHORA)).toBeNull();
  });

  it("L6: un payload modificado con la firma original se rechaza", async () => {
    const cookie = await crearEstado(SECRET, datos, AHORA);
    const [, firma] = cookie.split(".");
    const otro = btoa(JSON.stringify({ ...datos, next: "/otro", exp: AHORA + 600_000 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await leerEstado(SECRET, `${otro}.${firma}`, esperado, AHORA)).toBeNull();
  });

  it("una cookie firmada con otro secret se rechaza", async () => {
    const cookie = await crearEstado("otro-secret-distinto-0123456789", datos, AHORA);
    expect(await leerEstado(SECRET, cookie, esperado, AHORA)).toBeNull();
  });

  it("L7: una cookie vencida se rechaza", async () => {
    const cookie = await crearEstado(SECRET, datos, AHORA);
    expect(await leerEstado(SECRET, cookie, esperado, AHORA + OAUTH_STATE_TTL_SEGUNDOS * 1000 - 1)).not.toBeNull();
    expect(await leerEstado(SECRET, cookie, esperado, AHORA + OAUTH_STATE_TTL_SEGUNDOS * 1000)).toBeNull();
  });

  it("L8: un state distinto al de la URL se rechaza", async () => {
    const cookie = await crearEstado(SECRET, datos, AHORA);
    expect(await leerEstado(SECRET, cookie, { ...esperado, state: "st-2" }, AHORA)).toBeNull();
  });

  it("L9: una cookie de Google no sirve para Microsoft", async () => {
    const cookie = await crearEstado(SECRET, datos, AHORA);
    expect(await leerEstado(SECRET, cookie, { ...esperado, provider: "microsoft" }, AHORA)).toBeNull();
  });

  it.each([undefined, "", "sin-punto", "a.b.c", ".", "!!!.???"])("L5: la cookie %j se rechaza sin lanzar", async (cookie) => {
    expect(await leerEstado(SECRET, cookie, esperado, AHORA)).toBeNull();
  });

  it("R5: la cookie pesa mucho menos que el límite de 4 KB", async () => {
    const largo = "x".repeat(512);
    const cookie = await crearEstado(SECRET, { ...datos, codeVerifier: "v".repeat(128), next: largo }, AHORA);
    expect(cookie.length).toBeLessThan(1500);
  });
});
