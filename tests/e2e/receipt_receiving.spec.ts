import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function signInAsOwner(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
}

test("owner can open the receipt receiving workflow and choose receipt pages", async ({
  page,
}) => {
  await signInAsOwner(page);

  await page.goto("/receipt-receiving");
  await expect(
    page.getByRole("heading", { name: "Receipt receiving" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose PDF or image pages" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Extract receipt with AI" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Load receipt CSV into editor" }),
  ).toBeVisible();
});

test("owner sees specific AI receipt preparation activity while it loads", async ({
  page,
}) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");
  await page.route("**/api/stock/receipts/ai-draft", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        csv: [
          "originaldescription,draftid,rearrangedname,quantity,unitcost,matchstatus,selectedproductid,conversionapproved",
          `${JSON.stringify("Example item")},${randomUUID()},${JSON.stringify("Example item")},1,10.00,NEW_PRODUCT,,FALSE`,
        ].join("\r\n"),
        filename: "receipt-review.csv",
        lineCount: 1,
      }),
    });
  });

  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
  });
  await page.getByRole("button", { name: "Extract receipt with AI" }).click();

  const progress = page.getByRole("status");
  await expect(progress).toContainText(
    "AI extracts and transforms receipt details, then matches products",
  );
  await expect(progress).toContainText(
    "Extract supplier, reference, item descriptions, quantities, costs, lot codes, and expiry dates",
  );
  await expect(progress).toContainText(
    "Normalize package quantities and unit costs; format clear expiry dates",
  );
  await expect(progress).toContainText(
    "Reorder medicine names and match each line against the product catalog",
  );
  await expect(page.getByText("1 line items ready to edit")).toBeVisible();
});

test("owner gets an explanation when AI cannot extract a receipt", async ({
  page,
}) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");
  await page.route("**/api/stock/receipts/ai-draft", async (route) => {
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "receipt_extraction_invalid" }),
    });
  });

  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
  });
  await page.getByRole("button", { name: "Extract receipt with AI" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Receipt reading failed: AI could not return supplier and item details in the expected format.",
  );
});

test("owner can edit a receipt CSV in the app before receiving stock", async ({
  page,
}) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");

  const columns = [
    "originaldescription",
    "draftid",
    "rearrangedname",
    "sourcequantity",
    "sourceunitcost",
    "sourcelinetotal",
    "sourcelot",
    "sourceexpiry",
    "quantity",
    "unitcost",
    "lotcode",
    "expirydate",
    "supplier",
    "reference",
    "matchstatus",
    "suggestedproductid",
    "suggestedproductname",
    "suggestedproductsku",
    "selectedproductid",
    "sku",
    "unit",
    "sellingprice",
    "taxclass",
    "producttype",
    "issceligible",
    "ispwdeligible",
    "bnpceligible",
    "bnpccategory",
    "trackslots",
    "conversionrecommended",
    "unitsperpackage",
    "conversionconfidence",
    "conversionreason",
    "conversionapproved",
    "zerocostreason",
  ];
  const row: Record<string, string> = {
    originaldescription: "E2E example item 500mg tablet",
    draftid: randomUUID(),
    rearrangedname: "AI suggested item name",
    sourcequantity: "2",
    sourceunitcost: "12.00",
    sourcelinetotal: "24.00",
    sourcelot: "",
    sourceexpiry: "",
    quantity: "2",
    unitcost: "12.00",
    lotcode: "",
    expirydate: "",
    supplier: "Test supplier",
    reference: "E2E receipt",
    matchstatus: "NEW_PRODUCT",
    suggestedproductid: "",
    suggestedproductname: "",
    suggestedproductsku: "",
    selectedproductid: "",
    sku: "",
    unit: "",
    sellingprice: "",
    taxclass: "",
    producttype: "",
    issceligible: "FALSE",
    ispwdeligible: "FALSE",
    bnpceligible: "FALSE",
    bnpccategory: "",
    trackslots: "FALSE",
    conversionrecommended: "FALSE",
    unitsperpackage: "",
    conversionconfidence: "LOW",
    conversionreason: "",
    conversionapproved: "FALSE",
    zerocostreason: "",
  };
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    columns.map(cell).join(","),
    columns.map((column) => cell(row[column] ?? "")).join(","),
  ].join("\r\n");

  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "receipt-review.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();
  await page.getByLabel("Product name").fill("Edited in app product");
  await page.getByLabel("New product SKU (optional)").fill("E2E-RECEIPT-EDIT");
  await page
    .getByRole("textbox", { name: "Sellable unit", exact: true })
    .fill("tablet");
  await page.getByLabel("Selling price").fill("25.00");
  await page.getByLabel("Tax class").selectOption("VATABLE");
  await page.getByLabel("Product type").selectOption("GENERIC");

  await page.getByRole("button", { name: "Validate receipt" }).click();
  await expect(page.getByText("Ready for confirmation")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and receive stock" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Received 1 lines across 1 products",
  );
  await expect(page.getByRole("status")).toContainText("E2E-RECEIPT-EDIT");
});

test("owner can search and select an existing catalog product in the editor", async ({
  page,
}) => {
  await signInAsOwner(page);
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const sku = `E2E-RECEIPT-${randomUUID().slice(0, 8)}`;
  const createdProduct = await page.request.post("/api/products", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      sku,
      name: "E2E Catalog Medicine",
      unit: "tablet",
      sellingPrice: "25.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      tracksLots: false,
      openingQuantity: 0,
    },
  });
  expect(createdProduct.status()).toBe(201);
  await page.goto("/receipt-receiving");

  const columns = [
    "originaldescription",
    "draftid",
    "rearrangedname",
    "quantity",
    "unitcost",
    "matchstatus",
    "selectedproductid",
    "conversionapproved",
  ];
  const row: Record<string, string> = {
    originaldescription: "E2E Catalog Medicine",
    draftid: randomUUID(),
    rearrangedname: "E2E Catalog Medicine",
    quantity: "3",
    unitcost: "10.00",
    matchstatus: "POSSIBLE_MATCH",
    selectedproductid: "",
    conversionapproved: "FALSE",
  };
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    columns.map(cell).join(","),
    columns.map((column) => cell(row[column] ?? "")).join(","),
  ].join("\r\n");
  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "receipt-review.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();
  await page.getByRole("button", { name: "Choose product" }).click();
  await page
    .getByRole("button", {
      name: new RegExp(`E2E Catalog Medicine.*${sku}`, "i"),
    })
    .click();

  await page.getByRole("button", { name: "Validate receipt" }).click();
  await expect(page.getByText("Ready for confirmation")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and receive stock" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Received 1 lines across 1 products",
  );
});
