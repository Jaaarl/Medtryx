import { expect, test } from "@playwright/test";

async function signIn(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
}

test("owner maintains catalog and receipts, cashier searches products into a private cart", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, "owner@example.test", "SyntheticOwnerPassword-48!");
  await ownerPage.goto("/products");
  await expect(
    ownerPage.getByRole("heading", { name: "Products", exact: true }),
  ).toBeVisible();
  await ownerPage
    .getByLabel("SKU (leave blank to generate)")
    .fill("SYN-PILOT-001");
  await ownerPage.getByLabel("Product name").fill("Synthetic Pilot Lotion");
  await ownerPage.getByLabel("Barcode (optional)").fill("SYN-BAR-PILOT-001");
  await ownerPage.getByLabel("Selling price (₱)").fill("10.99");
  await ownerPage.getByLabel("Counted quantity").fill("3");
  await ownerPage.getByLabel("Unit cost (₱)").fill("5.00");
  await ownerPage.getByRole("button", { name: "Create product" }).click();
  await expect(ownerPage.getByText("Product created.")).toBeVisible();
  const productRow = ownerPage.getByRole("row").filter({
    hasText: "Synthetic Pilot Lotion",
  });
  await expect(productRow).toContainText("SYN-PILOT-001");
  await expect(productRow).toContainText("₱5.00");
  await expect(
    ownerPage.getByText(/provisional 12% VAT assumption/i),
  ).toBeVisible();

  await productRow.getByRole("button", { name: "Edit" }).click();
  await ownerPage.getByLabel("Selling price (₱)").fill("11.99");
  await ownerPage.getByRole("button", { name: "Save product" }).click();
  await expect(ownerPage.getByText("Product changes saved.")).toBeVisible();
  await expect(productRow).toContainText("₱11.99");
  await productRow.getByRole("button", { name: "Edit" }).click();
  await ownerPage.getByRole("button", { name: "Deactivate product" }).click();
  await expect(productRow).toContainText("Inactive");
  await ownerPage.getByRole("button", { name: "Reactivate product" }).click();
  await expect(productRow).toContainText("Active");

  await ownerPage.goto("/stock");
  const stockRow = ownerPage
    .locator(".stock-list-card .inventory-table tbody tr")
    .filter({ hasText: "Synthetic Pilot Lotion" });
  await stockRow.click();
  await ownerPage.getByLabel("Quantity received").fill("2");
  await ownerPage.getByLabel("Unit acquisition cost (₱)").fill("6.00");
  await ownerPage
    .getByLabel("Reference / supplier note")
    .fill("SYNTHETIC DELIVERY");
  await ownerPage.getByRole("button", { name: "Record receipt" }).click();
  await expect(
    ownerPage.getByText("Received 2 piece for Synthetic Pilot Lotion."),
  ).toBeVisible();
  await expect(
    ownerPage.locator(
      ".stock-list-card .inventory-table tbody tr.inventory-row-selected",
    ),
  ).toContainText("₱5.40");
  const receiptRow = ownerPage.getByRole("row").filter({
    hasText: "SYNTHETIC DELIVERY",
  });
  await expect(receiptRow).toContainText("₱6.00");

  const csrfResponse = await ownerContext.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const cashierCreated = await ownerContext.request.post("/api/users", {
    data: {
      email: "inventory.cashier@example.test",
      password: "SyntheticInventoryCashier-84!",
      role: "cashier",
    },
    headers: { "x-csrf-token": csrf.token },
  });
  expect(cashierCreated.status()).toBe(201);

  const cashierContext = await browser.newContext();
  const cashierPage = await cashierContext.newPage();
  await signIn(
    cashierPage,
    "inventory.cashier@example.test",
    "SyntheticInventoryCashier-84!",
  );
  await cashierPage.getByLabel("Search catalog").fill("SYN-PILOT-001");
  const catalogRow = cashierPage
    .locator(".catalog-result")
    .filter({ hasText: "Synthetic Pilot Lotion" });
  await expect(catalogRow).toContainText("₱11.99 · 5 available");
  await expect(
    cashierPage.getByText(/average cost|inventory value|gross profit/i),
  ).toHaveCount(0);
  await catalogRow.getByRole("button", { name: "Add to cart" }).click();
  await catalogRow.getByRole("button", { name: "Add to cart" }).click();
  await expect(cashierPage.getByText("₱11.99 × 2")).toBeVisible();
  await expect(cashierPage.getByText("₱23.98")).toBeVisible();
  await expect(
    cashierPage.getByText(
      "Sale calculation and finalization will be enabled with the checkout and tax bundle.",
    ),
  ).toBeVisible();

  await cashierContext.close();
  await ownerContext.close();
});
