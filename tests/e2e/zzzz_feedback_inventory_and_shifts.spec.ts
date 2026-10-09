import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const owner = {
  email: "owner@example.test",
  password: "SyntheticOwnerPassword-48!",
};
const cashier = {
  email: "cashier@example.test",
  password: "SyntheticCashierPassword-72!",
};

async function signIn(
  page: import("@playwright/test").Page,
  credentials: { email: string; password: string },
) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  const checkoutReached = page
    .waitForURL(/\/checkout$/, {
      timeout: credentials.email === cashier.email ? 1_500 : 5_000,
    })
    .then(
      () => true,
      () => false,
    );
  await page.getByRole("button", { name: "Sign in" }).click();
  if (!(await checkoutReached) && credentials.email === cashier.email) {
    await page
      .getByLabel("Password", { exact: true })
      .fill("SyntheticCashierPassword-84!");
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page).toHaveURL(/\/checkout$/);
}

async function postApi(
  page: import("@playwright/test").Page,
  path: string,
  data: Record<string, unknown>,
) {
  const csrf = await page.request.get("/api/auth/csrf");
  const { token } = (await csrf.json()) as { token: string };
  return page.request.post(path, {
    data,
    headers: { "x-csrf-token": token },
  });
}

function manilaDayAfter(days: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const today = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const date = new Date(
    Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day)),
  );
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("product form saves reorder level and opening lot references", async ({
  page,
}) => {
  await signIn(page, owner);
  await page.goto("/products");

  const productName = `Synthetic Lot Product ${randomUUID().slice(0, 8)}`;
  const reference = `SYN-E2E-PO-${randomUUID().slice(0, 8)}`;
  const supplier = "Synthetic e2e supplier";
  const lotCode = `SYN-E2E-LOT-${randomUUID().slice(0, 8)}`;

  await page.getByLabel("Product name").fill(productName);
  await page.getByLabel("Stock unit").fill("box");
  await page.getByLabel("Selling price (₱)").fill("15.00");
  await page.getByLabel("Reorder level (optional)").fill("3");
  await page.getByLabel("Generic", { exact: true }).check();
  await page.getByLabel("Track lots and expiry for this product").check();
  await page.getByLabel("Counted quantity").fill("5");
  await page.getByLabel("Unit cost (₱)").fill("4.00");
  await page.getByLabel("Reference / supplier note").fill(reference);
  await page.getByLabel("Opening lot / batch code").fill(lotCode);
  await page
    .getByLabel("Expiry date (last saleable day)")
    .fill(manilaDayAfter(30));
  await page.getByLabel("Supplier (optional)").fill(supplier);
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Product created" }),
  ).toBeVisible();

  const catalogResponse = await page.request.get("/api/products");
  expect(catalogResponse.status()).toBe(200);
  const catalog = (await catalogResponse.json()) as {
    products: Array<{ id: string; name: string; reorderLevel: number | null }>;
  };
  const product = catalog.products.find((item) => item.name === productName);
  expect(product).toMatchObject({ reorderLevel: 3 });

  const eventsResponse = await page.request.get(
    `/api/stock/events?productId=${product!.id}`,
  );
  expect(eventsResponse.status()).toBe(200);
  const events = (await eventsResponse.json()) as {
    events: Array<{
      type: string;
      reference: string | null;
      supplier: string | null;
    }>;
  };
  expect(events.events[0]).toMatchObject({
    type: "OPENING",
    reference,
    supplier,
  });
});

