import { test, expect } from "@playwright/test";
import { mockWalletConnected } from "./wallet-mock";

// Visual check for the place_crypto_order card after the Mock Coin
// rewrite. Confirms:
//   - BTC is accepted as a target (no "not supported" error)
//   - The card shows SPEND MC (not a wallet source pick)
//   - The 10,000 MC hardcoded balance is visible

test.beforeEach(async ({ page }) => {
  await mockWalletConnected(page);
  await page.goto("/?target=bitcoin");
});

test("card shows SPEND MC + BTC target + total spent row", async ({ page }) => {
  const card = page.locator(
    '[data-card="place-crypto-order"] [data-slot="place-crypto-order-card"]',
  );
  await expect(card).toBeVisible({ timeout: 5000 });
  // Mock Coin source — no wallet pick.
  await expect(card.getByText(/^MC$/).first()).toBeVisible();
  await expect(card.getByText("of 10,000 held")).toBeVisible();
  // BTC target renders — no "not supported" error.
  await expect(card.getByText("BTC").first()).toBeVisible();
  await expect(card.getByText(/not supported/i)).toHaveCount(0);
  // Total spent row (base + gas in MC).
  await expect(card.getByText(/total spent/i)).toBeVisible();
});
