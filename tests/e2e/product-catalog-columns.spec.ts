import { expect, test } from "@playwright/test";

test("owner can hide and restore product catalog columns", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email address or username").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);

  await page.goto("/products");
  await expect(
    page.getByRole("heading", { name: "Products", exact: true }),
  ).toBeVisible();
  await page.getByText("Show or hide columns", { exact: true }).click();

  const columnPicker = page.getByRole("group", {
    name: "Product catalog columns",
  });
  const sellingPriceCheckbox = columnPicker.getByRole("checkbox", {
    name: "SELL PRICE",
  });
  const sellingPriceHeader = page.getByRole("button", {
    name: "Sort by SELL PRICE",
  });

  await expect(sellingPriceHeader).toHaveCount(1);
  await sellingPriceCheckbox.uncheck();
  await expect(sellingPriceHeader).toHaveCount(0);

  await sellingPriceCheckbox.check();
  await expect(sellingPriceHeader).toHaveCount(1);
});
