import { Google, MicrosoftEntraId } from "arctic";

export function createGoogleProvider(env: Env) {
  return new Google(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${env.PUBLIC_APP_URL}/api/auth/callback/google`
  );
}

export function createMicrosoftProvider(env: Env) {
  return new MicrosoftEntraId(
    "common",
    env.MICROSOFT_CLIENT_ID,
    env.MICROSOFT_CLIENT_SECRET,
    `${env.PUBLIC_APP_URL}/api/auth/callback/microsoft`
  );
}

export type OAuthProvider = "google" | "microsoft";

export function isValidProvider(provider: string): provider is OAuthProvider {
  return ["google", "microsoft"].includes(provider);
}
