// Id determinístico del evento de un partido para un usuario (idempotencia, D1).
// Google admite ids propios de 5 a 1024 caracteres en base32hex (a-v, 0-9): un hex entra en ese alfabeto.

export async function fistureEventId(userId: string, matchId: string): Promise<string> {
  // El separador evita que ("ab","c") y ("a","bc") produzcan el mismo hash
  const datos = new TextEncoder().encode(`${userId}:${matchId}`);
  const hash = await crypto.subtle.digest("SHA-256", datos);
  const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  return `fa${hex.slice(0, 40)}`;
}