test("checkout shows QR totals and an owner can emergency-close a cashier shift", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner);

  const cashierContext = await browser.newContext();
  const cashierPage = await cashierContext.newPage();
  await signIn(cashierPage, cashier);

  const existingShiftResponse = await ownerPage.request.get(
    "/api/shifts/current",
  );
  const existingShift = (await existingShiftResponse.json()) as {
    registerShift: null | { id: string; expectedCash: string };
  };
  if (existingShift.registerShift) {
    const cleanup = await postApi(
      ownerPage,
      `/api/shifts/${existingShift.registerShift.id}/emergency-close`,
      { actualCashCount: existingShift.registerShift.expectedCash },
    );
    expect(cleanup.status()).toBe(200);
  }

  const productResponse = await postApi(ownerPage, "/api/products", {
    sku: `SYN-QR-${randomUUID().slice(0, 8)}`,
    name: `Synthetic QR Shift Product ${randomUUID().slice(0, 8)}`,
    unit: "piece",
    sellingPrice: "15.00",
    taxClass: "VATABLE",
    productType: "BRANDED",
    isScEligible: false,
    isPwdEligible: false,
    openingQuantity: 5,
    openingUnitCost: "4.00",
  });
  expect(productResponse.status()).toBe(201);
  const { product } = (await productResponse.json()) as {
    product: { id: string };
  };

  const openedResponse = await postApi(cashierPage, "/api/shifts", {
    openingCash: "100.00",
  });
  expect(openedResponse.status()).toBe(201);
  const { shift } = (await openedResponse.json()) as {
    shift: { id: string };
  };
  const saleResponse = await postApi(cashierPage, "/api/sales", {
    benefitType: "REGULAR",
    paymentMethod: "QR",
    requestKey: randomUUID(),
    items: [{ productId: product.id, quantity: 1, benefitApplied: false }],
  });
  expect(saleResponse.status()).toBe(201);

  await cashierPage.goto("/checkout");
  await expect(
    cashierPage.getByText("Expected physical cash: ₱100.00"),
  ).toBeVisible();
  await expect(
    cashierPage.getByText("Expected QR sales: ₱15.00"),
  ).toBeVisible();

  await ownerPage.goto("/checkout");
  await expect(
    ownerPage.getByText(
      /Emergency close: shift opened by cashier@example\.test/u,
    ),
  ).toBeVisible();
  await expect(
    ownerPage.locator("#emergency-shift-variance-reason option"),
  ).toHaveCount(4);
  await ownerPage.getByLabel("Actual physical cash count (₱)").fill("98.00");
  await ownerPage
    .getByLabel("Variance reason if count differs")
    .selectOption({ label: "Customer Fault" });
  await ownerPage
    .getByRole("button", { name: "Emergency close shift" })
    .click();
  await expect(
    ownerPage
      .getByRole("status")
      .filter({ hasText: "Emergency shift close recorded." }),
  ).toBeVisible();

  const historyResponse = await ownerPage.request.get("/api/shifts/history");
  const history = (await historyResponse.json()) as {
    shifts: Array<{
      id: string;
      closedByEmail: string | null;
      varianceReason: string | null;
    }>;
  };
  expect(history.shifts.find((item) => item.id === shift.id)).toMatchObject({
    closedByEmail: owner.email,
    varianceReason: "Customer Fault",
  });

  await cashierContext.close();
  await ownerContext.close();
});

test("adding a searched product clears the checkout search", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner);
  const productName = `Synthetic Search Product ${randomUUID().slice(0, 8)}`;
  const productResponse = await postApi(ownerPage, "/api/products", {
    sku: `SYN-SEARCH-${randomUUID().slice(0, 8)}`,
    name: productName,
    unit: "piece",
    sellingPrice: "15.00",
    taxClass: "VATABLE",
    productType: "BRANDED",
    isScEligible: false,
    isPwdEligible: false,
    openingQuantity: 3,
    openingUnitCost: "1.00",
  });
  expect(productResponse.status()).toBe(201);
  await ownerContext.close();

  const cashierPage = await browser.newPage();
  await signIn(cashierPage, cashier);
  const shiftResponse = await postApi(cashierPage, "/api/shifts", {
    openingCash: "0.00",
  });
  expect(shiftResponse.status()).toBe(201);
  await cashierPage.reload();

  const search = cashierPage.getByLabel("Search catalog");
  await search.fill(productName);
  await cashierPage.getByRole("button", { name: "Add to cart" }).click();

  await expect(search).toHaveValue("");
  await expect(
    cashierPage.locator(".cart-lines").getByText(productName, { exact: true }),
  ).toBeVisible();
  await cashierPage.close();
});

