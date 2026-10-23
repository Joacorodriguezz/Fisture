const SESSION_TTL = 60 * 60 * 24 * 30; // 30 días

// 32 bytes de aleatoriedad criptográfica codificados en base64url sin
// relleno (43 caracteres). Math.random no sirve: no es seguro para credenciales.
function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createSession(
  kv: KVNamespace,
  userId: string
): Promise<string> {
  const sessionId = generateSessionId();

  await kv.put(`session:${sessionId}`, userId, {
    expirationTtl: SESSION_TTL,
  });

  return sessionId;
}

export async function getSession(
  kv: KVNamespace,
  sessionId: string
): Promise<string | null> {
  return kv.get(`session:${sessionId}`);
}

export async function deleteSession(
  kv: KVNamespace,
  sessionId: string
): Promise<void> {
  await kv.delete(`session:${sessionId}`);
}
