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

test("owners can search a batch and edit its quantity and product price", async ({
  page,
}) => {
  await signInOwner(page);
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const createResponse = await page.request.post("/api/products", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      sku: "SYN-LOT-SEARCH",
      name: "Synthetic Searchable Lot Product",
      unit: "piece",
      sellingPrice: "10.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      tracksLots: true,
      openingQuantity: 4,
      openingUnitCost: "5.00",
      openingLotCode: "SYN-SEARCH-BATCH-31",
      openingExpiryDate: "2031-12-31",
    },
  });
  expect(createResponse.status()).toBe(201);
  const secondLotResponse = await page.request.post("/api/products", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      sku: "SYN-OTHER-LOT",
      name: "Synthetic Other Lot Product",
      unit: "piece",
      sellingPrice: "8.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      tracksLots: true,
      openingQuantity: 2,
      openingUnitCost: "4.00",
      openingLotCode: "SYN-OTHER-BATCH-31",
      openingExpiryDate: "2031-12-31",
    },
  });
  expect(secondLotResponse.status()).toBe(201);

  await page.goto("/stock");
  const lotSearch = page.getByLabel(
    "Search lots by product name, SKU, or batch ID",
  );
  await lotSearch.fill("Searchable Product");
  const lotRow = page
    .locator(".stock-lots-card .inventory-table tbody tr")
    .filter({ hasText: "SYN-SEARCH-BATCH-31" });
  await expect(lotRow).toContainText("Synthetic Searchable Lot Product");
  await expect(
    page.getByRole("status").filter({ hasText: "Showing 1 of 2 lots" }),
  ).toBeVisible();
  await lotSearch.fill("SYN-SEARCH-BATCH-31");
  await expect(lotRow).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Showing 1 of 2 lots" }),
  ).toBeVisible();
  await lotRow.getByRole("button", { name: "Edit lot" }).click();
  await expect(page.getByLabel("Physical quantity")).toHaveValue("4");
  await expect(page.getByLabel("Product selling price (₱)")).toHaveValue(
    "10.00",
  );
  await page.getByLabel("Physical quantity").fill("5");
  await page.getByLabel("Product selling price (₱)").fill("12.50");
  await page.getByLabel("Expiry date", { exact: true }).fill("2032-12-31");
  await page
    .getByLabel("Reason for lot correction")
    .fill("Synthetic browser lot count and price edit");
  await page.getByRole("button", { name: "Save lot details" }).click();
  await expect(page.getByText("Lot details updated.")).toBeVisible();
  await expect(lotRow).toContainText("2032-12-31");
  await expect(lotRow).toContainText("12.50");
  await expect(lotRow).toContainText("5");

  const catalogResponse = await page.request.get("/api/products");
  const catalog = (await catalogResponse.json()) as {
    products: Array<{
      sku: string;
      quantityOnHand: number;
      sellingPrice: string;
    }>;
  };
  expect(
    catalog.products.find((product) => product.sku === "SYN-LOT-SEARCH"),
  ).toMatchObject({
    quantityOnHand: 5,
    sellingPrice: "12.50",
  });
});

test("product catalog pagination stays bounded and resets after a new search", async ({
  page,
}) => {
  await signInOwner(page);
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  for (let index = 1; index <= 11; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const response = await page.request.post("/api/products", {
      headers: { "x-csrf-token": csrf.token },
      data: {
        sku: `SYN-PAGE-${suffix}`,
        name: `Synthetic Page ${suffix}`,
        unit: "piece",
        sellingPrice: "10.00",
        taxClass: "VATABLE",
        productType: "GENERIC",
        isScEligible: false,
        isPwdEligible: false,
        openingQuantity: index,
        openingUnitCost: "2.00",
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto("/products");
  await page.getByLabel("Search products").fill("Synthetic Page");
  const productRows = page.locator(
    ".product-list-card .inventory-table tbody tr",
  );
  await expect(productRows).toHaveCount(10);
  await expect(productRows.first()).toContainText("Synthetic Page 01");
  await expect(
    page.getByText("Showing 1 to 10 of 11 products", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next product page" }).click();
  await expect(productRows).toHaveCount(1);
  await expect(productRows.first()).toContainText("Synthetic Page 11");
  await expect(
    page.getByText("Showing 11 to 11 of 11 products", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Previous product page" }).click();
  await expect(productRows).toHaveCount(10);

  await page.getByLabel("Search products").fill("Synthetic Page 02");
  await expect(productRows).toHaveCount(1);
  await expect(productRows.first()).toContainText("Synthetic Page 02");
  await expect(
    page.getByText("Showing 1 to 1 of 1 products", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next product page" }),
  ).toBeDisabled();

  const panelHeights = await page
    .locator(".product-workspace")
    .evaluate((root) => {
      const list = root.querySelector(".product-list-card");
      const form = root.querySelector(".inventory-form-card");
      if (!list || !form) throw new Error("Product panels were not rendered.");
      return {
        list: list.getBoundingClientRect().height,
        form: form.getBoundingClientRect().height,
      };
    });
  expect(Math.abs(panelHeights.list - panelHeights.form)).toBeLessThan(2);
});

test("current stock pagination aligns its panel with Receive stock", async ({
  page,
}) => {
  await signInOwner(page);
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  for (let index = 1; index <= 9; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const response = await page.request.post("/api/products", {
      headers: { "x-csrf-token": csrf.token },
      data: {
        sku: `SYN-STOCK-PAGE-${suffix}`,
        name: `Synthetic Stock Page ${suffix}`,
        unit: "piece",
        sellingPrice: "10.00",
        taxClass: "VATABLE",
        productType: "GENERIC",
        isScEligible: false,
        isPwdEligible: false,
        openingQuantity: 0,
        reorderLevel: 0,
      },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto("/stock");
  await page.getByLabel("Low stock only").check();
  const stockRows = page.locator(".stock-list-card .inventory-table tbody tr");
  await expect(stockRows).toHaveCount(6);
  await expect(stockRows.first()).toContainText("Synthetic Stock Page 01");
  await expect(
    page.getByText("Showing 1 to 6 of 9 products", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next stock page" }).click();
  await expect(stockRows).toHaveCount(3);
  await expect(stockRows.first()).toContainText("Synthetic Stock Page 07");
  await expect(
    page.getByText("Showing 7 to 9 of 9 products", { exact: true }),
  ).toBeVisible();

  const panelHeights = await page
    .locator(".stock-workspace")
    .evaluate((root) => {
      const list = root.querySelector(".stock-list-card");
      const receive = root.querySelector(
        ".stock-actions-column > .inventory-form-card",
      );
      if (!list || !receive) throw new Error("Stock panels were not rendered.");
      return {
        list: list.getBoundingClientRect().height,
        receive: receive.getBoundingClientRect().height,
      };
    });
  expect(Math.abs(panelHeights.list - panelHeights.receive)).toBeLessThan(2);
});
