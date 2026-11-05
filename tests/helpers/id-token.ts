// ID tokens falsos (JWT sin firma válida) para simular lo que devuelve el proveedor en los tests.
// Arctic solo decodifica el payload (decodeIdToken): la firma se verifica en el intercambio del code, que se mockea.

function base64Url(texto: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(texto)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function idToken(claims: Record<string, unknown>): string {
  return `${base64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64Url(JSON.stringify(claims))}.firma`;
}

// Lo que devuelve validateAuthorizationCode (la parte que usa la app)
export function tokensFalsos(opciones: { idToken?: Record<string, unknown> | null; access?: string; refresh?: string | null; expira?: Date } = {}) {
  const { idToken: claims, access = "at-1", refresh = "rt-1", expira = new Date("2027-01-01T00:00:00Z") } = opciones;
  return {
    accessToken: () => access,
    refreshToken: () => {
      if (refresh === null) throw new Error("Missing or invalid 'refresh_token' field");
      return refresh;
    },
    accessTokenExpiresAt: () => expira,
    idToken: () => {
      if (!claims) throw new Error("Missing or invalid 'id_token' field");
      return idToken(claims);
    },
  };
}
