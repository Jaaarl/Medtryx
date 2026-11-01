import { expect, test } from "@playwright/test";

test("inventory allows count edits for products without batch tracking", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(?:checkout|dashboard)$/);

  const suffix = Date.now().toString();
  const sku = `SYN-INVENTORY-LOOSE-${suffix}`;
  const name = `Synthetic Untracked Inventory ${suffix}`;
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const createResponse = await page.request.post("/api/products", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      sku,
      name,
      unit: "piece",
      sellingPrice: "10.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      openingQuantity: 2,
      openingUnitCost: "4.00",
    },
  });
  expect(createResponse.status()).toBe(201);

  await page.goto("/inventory");
  await page.getByLabel("Search inventory products").fill(sku);
  const productRow = page
    .locator(".inventory-product-accordion")
    .filter({ hasText: name });
  await expect(productRow).toHaveCount(1);
  await productRow.locator("summary").click();
  await expect(productRow).toContainText("Lot tracking is off.");
  await productRow
    .getByRole("button", { name: `Edit stock quantity for ${name}` })
    .click();

  await productRow.getByLabel("Counted physical quantity (piece)").fill("5");
  await productRow
    .getByLabel("Unit acquisition cost for added stock (₱)")
    .fill("6.00");
  await productRow
    .getByLabel("Reason for count correction")
    .fill("Counted additional units on the shelf");
  await productRow.getByRole("button", { name: "Save stock count" }).click();

  await expect(
    page.getByText(`Stock count corrected for ${name}.`),
  ).toBeVisible();
  await expect(productRow.locator("summary")).not.toContainText("on hand");
  await expect(productRow.locator("summary")).toContainText("5 piece");
  await expect(productRow).toContainText("Current stock is 5 piece.");
  const productResponse = await page.request.get(
    `/api/products?q=${encodeURIComponent(sku)}`,
  );
  expect(productResponse.status()).toBe(200);
  expect(
    (
      (await productResponse.json()) as {
        products: Array<{
          tracksLots: boolean;
          quantityOnHand: number;
          inventoryValue: string;
        }>;
      }
    ).products,
  ).toEqual([
    expect.objectContaining({
      tracksLots: false,
      quantityOnHand: 5,
      inventoryValue: "26.00",
    }),
  ]);

  await productRow
    .getByRole("button", { name: `Edit stock quantity for ${name}` })
    .click();
  await productRow.getByLabel("Counted physical quantity (piece)").fill("4");
  await expect(
    productRow.getByLabel("Unit acquisition cost for added stock (₱)"),
  ).toHaveCount(0);
  await productRow
    .getByLabel("Reason for count correction")
    .fill("Removed one unit after the physical recount");
  await productRow.getByRole("button", { name: "Save stock count" }).click();
  await expect(productRow.locator("summary")).not.toContainText("on hand");
  await expect(productRow.locator("summary")).toContainText("4 piece");
  await expect(productRow).toContainText("Current stock is 4 piece.");
  const reducedProductResponse = await page.request.get(
    `/api/products?q=${encodeURIComponent(sku)}`,
  );
  expect(reducedProductResponse.status()).toBe(200);
  expect(
    (
      (await reducedProductResponse.json()) as {
        products: Array<{
          quantityOnHand: number;
          inventoryValue: string;
        }>;
      }
    ).products,
  ).toEqual([
    expect.objectContaining({
      quantityOnHand: 4,
      inventoryValue: "20.80",
    }),
  ]);
});
