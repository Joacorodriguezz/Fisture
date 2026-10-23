import { test, expect } from "@playwright/test";

const BASE = "http://127.0.0.1:4322";

test.beforeEach(async ({ context }) => {
  // Solo se permiten requests a la app local (fuentes externas se omiten)
  await context.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

test("canonical absoluta sin query ni barra final", async ({ page }) => {
  await page.goto("/hoy/?x=1");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${BASE}/hoy`);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", `${BASE}/hoy`);

  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${BASE}/`);
});

test("meta description por defecto y Open Graph/Twitter", async ({ page }) => {
  await page.goto("/ligas");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /^Sincronizá los partidos/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Ligas - FISTURE");
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "es_AR");
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary");
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
});

test("noindex solo en login (páginas personales o de acceso)", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");

  await page.goto("/hoy");
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
});
