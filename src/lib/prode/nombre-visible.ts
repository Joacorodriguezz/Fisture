// Nombre visible del prode: lo único que se muestra de un participante en posiciones y grupos.
// Nunca puede filtrar datos de contacto (email, URL) ni esconder caracteres invisibles.

export const NOMBRE_MIN = 3;
export const NOMBRE_MAX = 24;

export type ErrorNombre = "tipo" | "corto" | "largo" | "caracteres" | "contacto";

export type ResultadoNombre = { ok: true; nombre: string } | { ok: false; error: ErrorNombre };

export const MENSAJES_NOMBRE: Record<ErrorNombre, string> = {
  tipo: "Escribí un nombre.",
  corto: `El nombre tiene que tener al menos ${NOMBRE_MIN} caracteres.`,
  largo: `El nombre puede tener hasta ${NOMBRE_MAX} caracteres.`,
  caracteres: "El nombre tiene caracteres no permitidos.",
  contacto: "El nombre no puede incluir emails ni direcciones web.",
};

// Control (Cc), formato invisible (Cf: zero-width, bidi), separadores de línea/párrafo y no asignados
const INVISIBLES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cn}\p{Co}\p{Cs}]/u;
const EMAIL = /@/;
const URL = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|[\p{L}\p{N}-]+\.(?:[a-z]{2,})(?:\b|$))/iu;

export function validarNombreVisible(valor: unknown): ResultadoNombre {
  if (typeof valor !== "string") return { ok: false, error: "tipo" };

  // Los espacios y saltos de los bordes se descartan con el trim; adentro, cualquier invisible rechaza
  if (INVISIBLES.test(valor.trim())) return { ok: false, error: "caracteres" };

  const nombre = valor.normalize("NFC").trim().replace(/\s+/g, " ");
  const largo = [...nombre].length;

  if (largo < NOMBRE_MIN) return { ok: false, error: "corto" };
  if (largo > NOMBRE_MAX) return { ok: false, error: "largo" };
  if (EMAIL.test(nombre) || URL.test(nombre)) return { ok: false, error: "contacto" };

  return { ok: true, nombre };
}