test("cart quantity can be edited within available stock and above zero", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner);
  const productName = `Synthetic Quantity Product ${randomUUID().slice(0, 8)}`;
  const productResponse = await postApi(ownerPage, "/api/products", {
    sku: `SYN-QUANTITY-${randomUUID().slice(0, 8)}`,
    name: productName,
    unit: "piece",
    sellingPrice: "15.00",
    taxClass: "VATABLE",
    productType: "BRANDED",
    isScEligible: false,
    isPwdEligible: false,
    openingQuantity: 5,
    openingUnitCost: "1.00",
  });
  expect(productResponse.status()).toBe(201);
  await ownerContext.close();

  const cashierPage = await browser.newPage();
  await signIn(cashierPage, cashier);
  const currentShiftResponse = await cashierPage.request.get(
    "/api/shifts/current",
  );
  const currentShift = (await currentShiftResponse.json()) as {
    shift: null | { id: string };
  };
  const shift = currentShift.shift
    ? currentShift.shift
    : await (async () => {
        const response = await postApi(cashierPage, "/api/shifts", {
          openingCash: "0.00",
        });
        expect(response.status()).toBe(201);
        return (await response.json()).shift as { id: string };
      })();
  await cashierPage.reload();

  await cashierPage.getByLabel("Search catalog").fill(productName);
  await cashierPage.getByRole("button", { name: "Add to cart" }).click();
  const quantity = cashierPage.getByRole("spinbutton", {
    name: `Quantity for ${productName}`,
  });
  await expect(quantity).toHaveCSS("border-top-color", "rgb(189, 207, 199)");
  await expect(quantity).toHaveAttribute(
    "title",
    "Type a quantity from 1 to 5",
  );
  await quantity.click();
  await quantity.pressSequentially("4");
  await expect(quantity).toHaveValue("4");
  await quantity.fill("99");
  await expect(quantity).toHaveValue("5");
  await quantity.fill("0");
  await quantity.blur();
  await expect(quantity).toHaveValue("5");

  const closeResponse = await postApi(
    cashierPage,
    `/api/shifts/${shift.id}/close`,
    { actualCashCount: "0.00" },
  );
  expect(closeResponse.status()).toBe(200);
  await cashierPage.close();
});

