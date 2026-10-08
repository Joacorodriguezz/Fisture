const SESSION_TTL = 60 * 60 * 24 * 30; // 30 días

function generateSessionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
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
