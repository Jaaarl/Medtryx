import { expect, test } from "@playwright/test";

test("owner imports new products with opening stock, lots, and expiry from CSV", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await page.goto("/products");

  const csv = [
    "sku,name,unit,sellingPrice,taxClass,productType,tracksLots,openingQuantity,openingUnitCost,openingReference,openingLotCode,openingExpiryDate,openingSupplier",
    'SYN-CSV-IMPORT-001,"Synthetic CSV Import Medicine",tablet,70.00,VATABLE,BRANDED,TRUE,5,20.50,Synthetic CSV opening,SYN-CSV-LOT-001,2035-12-31,Synthetic supplier',
  ].join("\r\n");
  await page.getByLabel("New products CSV file").setInputFiles({
    name: "new-products.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: "Import products" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Imported 1 product with opening stock.",
    }),
  ).toBeVisible();
  const productRow = page.getByRole("row").filter({
    hasText: "SYN-CSV-IMPORT-001",
  });
  await expect(productRow).toContainText("Synthetic CSV Import Medicine");
  await expect(productRow).toContainText("5 saleable");

  const lotResponse = await page.request.get("/api/stock/lots");
  expect(lotResponse.status()).toBe(200);
  expect((await lotResponse.json()).lots).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sku: "SYN-CSV-IMPORT-001",
        lotCode: "SYN-CSV-LOT-001",
        expiryDate: "2035-12-31",
        quantity: 5,
      }),
    ]),
  );

  await page.goto("/stock");
  const stockCsv = [
    "sku,quantity,unitCost,reference,supplier,lotCode,expiryDate,zeroCostReason",
    "SYN-CSV-IMPORT-001,3,22.00,Synthetic stock CSV receipt,Synthetic supplier,SYN-CSV-LOT-002,2036-12-31,",
  ].join("\r\n");
  await page.getByLabel("Existing products stock CSV file").setInputFiles({
    name: "existing-product-stock.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(stockCsv),
  });
  await page.getByRole("button", { name: "Import stock" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Imported 1 stock receipt across 1 product.",
    }),
  ).toBeVisible();
  const updatedLotsResponse = await page.request.get("/api/stock/lots");
  expect((await updatedLotsResponse.json()).lots).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sku: "SYN-CSV-IMPORT-001",
        lotCode: "SYN-CSV-LOT-002",
        expiryDate: "2036-12-31",
        quantity: 3,
      }),
    ]),
  );
});
