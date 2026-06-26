import { test, expect } from "@playwright/test";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe("navigation mobile (MobileNav)", () => {
  test("bottom nav absent quand non-authentifié", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/missions");
    // Redirigé vers /login (RequireAuth) ou page visible sans nav mobile (anonyme)
    await page.waitForLoadState("networkidle");
    const nav = page.getByRole("navigation", { name: "Navigation mobile" });
    await expect(nav).not.toBeVisible();
  });

  test("bottom nav visible post-authentification, lien actif correct", async ({
    page,
    context,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    const email = `e2e-mob+${Date.now()}@waylo.test`;
    const password = "motdepasse-mob-123";

    // Création de compte + connexion
    await page.goto("/login");
    await page.getByRole("button", { name: /s'inscrire/i }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Mot de passe").fill(password);
    await page.getByRole("button", { name: /créer le compte/i }).click();
    await page.waitForURL("**/missions");

    // La bottom nav est visible en viewport mobile
    const nav = page.getByRole("navigation", { name: "Navigation mobile" });
    await expect(nav).toBeVisible();

    // Le lien "Missions" est marqué actif (aria-current=page) sur /missions
    const missionsLink = nav.getByRole("link", { name: "Missions" });
    await expect(missionsLink).toHaveAttribute("aria-current", "page");

    // Navigation vers /missions/available → "Catalogue" devient actif
    await nav.getByRole("link", { name: "Catalogue" }).click();
    await page.waitForURL("**/missions/available");
    await expect(
      nav.getByRole("link", { name: "Catalogue" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(missionsLink).not.toHaveAttribute("aria-current", "page");

    // Cookie toujours présent (nav n'a pas brisé l'auth)
    const auth = (await context.cookies()).find(c => c.name === "waylo_token");
    expect(auth).toBeTruthy();
  });

  test("bottom nav masquée en viewport desktop (md+)", async ({ page }) => {
    // md = 768px → la nav est hidden via md:hidden
    await page.setViewportSize({ width: 1024, height: 768 });
    const email = `e2e-desk+${Date.now()}@waylo.test`;
    const password = "motdepasse-desk-123";

    await page.goto("/login");
    await page.getByRole("button", { name: /s'inscrire/i }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Mot de passe").fill(password);
    await page.getByRole("button", { name: /créer le compte/i }).click();
    await page.waitForURL("**/missions");

    const nav = page.getByRole("navigation", { name: "Navigation mobile" });
    await expect(nav).not.toBeVisible();
  });
});
