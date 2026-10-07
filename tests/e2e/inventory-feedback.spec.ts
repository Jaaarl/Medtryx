import { expect, test } from "@playwright/test";

async function signInOwner(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
}

test("product and stock headers sort their rows in both directions", async ({
  page,
}) => {
  await signInOwner(page);
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const products = [
    { sku: "SYN-SORT-ALPHA", name: "Synthetic Sort Alpha", quantity: 3 },
    { sku: "SYN-SORT-BETA", name: "Synthetic Sort Beta", quantity: 1 },
    { sku: "SYN-SORT-GAMMA", name: "Synthetic Sort Gamma", quantity: 2 },
  ];
  for (const product of products) {
    const response = await page.request.post("/api/products", {
      headers: { "x-csrf-token": csrf.token },
      data: {
        sku: product.sku,
        name: product.name,
        unit: "piece",
        sellingPrice: "10.00",
        taxClass: "VATABLE",
        productType: "GENERIC",
        isScEligible: false,
        isPwdEligible: false,
        openingQuantity: product.quantity,
        openingUnitCost: "2.00",
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto("/products");
  const productRows = page.locator(
    ".product-list-card .inventory-table tbody tr",
  );
  const productSort = page.getByRole("button", { name: "Sort by PRODUCT" });
  const productHeader = productSort.locator("xpath=..");
  await productSort.click();
  await expect(productHeader).toHaveAttribute("aria-sort", "descending");
  await expect(productRows.first()).toContainText("Synthetic Sort Gamma");
  await productSort.click();
  await expect(productHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(productRows.first()).toContainText("Synthetic Sort Alpha");

  const catalogQuantitySort = page.getByRole("button", {
    name: "Sort by ON HAND",
  });
  const catalogQuantityHeader = catalogQuantitySort.locator("xpath=..");
  await catalogQuantitySort.click();
  await expect(catalogQuantityHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(productRows.first()).toContainText("Synthetic Sort Beta");
  await catalogQuantitySort.click();
  await expect(catalogQuantityHeader).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(productRows.first()).toContainText("Synthetic Sort Alpha");

  await page.goto("/stock");
  const stockRows = page.locator(".stock-list-card .inventory-table tbody tr");
  const stockQuantitySort = page.getByRole("button", {
    name: "Sort by ON HAND",
  });
  const stockQuantityHeader = stockQuantitySort.locator("xpath=..");
  await stockQuantitySort.click();
  await expect(stockQuantityHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(stockRows.first()).toContainText("Synthetic Sort Beta");
  await stockQuantitySort.click();
  await expect(stockQuantityHeader).toHaveAttribute("aria-sort", "descending");
  await expect(stockRows.first()).toContainText("Synthetic Sort Alpha");
});
