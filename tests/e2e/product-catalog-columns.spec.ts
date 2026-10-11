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

test("owner sees each product stock unit in its own catalog column", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email address or username").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);

  await page.goto("/products");
  const productName = "Stock Unit Column Product";
  await page.getByLabel("Product name").fill(productName);
  await page.getByLabel("Stock unit", { exact: true }).fill("pack");
  await page.getByLabel("Generic").check();
  await page.locator("#product-price").fill("25.00");
  await page.getByRole("button", { name: "Create product" }).click();

  const productRow = page.getByRole("row").filter({ hasText: productName });
  await expect(productRow).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sort by STOCK UNIT" }),
  ).toBeVisible();
  await expect(productRow.locator("td").nth(0)).not.toContainText("pack");
  await expect(productRow.locator("td").nth(1)).toHaveText("pack");
});
