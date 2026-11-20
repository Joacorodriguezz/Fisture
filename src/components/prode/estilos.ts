import type { CSSProperties } from "react";

// Estilos compartidos de las islas del prode (identidad Tribuna 90, variables de tribuna90.css).
export const texto: CSSProperties = { font: "400 15px/20px var(--font-texto)" };
export const suave: CSSProperties = { font: "400 14px/19px var(--font-texto)", color: "var(--tinta-suave)" };
export const rotulo: CSSProperties = { font: "700 17px/20px var(--font-rotulo)", textTransform: "uppercase" };
export const fila: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: "16px 12px", borderBottom: "1px solid var(--linea)" };
// Objetivo táctil de al menos 44px
export const campo: CSSProperties = {
  font: "400 16px/22px var(--font-texto)",
  minHeight: 44,
  padding: "8px 10px",
  border: "2px solid var(--tinta)",
  background: "var(--papel)",
  color: "var(--tinta)",
};
export const boton: CSSProperties = { minHeight: 44, minWidth: 44 };
export const aviso = (tipo: "ok" | "error"): CSSProperties => ({
  minHeight: 19,
  font: "400 14px/19px var(--font-texto)",
  color: tipo === "error" ? "var(--alerta, #b00020)" : "var(--tinta-suave)",
});
export const soloLectores: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
