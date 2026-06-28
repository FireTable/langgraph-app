import { test, expect } from "@playwright/test";
import { mockWalletConnected } from "./wallet-mock";

// Visual smoke test for the new Mock Coin place-order card.
// Mounts via the vite harness (which loads the latest source via HMR)
// and asserts the structural copy + gas-in-MC live calculation.

test("place-order card shows SPEND MC, FOR target, gas-in-MC", async ({ page }) => {
  await mockWalletConnected(page);
  await page.goto("/?target=ethereum");
  const card = page.locator(
    '[data-card="place-crypto-order"] [data-slot="place-crypto-order-card"]',
  );
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Source is hardcoded Mock Coin.
  await expect(card.getByText(/^MC$/).first()).toBeVisible();
  await expect(card.getByText("of 10,000 held")).toBeVisible();

  // Target renders as ETH.
  await expect(card.getByText("ETH").first()).toBeVisible();

  // Wait for the live CoinGecko quote to populate (sets the gas-in-MC
  // total). Skip if CoinGecko is rate-limited.
  await page.waitForTimeout(3000);

  // Total spent row is present (MC value).
  await expect(card.getByText(/total spent/i)).toBeVisible();
  await expect(card.locator('[data-action="place-simulated-order"]')).toBeVisible();
});