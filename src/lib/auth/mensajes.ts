// Mensajes de los conflictos de identidad (docs/18 §4.1). El parámetro `proveedor` viene de la URL:
// solo se refleja si es uno de los proveedores conocidos, nunca como texto libre.
const NOMBRES: Record<string, string> = { google: "Google", microsoft: "Microsoft" };

export function nombreProveedor(proveedor: string | null | undefined): string | null {
  return proveedor && Object.hasOwn(NOMBRES, proveedor) ? NOMBRES[proveedor] : null;
}

export function mensajeErrorAuth(codigo: string, proveedor: string | null | undefined): string | null {
  const nombre = nombreProveedor(proveedor);
  switch (codigo) {
    case "email_en_uso":
      // Genérico a propósito: no se revela con qué proveedor está la otra cuenta (docs/18 §4.1, revisión)
      return "Ya existe una cuenta de FISTURE con este email. Por seguridad no la unimos sin tu confirmación. Ingresá con el proveedor con el que la creaste y, una vez adentro, vinculá este desde Configuración.";
    case "identidad_en_uso":
      return `Esa cuenta${nombre ? ` de ${nombre}` : ""} ya está asociada a otro usuario de FISTURE.`;
    case "proveedor_en_uso":
      return `Ya tenés otra cuenta${nombre ? ` de ${nombre}` : ""} vinculada. Desvinculala antes de vincular una distinta.`;
    case "email_ausente":
      return `No pudimos obtener un email de tu cuenta${nombre ? ` de ${nombre}` : ""}. Probá con otro proveedor.`;
    case "vinculo_sesion":
      return "Tu sesión cambió. Volvé a intentarlo.";
    default:
      return null;
  }
}
