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
      return nombre
        ? `Ya existe una cuenta de FISTURE con este email, creada con ${nombre}. Por seguridad no la unimos sin tu confirmación. Ingresá con ${nombre} y, una vez adentro, vinculá este proveedor desde Configuración.`
        : "Ya existe una cuenta de FISTURE con este email, creada con otro proveedor. Por seguridad no la unimos sin tu confirmación. Ingresá con ese proveedor y, una vez adentro, vinculá este desde Configuración.";
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
