import { expect, test, type BrowserContext } from "@playwright/test";

let cashierContext: BrowserContext | undefined;

test.afterEach(async ({ page }) => {
  try {
    const csrfResponse = await page.request.get("/api/auth/csrf");
    if (!csrfResponse.ok()) return;
    const { token } = (await csrfResponse.json()) as { token: string };
    const disabled = await page.request.put(
      "/api/settings/checkout-inventory",
      {
        headers: { "x-csrf-token": token },
        data: { allowStockCountOverride: false },
      },
    );
    expect(disabled.status()).toBe(200);
    const activeShiftsResponse = await page.request.get("/api/shifts/open");
    if (!activeShiftsResponse.ok()) return;
    const activeShifts = (await activeShiftsResponse.json()) as {
      shifts: Array<{ id: string; expectedCash: string }>;
    };
    for (const shift of activeShifts.shifts) {
      const closed = await page.request.post(
        `/api/shifts/${shift.id}/emergency-close`,
        {
          headers: { "x-csrf-token": token },
          data: { actualCashCount: shift.expectedCash },
        },
      );
      expect(closed.status()).toBe(200);
    }
  } finally {
    await cashierContext?.close();
    cashierContext = undefined;
  }
});

test("cashier confirms a shelf count and commits the correction with the sale", async ({
  page,
  browser,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/u);

  const activeShiftsResponse = await page.request.get("/api/shifts/open");
  const activeShifts = (await activeShiftsResponse.json()) as {
    shifts: Array<{ id: string; expectedCash: string }>;
  };
  if (activeShifts.shifts.length > 0) {
    const closeCsrfResponse = await page.request.get("/api/auth/csrf");
    const closeCsrf = (await closeCsrfResponse.json()) as { token: string };
    for (const shift of activeShifts.shifts) {
      const closed = await page.request.post(
        `/api/shifts/${shift.id}/emergency-close`,
        {
          headers: { "x-csrf-token": closeCsrf.token },
          data: { actualCashCount: shift.expectedCash },
        },
      );
      expect(closed.status()).toBe(200);
    }
    await page.reload();
    await expect(page).toHaveURL(/\/checkout$/u);
  }

  await page.goto("/settings");
  const stockOverrideToggle = page.locator(
    ".checkout-inventory-setting-toggle input[type=checkbox]",
  );
  await expect(stockOverrideToggle).toBeVisible();
  await expect(stockOverrideToggle).not.toBeChecked();
  await expect(stockOverrideToggle).toBeEnabled();
  await stockOverrideToggle.click();
  await expect(stockOverrideToggle).toBeChecked();
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const product = await page.request.post("/api/products", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      sku: "SYN-E2E-STOCK-OVERRIDE",
      name: "Synthetic Counted Product",
      unit: "piece",
      sellingPrice: "10.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      openingQuantity: 1,
      openingUnitCost: "4.00",
    },
  });
  expect(product.status()).toBe(201);

  cashierContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const cashierPage = await cashierContext.newPage();
  await cashierPage.goto("/login");
  await cashierPage.getByLabel("Email address").fill("cashier@example.test");
  let cashierSignedIn = false;
  for (const password of [
    "SyntheticCashierPassword-84!",
    "SyntheticCashierPassword-72!",
  ]) {
    await cashierPage.getByLabel("Password", { exact: true }).fill(password);
    const loginResponse = cashierPage.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/login") &&
        response.request().method() === "POST",
    );
    await cashierPage.getByRole("button", { name: "Sign in" }).click();
    if ((await loginResponse).ok()) {
      cashierSignedIn = true;
      break;
    }
  }
  expect(cashierSignedIn).toBe(true);
  await expect(cashierPage).toHaveURL(/\/checkout$/u);

  await expect(
    cashierPage.getByRole("dialog", { name: "Open a cashier shift" }),
  ).toBeVisible();
  await cashierPage.getByLabel("Opening cash (₱)").fill("100.00");
  await cashierPage.getByRole("button", { name: "Open shift" }).click();
  await expect(
    cashierPage.getByRole("dialog", { name: "Open a cashier shift" }),
  ).toHaveCount(0);

  await cashierPage.getByLabel("Search catalog").fill("SYN-E2E-STOCK-OVERRIDE");
  const productResult = cashierPage
    .locator(".catalog-result")
    .filter({ hasText: "SYN-E2E-STOCK-OVERRIDE" });
  await expect(productResult).toHaveCount(1);
  await productResult.getByRole("button", { name: "Add to cart" }).click();
  await cashierPage.getByLabel("Quantity to add").fill("2");
  await cashierPage.getByRole("button", { name: "Add to cart" }).last().click();
  await expect(
    cashierPage.getByRole("dialog", {
      name: "Are you sure you want to add this product?",
    }),
  ).toContainText("Unrecorded shortage: 1");
  await cashierPage.getByRole("button", { name: "Yes, add to cart" }).click();
  const warnedCartLine = cashierPage
    .locator(".cart-line.checkout-stock-shortage")
    .filter({ hasText: "Synthetic Counted Product" });
  await expect(warnedCartLine).toBeVisible();
  await expect(warnedCartLine).toHaveCSS(
    "background-color",
    "rgb(255, 247, 235)",
  );
  await cashierPage
    .getByRole("button", { name: "Calculate line taxes and discounts" })
    .click();

  const stockConfirmation = cashierPage.getByRole("dialog", {
    name: "Are you sure this stock is physically available?",
  });
  await expect(stockConfirmation).toContainText("Recorded: 1 piece");
  await expect(stockConfirmation).toContainText("In this sale: 2 piece");
  await expect(stockConfirmation).toContainText(
    "Additional stock to record: +1 piece",
  );
  await expect(stockConfirmation.getByRole("textbox")).toHaveCount(0);
  await cashierPage
    .getByRole("button", { name: "Yes, stock is available" })
    .click();

  await expect(
    cashierPage.getByText("Provisional stock count corrections"),
  ).toBeVisible();
  await expect(
    cashierPage
      .getByLabel("Stock count corrections")
      .getByText("Count override: +1"),
  ).toBeVisible();
  const catalogBeforeSave = await cashierPage.request.get(
    "/api/catalog?q=SYN-E2E-STOCK-OVERRIDE",
  );
  expect((await catalogBeforeSave.json()).products[0].quantityAvailable).toBe(
    1,
  );

  await cashierPage.getByRole("button", { name: "Confirm sale" }).click();
  await cashierPage.getByRole("button", { name: "Confirm cash sale" }).click();
  await expect(
    cashierPage.getByText("Stock count correction recorded."),
  ).toBeVisible();
  const catalogAfterSave = await cashierPage.request.get(
    "/api/catalog?q=SYN-E2E-STOCK-OVERRIDE",
  );
  expect((await catalogAfterSave.json()).products[0].quantityAvailable).toBe(0);
  await page.goto("/stock");
  await expect(page).toHaveURL(/\/stock$/u);
  const overridesPanel = page.locator("#checkout-count-overrides");
  await expect(
    page.getByRole("link", { name: "Checkout count overrides" }),
  ).toHaveCount(0);
  await expect(
    overridesPanel.getByRole("heading", {
      name: "Checkout count overrides",
    }),
  ).toBeVisible();
  await expect(
    overridesPanel.getByText("Synthetic Counted Product", { exact: true }),
  ).toBeVisible();
  await page.goto("/stock/checkout-overrides");
  await expect(page).toHaveURL(/\/stock#checkout-count-overrides$/u);
  await expect(
    page.locator("#checkout-count-overrides").getByRole("heading", {
      name: "Checkout count overrides",
    }),
  ).toBeVisible();
  const historyResponse = await page.request.get(
    "/api/checkout-stock-overrides",
  );
  const history = (await historyResponse.json()) as {
    records: Array<{ id: string }>;
  };
  expect(history.records).toHaveLength(1);
  const historyRecord = history.records[0];
  if (!historyRecord) throw new Error("Expected a saved stock correction.");
  const reviewCsrfResponse = await page.request.get("/api/auth/csrf");
  const reviewCsrf = (await reviewCsrfResponse.json()) as { token: string };
  const reviewed = await page.request.post(
    `/api/checkout-stock-overrides/${historyRecord.id}/review`,
    {
      headers: { "x-csrf-token": reviewCsrf.token },
      data: { status: "REVIEWED", note: "Checked in the browser test." },
    },
  );
  expect(reviewed.status()).toBe(200);
  const disabled = await page.request.put("/api/settings/checkout-inventory", {
    headers: { "x-csrf-token": reviewCsrf.token },
    data: { allowStockCountOverride: false },
  });
  expect(disabled.status()).toBe(200);
});
