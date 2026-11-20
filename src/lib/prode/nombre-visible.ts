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
// Decisión: una URL es un esquema (`://`), `www.` o `palabra.tld` con un TLD común seguido de fin, espacio
// o `/:?#`. No se usa el límite de palabra ASCII (parte "Campeón") ni un TLD genérico de 2+ letras, que rechazaba
// nombres legítimos como "Juan.Perez" o "D10S.de.Fiorito". Un TLD fuera de la lista pasa: es el costo
// de no bloquear puntos entre palabras.
const TLDS = "com|net|org|ar|io|es|me|co|app|dev|xyz|info|edu|gov|ly|tv|cl|uy|br|mx";
const URL = new RegExp(
  String.raw`[a-z][a-z0-9+.-]*://|(?:^|[^\p{L}\p{N}])www\.|[\p{L}\p{N}-]\.(?:${TLDS})(?=$|[\s/:?#])`,
  "iu"
);

export type ResultadoTexto = { ok: true; texto: string } | { ok: false; error: ErrorNombre };

// Reglas comunes de texto público (nombre visible, nombre de grupo): sin invisibles, largo en code points,
// sin emails ni direcciones web. Cada uso fija su rango.
export function validarTextoPublico(valor: unknown, min: number, max: number): ResultadoTexto {
  if (typeof valor !== "string") return { ok: false, error: "tipo" };

  // Los espacios y saltos de los bordes se descartan con el trim; adentro, cualquier invisible rechaza
  if (INVISIBLES.test(valor.trim())) return { ok: false, error: "caracteres" };

  const texto = valor.normalize("NFC").trim().replace(/\s+/g, " ");
  const largo = [...texto].length;

  if (largo < min) return { ok: false, error: "corto" };
  if (largo > max) return { ok: false, error: "largo" };
  if (EMAIL.test(texto) || URL.test(texto)) return { ok: false, error: "contacto" };

  return { ok: true, texto };
}

export function validarNombreVisible(valor: unknown): ResultadoNombre {
  const r = validarTextoPublico(valor, NOMBRE_MIN, NOMBRE_MAX);
  return r.ok ? { ok: true, nombre: r.texto } : r;
}
