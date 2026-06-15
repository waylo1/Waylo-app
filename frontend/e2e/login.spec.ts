import { test, expect } from "@playwright/test";

// Test d'intégration de connexion : valide la PERSISTANCE du cookie d'auth
// HttpOnly (SameSite=Strict) — le pivot sécurité du passage localStorage → cookie.
test("connexion → cookie HttpOnly persistant, jeton inaccessible au JS", async ({
  page,
  context,
}) => {
  const email = `e2e+${Date.now()}@waylo.test`;
  const password = "motdepasse-e2e-123";

  await page.goto("/login");
  // Bascule en mode inscription (compte neuf déterministe).
  await page.getByRole("button", { name: /s'inscrire/i }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: /créer le compte/i }).click();

  // Redirection post-auth vers le catalogue des missions.
  await page.waitForURL("**/missions");

  // Le cookie d'auth est posé : HttpOnly + SameSite=Strict.
  const auth = (await context.cookies()).find(c => c.name === "waylo_token");
  expect(auth, "cookie waylo_token présent").toBeTruthy();
  expect(auth?.httpOnly).toBe(true);
  expect(auth?.sameSite).toBe("Strict");

  // Persistance : un rechargement conserve la session (pas de retour /login).
  await page.reload();
  await expect(page).toHaveURL(/\/missions/);

  // Le jeton n'est PAS lisible côté JS (HttpOnly) → anti-XSS.
  const tokenInJs = await page.evaluate(() =>
    window.localStorage.getItem("waylo_token"),
  );
  expect(tokenInJs).toBeNull();
});
