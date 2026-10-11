import type { CSSProperties } from "react";

// Estilos de segmentos y chips del diseño Tribuna 90 (activo = tinta, inactivo = papel)
export function chipStyle(activo: boolean): CSSProperties {
  return {
    cursor: "pointer",
    border: "2px solid var(--tinta)",
    borderRadius: 2,
    padding: "6px 12px",
    font: "700 13px/16px var(--font-rotulo)",
    letterSpacing: ".06em",
    textTransform: "uppercase",
    background: activo ? "var(--barra-tinta)" : "var(--papel)",
    color: activo ? "var(--crema-sobre-oscuro)" : "var(--tinta)",
  };
}

export function segmentoStyle(activo: boolean): CSSProperties {
  return {
    ...chipStyle(activo),
    marginLeft: -2,
    padding: "8px 14px",
    font: "700 14px/16px var(--font-rotulo)",
  };
}

// Normaliza texto para buscar sin importar mayúsculas ni acentos
export function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
