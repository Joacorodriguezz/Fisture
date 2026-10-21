import { loginHref } from "./guards";

// Para las islands: manda al login recordando la página actual, para volver después de entrar
export function irALogin(): void {
  location.href = loginHref(location.pathname + location.search);
}
