// Normaliza texto para buscar sin importar mayúsculas ni acentos
export function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