test("daily sales, Journal lock, and report summary cover the current business day", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner);
  const productName = `Synthetic Daily Sales Product ${randomUUID().slice(0, 8)}`;
  const productResponse = await postApi(ownerPage, "/api/products", {
    sku: `SYN-DAILY-${randomUUID().slice(0, 8)}`,
    name: productName,
    unit: "piece",
    sellingPrice: "15.00",
    taxClass: "VATABLE",
    productType: "BRANDED",
    isScEligible: false,
    isPwdEligible: false,
    openingQuantity: 5,
    openingUnitCost: "1.00",
  });
  expect(productResponse.status()).toBe(201);
  const { product } = (await productResponse.json()) as {
    product: { id: string };
  };

  const cashierPage = await browser.newPage();
  await signIn(cashierPage, cashier);
  const shiftResponse = await postApi(cashierPage, "/api/shifts", {
    openingCash: "0.00",
  });
  expect(shiftResponse.status()).toBe(201);
  const saleResponse = await postApi(cashierPage, "/api/sales", {
    benefitType: "REGULAR",
    paymentMethod: "CASH",
    requestKey: randomUUID(),
    items: [{ productId: product.id, quantity: 2, benefitApplied: false }],
  });
  expect(saleResponse.status()).toBe(201);
  const savedSale = (await saleResponse.json()) as {
    sale: { transactionId: string; businessDate: string };
  };

  await ownerPage.goto("/daily-sales");
  await expect(
    ownerPage.getByRole("heading", { name: "Daily sales journal" }),
  ).toBeVisible();
  await expect(
    ownerPage.locator(".daily-sales-journal-summary tbody tr"),
  ).toContainText(/MTX-\d{8}-\d{6}/);
  await expect(
    ownerPage.locator(".daily-sales-journal-summary tbody tr"),
  ).toContainText("30.00");

  await ownerPage.goto("/journal");
  await expect(
    ownerPage.getByRole("heading", { name: "Journal" }),
  ).toBeVisible();
  const journalRow = ownerPage
    .getByRole("row")
    .filter({ hasText: savedSale.sale.transactionId });
  await expect(journalRow).toHaveClass(/journal-row-unedited/);
  await expect(journalRow.getByRole("button", { name: "Edit" })).toBeDisabled();
  await ownerPage.goto("/daily-sales");
  await expect(
    ownerPage.locator(".daily-sales-journal-summary tbody tr"),
  ).toContainText("30.00");

  await ownerPage.goto("/reports");
  await ownerPage.getByRole("button", { name: "Month to date" }).click();
  const dailySalesSection = ownerPage.locator(".report-low-stock").filter({
    has: ownerPage.getByRole("heading", { name: "Daily sales summary" }),
  });
  await expect(
    dailySalesSection.getByRole("columnheader", { name: "Date" }),
  ).toBeVisible();
  const dailySalesRow = dailySalesSection
    .getByRole("row")
    .filter({ hasText: savedSale.sale.transactionId });
  await expect(dailySalesRow).toContainText(savedSale.sale.businessDate);
  await expect(dailySalesRow).toContainText("30.00");
  await expect(dailySalesRow).not.toHaveClass(/journal-row-unedited/);

  const manualSaleDate = manilaDayAfter(-1);
  await ownerPage.goto("/manual-checkout");
  await expect(
    ownerPage.getByRole("heading", { name: "Manual checkout" }),
  ).toBeVisible();
  await expect(ownerPage.getByText("REGISTER REQUIRED")).toHaveCount(0);
  await expect(
    ownerPage.getByRole("heading", { name: "Open a cashier shift" }),
  ).toHaveCount(0);
  await expect(
    ownerPage.getByRole("heading", { name: "Recent transactions" }),
  ).toHaveCount(0);
  await expect(
    ownerPage.getByRole("button", { name: "Preview sample invoice" }),
  ).toHaveCount(0);
  await expect(ownerPage.getByLabel("Cash received from customer")).toHaveCount(
    0,
  );
  await expect(ownerPage.getByText("Change for customer")).toHaveCount(0);
  await expect(
    ownerPage.getByText(
      "The amount due is filled in automatically. Edit it to match the cash received.",
    ),
  ).toHaveCount(0);
  await ownerPage.getByLabel("Sale business date").fill(manualSaleDate);
  await ownerPage.getByLabel("Search catalog").fill(productName);
  const manualCatalogRow = ownerPage
    .locator(".catalog-result")
    .filter({ hasText: productName });
  await manualCatalogRow.getByRole("button", { name: "Add to cart" }).click();
  await ownerPage.getByLabel("Quantity to add").fill("1");
  await ownerPage
    .getByRole("dialog")
    .getByRole("button", { name: "Add to cart" })
    .click();
  await ownerPage
    .getByRole("button", { name: "Calculate line taxes and discounts" })
    .click();
  await ownerPage.getByRole("button", { name: "Save manual sale" }).click();
  await expect(
    ownerPage.getByText(`Manual sale saved for ${manualSaleDate}.`),
  ).toBeVisible();
  await expect(
    ownerPage.getByRole("heading", { name: "Sample sales invoice" }),
  ).toHaveCount(0);
  await expect(
    ownerPage
      .locator(".sale-saved-card")
      .getByText(`Business date: ${manualSaleDate}`),
  ).toBeVisible();

  await cashierPage.goto("/daily-sales");
  await expect(
    cashierPage.getByRole("heading", { name: "Daily sales" }),
  ).toBeVisible();
  await expect(
    cashierPage
      .locator(".daily-sales-totals")
      .getByText(/₱\d+\.\d{2}/)
      .first(),
  ).toBeVisible();
  const productRow = cashierPage
    .getByRole("row")
    .filter({ hasText: productName });
  await expect(productRow.getByRole("cell").nth(2)).toHaveText("2");
  await expect(productRow.getByRole("cell").nth(3)).toHaveText("₱30.00");
  await expect(
    cashierPage.getByText("Your shifts with sales on this date."),
  ).toBeVisible();
  await expect(cashierPage.locator(".daily-sales-journal-summary")).toHaveCount(
    0,
  );
  await expect(cashierPage.getByRole("link", { name: "Journal" })).toHaveCount(
    0,
  );

  const currentShift = await cashierPage.request.get("/api/shifts/current");
  const { shift } = (await currentShift.json()) as { shift: { id: string } };
  const closeResponse = await postApi(
    cashierPage,
    `/api/shifts/${shift.id}/close`,
    { actualCashCount: "30.00" },
  );
  expect(closeResponse.status()).toBe(200);
  await cashierPage.close();
  await ownerContext.close();
});

