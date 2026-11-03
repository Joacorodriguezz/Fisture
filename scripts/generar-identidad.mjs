// Uso: node scripts/generar-identidad.mjs public  (regenera los PNG de public/ a partir de este diseño)
// Genera los íconos y la imagen Open Graph de FISTURE con Chromium (Playwright)
import { chromium } from "@playwright/test";
const [salida] = process.argv.slice(2);
const FUENTES = `<link href="https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@600;700&display=block" rel="stylesheet">`;
const icono = (lado, margen) => `<!doctype html><html><head>${FUENTES}<style>
  html,body{margin:0;width:${lado}px;height:${lado}px;background:#b91309;overflow:hidden}
  .f{position:absolute;inset:${margen}px;display:flex;align-items:center;justify-content:center;
     font-family:Anton;color:#fff;font-size:${Math.round((lado - 2 * margen) * 0.82)}px;line-height:1;transform:skewX(-8deg)}
  .b{position:absolute;left:${margen}px;right:${margen}px;bottom:${Math.round(lado * 0.13)}px;height:${Math.max(2, Math.round(lado * 0.05))}px;background:#f1e9dc}
</style></head><body><div class="f">F</div><div class="b"></div></body></html>`;
const og = `<!doctype html><html><head>${FUENTES}<style>
  html,body{margin:0;width:1200px;height:630px;background:#f1e9dc;overflow:hidden;font-family:'Barlow Condensed'}
  .franja{position:absolute;left:0;right:0;top:0;height:22px;background:#b91309}
  .franja2{position:absolute;left:0;right:0;bottom:0;height:10px;background:#1a1412}
  .marca{position:absolute;left:80px;top:108px;font-family:Anton;font-size:190px;line-height:1;color:#b91309;transform:skewX(-8deg);letter-spacing:2px}
  .vol{position:absolute;left:84px;top:60px;font-weight:700;font-size:28px;letter-spacing:.12em;text-transform:uppercase;color:#1a1412}
  .tit{position:absolute;left:84px;top:342px;width:1040px;font-family:Anton;font-size:76px;line-height:1.02;text-transform:uppercase;color:#1a1412}
  .baj{position:absolute;left:84px;top:520px;font-weight:600;font-size:32px;letter-spacing:.04em;text-transform:uppercase;color:#5a4e44}
  .linea{position:absolute;left:84px;right:84px;top:318px;height:4px;background:#1a1412}
</style></head><body><div class="franja"></div>
<div class="vol">Fixture sync</div><div class="marca">FISTURE</div><div class="linea"></div>
<div class="tit">Todos tus partidos en tu calendario</div>
<div class="baj">Google Calendar · Outlook · Ligas y copas · Gratis</div><div class="franja2"></div></body></html>`;

const browser = await chromium.launch();
async function foto(html, ancho, alto, archivo) {
  const page = await browser.newPage({ viewport: { width: ancho, height: alto } });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${salida}/${archivo}`, type: "png" });
  await page.close();
}
await foto(icono(180, 18), 180, 180, "apple-touch-icon.png");
await foto(icono(192, 20), 192, 192, "icon-192.png");
await foto(icono(512, 52), 512, 512, "icon-512.png");
await foto(icono(512, 104), 512, 512, "icon-maskable-512.png");
await foto(icono(120, 12), 120, 120, "logo-120.png");
await foto(icono(32, 2), 32, 32, "favicon-32.png");
await foto(og, 1200, 630, "og-image.png");
await browser.close();
