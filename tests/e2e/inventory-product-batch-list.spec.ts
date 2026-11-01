import { expect, test } from "@playwright/test";

test("inventory lists products with expandable and editable batches", async ({
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
  const productSku = `SYN-INVENTORY-BATCH-${suffix}`;
  const productName = `Synthetic Inventory Batch ${suffix}`;
  const firstLotCode = `SYN-INV-FIRST-${suffix}`;
  const secondLotCode = `SYN-INV-SECOND-${suffix}`;
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const createResponse = await page.request.post("/api/products", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      sku: productSku,
      name: productName,
      unit: "tablet",
      sellingPrice: "70.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      tracksLots: true,
      isScEligible: false,
      isPwdEligible: false,
      openingQuantity: 5,
      openingUnitCost: "30.00",
      openingLotCode: firstLotCode,
      openingExpiryDate: "2032-12-31",
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as {
    product: { id: string };
  };
  const receiptResponse = await page.request.post("/api/stock/receipts", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      productId: created.product.id,
      quantity: 4,
      unitCost: "32.00",
      lotCode: secondLotCode,
      expiryDate: "2033-01-31",
    },
  });
  expect(receiptResponse.status()).toBe(201);

  await page.goto("/inventory");
  await expect(
    page.getByRole("heading", { name: "Inventory", exact: true }),
  ).toBeVisible();
  const productRow = page
    .locator(".inventory-product-accordion")
    .filter({ hasText: productName });
  await expect(productRow).toHaveCount(1);
  await expect(productRow.locator("summary")).toContainText("2 batches");
  await expect(
    productRow.getByText(firstLotCode, { exact: true }),
  ).toBeHidden();
  await productRow.locator("summary").click();
  await expect(
    productRow.getByText(firstLotCode, { exact: true }),
  ).toBeVisible();
  await expect(
    productRow.getByText(secondLotCode, { exact: true }),
  ).toBeVisible();

  const firstBatch = page
    .locator(".inventory-batch-card")
    .filter({ hasText: firstLotCode });
  await firstBatch
    .getByRole("button", { name: `Edit batch ${firstLotCode}` })
    .click();
  await firstBatch.getByLabel("Batch / lot ID").fill(`${firstLotCode}-EDITED`);
  await firstBatch.getByLabel("Physical quantity (tablet)").fill("3");
  await firstBatch.getByLabel("Expiry date").fill("2033-02-28");
  await firstBatch.getByLabel("Unit acquisition cost (₱)").fill("31.00");
  await firstBatch.getByLabel("Product selling price (₱)").fill("72.00");
  await firstBatch
    .getByLabel("Reason for batch correction")
    .fill("Corrected physical count and batch details");
  await firstBatch.getByRole("button", { name: "Save batch details" }).click();

  const updatedLotCode = `${firstLotCode}-EDITED`;
  await expect(page.getByText("Batch details updated.")).toBeVisible();
  await expect(
    firstBatch.getByText(updatedLotCode, { exact: true }),
  ).toBeVisible();
  const lotsResponse = await page.request.get("/api/stock/lots");
  expect(lotsResponse.status()).toBe(200);
  const lots = (await lotsResponse.json()) as {
    lots: Array<{
      lotCode: string;
      expiryDate: string;
      quantity: number;
      unitCost: string;
      sellingPrice: string;
    }>;
  };
  expect(lots.lots).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        lotCode: updatedLotCode,
        expiryDate: "2033-02-28",
        quantity: 3,
        unitCost: "31.00",
        sellingPrice: "72.00",
      }),
    ]),
  );

  await page.getByLabel("Search inventory products").fill(productSku);
  await expect(
    page
      .locator(".inventory-product-accordion")
      .filter({ hasText: productName }),
  ).toHaveCount(1);
  await expect(page.getByText(/Showing 1 of \d+ products/)).toBeVisible();
});