test("checkout gates a missing shift with a modal and closes shifts inside checkout", async ({
  page,
}) => {
  await signIn(page, cashier);
  await page.clock.install({ time: new Date() });
  const openDialog = page.getByRole("dialog", {
    name: "Open a cashier shift",
  });
  await expect(openDialog).toBeVisible();
  await page.getByLabel(/Opening cash/).fill("25.00");
  await openDialog.getByRole("button", { name: "Open shift" }).click();
  await expect(openDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Close shift" })).toBeVisible();
  await expect(page.getByText(/Open for 0h \d+m/)).toBeVisible();
  await page.clock.fastForward(61 * 60 * 1000);
  await expect(page.getByText(/Open for 1h \d+m/)).toBeVisible();

  await page.getByRole("button", { name: "Close shift" }).click();
  const closeDialog = page.getByRole("dialog", {
    name: "Close cashier shift",
  });
  await expect(closeDialog).toBeVisible();
  await page.getByLabel("Actual cash count (₱)").fill("25.00");
  await closeDialog.getByRole("button", { name: "Close shift" }).click();
  await expect(closeDialog).toBeHidden();
  await expect(openDialog).toBeVisible();
});

test("checkout prices render green and discounts render red", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner);
  const productName = `Synthetic Price Color Product ${randomUUID().slice(0, 8)}`;
  const productResponse = await postApi(ownerPage, "/api/products", {
    sku: `SYN-COLOR-${randomUUID().slice(0, 8)}`,
    name: productName,
    unit: "piece",
    sellingPrice: "15.00",
    taxClass: "VATABLE",
    productType: "BRANDED",
    isScEligible: false,
    isPwdEligible: false,
    openingQuantity: 3,
    openingUnitCost: "1.00",
  });
  expect(productResponse.status()).toBe(201);
  await ownerContext.close();

  const cashierPage = await browser.newPage();
  await signIn(cashierPage, cashier);
  const shiftResponse = await postApi(cashierPage, "/api/shifts", {
    openingCash: "0.00",
  });
  expect(shiftResponse.status()).toBe(201);
  await cashierPage.reload();
  await cashierPage.getByLabel("Search catalog").fill(productName);
  await cashierPage.getByRole("button", { name: "Add to cart" }).click();
  await cashierPage
    .getByRole("button", { name: "Calculate line taxes and discounts" })
    .click();

  await expect(cashierPage.locator(".checkout-line-price").last()).toHaveCSS(
    "color",
    "rgb(23, 107, 91)",
  );
  await expect(
    cashierPage.locator(".checkout-line-discount").first(),
  ).toHaveCSS("color", "rgb(180, 35, 24)");

  const currentShiftResponse = await cashierPage.request.get(
    "/api/shifts/current",
  );
  const { shift } = (await currentShiftResponse.json()) as {
    shift: { id: string };
  };
  const closeResponse = await postApi(
    cashierPage,
    `/api/shifts/${shift.id}/close`,
    { actualCashCount: "0.00" },
  );
  expect(closeResponse.status()).toBe(200);
  await cashierPage.close();
});

