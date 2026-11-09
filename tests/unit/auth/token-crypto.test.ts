import { describe, expect, it } from "vitest";
import { decryptToken, decryptTokenInfo, encryptToken, esCifrado, TokenKeyError, TokenUnreadableError } from "../../../src/lib/auth/token-crypto";

const clave = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const envCon = (actual?: string, anterior?: string) => ({ TOKEN_ENCRYPTION_KEY: actual, TOKEN_ENCRYPTION_KEY_PREVIOUS: anterior }) as Env;
const AAD = "user-1:access_token";

describe("token-crypto", () => {
  it("K1: cifra y descifra", async () => {
    const env = envCon(clave());
    const cifrado = await encryptToken(env, "ya29.secreto", AAD);
    expect(cifrado.startsWith("enc:v1:")).toBe(true);
    expect(cifrado).not.toContain("ya29.secreto");
    expect(esCifrado(cifrado)).toBe(true);
    expect(await decryptToken(env, cifrado, AAD)).toBe("ya29.secreto");
  });

  it("K2: el mismo token da textos distintos (IV aleatorio)", async () => {
    const env = envCon(clave());
    expect(await encryptToken(env, "t", AAD)).not.toBe(await encryptToken(env, "t", AAD));
  });

  it("K3: un byte alterado falla la autenticación", async () => {
    const env = envCon(clave());
    const cifrado = await encryptToken(env, "token", AAD);
    const i = cifrado.length - 3;
    const alterado = cifrado.slice(0, i) + (cifrado[i] === "A" ? "B" : "A") + cifrado.slice(i + 1);
    await expect(decryptToken(env, alterado, AAD)).rejects.toThrow();
  });

  it("K4: otro userId o columna (AAD) falla", async () => {
    const env = envCon(clave());
    const cifrado = await encryptToken(env, "token", AAD);
    await expect(decryptToken(env, cifrado, "user-2:access_token")).rejects.toThrow();
    await expect(decryptToken(env, cifrado, "user-1:refresh_token")).rejects.toThrow();
  });

  it("K5: una clave incorrecta falla", async () => {
    const cifrado = await encryptToken(envCon(clave()), "token", AAD);
    await expect(decryptToken(envCon(clave()), cifrado, AAD)).rejects.toThrow();
  });

  it("una PREVIOUS mal formada se ignora: la actual sigue funcionando y las filas viejas quedan ilegibles", async () => {
    const actual = clave();
    const propio = await encryptToken(envCon(actual), "token", AAD);
    const env = envCon(actual, btoa("corta"));
    expect(await decryptToken(env, propio, AAD)).toBe("token");
    const deOtra = await encryptToken(envCon(clave()), "viejo", AAD);
    await expect(decryptToken(env, deOtra, AAD)).rejects.toMatchObject({ name: "TokenUnreadableError" });
  });

  it("K6: un valor de la clave anterior se descifra con PREVIOUS y se informa", async () => {
    const vieja = clave();
    const cifrado = await encryptToken(envCon(vieja), "token", AAD);
    const env = envCon(clave(), vieja);
    expect(await decryptToken(env, cifrado, AAD)).toBe("token");
    expect(await decryptTokenInfo(env, cifrado, AAD)).toEqual({ valor: "token", clave: "anterior" });
    expect((await decryptTokenInfo(env, await encryptToken(env, "t", AAD), AAD)).clave).toBe("actual");
  });

  it.each([undefined, "", "no-es-base64!!", btoa("corta")])("K7: cifrar con la clave %j lanza y no devuelve texto plano", async (valor) => {
    await expect(encryptToken(envCon(valor), "token", AAD)).rejects.toBeInstanceOf(TokenKeyError);
  });

  it("K7: descifrar un valor cifrado sin clave falla", async () => {
    const cifrado = await encryptToken(envCon(clave()), "token", AAD);
    await expect(decryptToken(envCon(undefined), cifrado, AAD)).rejects.toBeInstanceOf(TokenKeyError);
  });

  it("K18: un valor sin prefijo enc:v1: es ilegible, con o sin clave, y nunca se devuelve como token", async () => {
    expect(esCifrado("ya29.legado")).toBe(false);
    for (const env of [envCon(clave()), envCon(undefined)]) {
      await expect(decryptToken(env, "ya29.legado", AAD)).rejects.toBeInstanceOf(TokenUnreadableError);
      await expect(decryptTokenInfo(env, "ya29.legado", AAD)).rejects.toBeInstanceOf(TokenUnreadableError);
    }
  });

  it("un valor con prefijo mal formado lanza", async () => {
    await expect(decryptToken(envCon(clave()), "enc:v1:soloUnaParte", AAD)).rejects.toThrow();
  });
});
