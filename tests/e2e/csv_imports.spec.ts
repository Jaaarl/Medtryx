import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

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

  const [productTemplateDownload] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("link", { name: "Download new products CSV sample" })
      .click(),
  ]);
  expect(productTemplateDownload.suggestedFilename()).toBe(
    "new-products-opening-stock.csv",
  );
  expect(
    await readFile((await productTemplateDownload.path())!, "utf8"),
  ).toContain("openingLotCode");

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
  const [stockTemplateDownload] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("link", { name: "Download existing stock CSV sample" })
      .click(),
  ]);
  expect(stockTemplateDownload.suggestedFilename()).toBe(
    "existing-products-stock.csv",
  );
  expect(
    await readFile((await stockTemplateDownload.path())!, "utf8"),
  ).toContain("quantity,unitCost,reference");

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

test("owner exports and updates product data from the catalog page", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);

  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const created = await page.request.post("/api/products", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      sku: "SYN-CSV-UPDATE-E2E",
      name: "Synthetic E2E CSV Product",
      unit: "tablet",
      sellingPrice: "10.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      openingQuantity: 4,
      openingUnitCost: "5.00",
    },
  });
  expect(created.status()).toBe(201);

  await page.goto("/products");
  const productRow = page.getByRole("row").filter({
    hasText: "SYN-CSV-UPDATE-E2E",
  });
  await expect(productRow.locator(".product-description")).toHaveCSS(
    "text-transform",
    "uppercase",
  );

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export product data CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("products.csv");
  const exportedCsv = await readFile((await download.path())!, "utf8");
  expect(exportedCsv).toContain("quantityonhand");
  const editedCsv =
    'sku,description,sellingprice\r\n"SYN-CSV-UPDATE-E2E","Updated E2E CSV Product","12.50"';
  await page.getByLabel("Product update CSV file").setInputFiles({
    name: "products.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(editedCsv),
  });
  await page.getByRole("button", { name: "Update products" }).click();
  await expect(page.getByRole("status")).toContainText("Updated 1 product.");

  const updatedResponse = await page.request.get(
    "/api/products?q=SYN-CSV-UPDATE-E2E",
  );
  expect(updatedResponse.status()).toBe(200);
  const updated = (await updatedResponse.json()) as {
    products: Array<{
      name: string;
      sellingPrice: string;
      quantityOnHand: number;
      inventoryValue: string;
    }>;
  };
  expect(updated.products[0]).toMatchObject({
    name: "Updated E2E CSV Product",
    sellingPrice: "12.50",
    quantityOnHand: 4,
    inventoryValue: "20.00",
  });
});