test("stock lots let an owner edit expiry dates with a correction reason", async ({
  page,
}) => {
  await signIn(page, owner);
  const lotCode = `SYN-EDIT-EXPIRY-${randomUUID().slice(0, 8)}`;
  const productResponse = await postApi(page, "/api/products", {
    sku: `SYN-EXPIRY-${randomUUID().slice(0, 8)}`,
    name: `Synthetic Expiry Edit Product ${randomUUID().slice(0, 8)}`,
    unit: "box",
    sellingPrice: "15.00",
    taxClass: "VATABLE",
    productType: "BRANDED",
    tracksLots: true,
    isScEligible: false,
    isPwdEligible: false,
    openingQuantity: 4,
    openingUnitCost: "1.00",
    openingLotCode: lotCode,
    openingExpiryDate: manilaDayAfter(30),
  });
  expect(productResponse.status()).toBe(201);

  await page.goto("/stock");
  const lotRow = page.getByRole("row").filter({ hasText: lotCode });
  await lotRow.getByRole("button", { name: "Edit expiry" }).click();
  await lotRow.getByLabel("New expiry date").fill(manilaDayAfter(45));
  await lotRow
    .getByLabel("Reason for correction")
    .fill("Synthetic package date transcription correction");
  await lotRow.getByRole("button", { name: "Save expiry date" }).click();

  await expect(
    page.getByRole("status").filter({ hasText: "Expiry date updated." }),
  ).toBeVisible();
  await expect(lotRow.getByRole("cell").nth(1)).toHaveText(manilaDayAfter(45));
});

test("name and birthday fill ID type and number from a saved PWD customer", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner);
  const productName = `Synthetic Beneficiary Product ${randomUUID().slice(0, 8)}`;
  const productResponse = await postApi(ownerPage, "/api/products", {
    sku: `SYN-BENEFIT-LOOKUP-${randomUUID().slice(0, 8)}`,
    name: productName,
    unit: "piece",
    sellingPrice: "15.00",
    taxClass: "VATABLE",
    productType: "BRANDED",
    isScEligible: false,
    isPwdEligible: true,
    openingQuantity: 5,
    openingUnitCost: "1.00",
  });
  expect(productResponse.status()).toBe(201);
  const { product } = (await productResponse.json()) as {
    product: { id: string };
  };
  await ownerContext.close();

  const cashierPage = await browser.newPage();
  await signIn(cashierPage, cashier);
  const shiftResponse = await postApi(cashierPage, "/api/shifts", {
    openingCash: "0.00",
  });
  expect(shiftResponse.status()).toBe(201);
  const previousSale = await postApi(cashierPage, "/api/sales", {
    benefitType: "PWD",
    paymentMethod: "QR",
    requestKey: randomUUID(),
    customerName: "Synthetic Saved PWD Customer",
    customerBirthday: "1980-04-12",
    customerIdType: "Synthetic PWD ID",
    customerIdNumber: "SYN-PWD-AUTOFILL-91",
    customerIdChecked: true,
    items: [{ productId: product.id, quantity: 1, benefitApplied: true }],
  });
  expect(previousSale.status()).toBe(201);

  await cashierPage.reload();
  await cashierPage.getByLabel("Search catalog").fill(productName);
  await cashierPage.getByRole("button", { name: "Add to cart" }).click();
  await cashierPage.getByLabel("Sale benefit").selectOption("PWD");
  await cashierPage
    .getByRole("checkbox", {
      name: `${productName} · 20% + VAT exemption · eligible`,
    })
    .check();
  await cashierPage
    .getByLabel("Customer name")
    .fill("Synthetic Saved PWD Customer");
  await cashierPage.getByLabel("Birthday").fill("1980-04-12");
  await expect(
    cashierPage.getByRole("status").filter({
      hasText: "ID type and number filled from a previous sale.",
    }),
  ).toBeVisible();
  await expect(cashierPage.getByLabel("ID type")).toHaveValue(
    "Synthetic PWD ID",
  );
  await expect(cashierPage.getByLabel("ID number")).toHaveValue(
    "SYN-PWD-AUTOFILL-91",
  );

  const currentShiftResponse = await cashierPage.request.get(
    "/api/shifts/current",
  );
  const { shift } = (await currentShiftResponse.json()) as {
    shift: { id: string };
  };
  const closeResponse = await postApi(
    cashierPage,
    `/api/shifts/${shift.id}/close`,
    { actualCashCount: "0.00" },
  );
  expect(closeResponse.status()).toBe(200);
  await cashierPage.close();
});
