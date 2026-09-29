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
  await ownerPage.goto("/settings");
  await ownerPage
    .getByLabel("Cash total rounding")
    .selectOption("NEAREST_25_CENTAVOS");
  await expect(
    ownerPage.getByText(/nearest ₱0\.25 for the final cash total/i),
  ).toBeVisible();
  await ownerPage.locator(".tax-approval-attestation input").check();
  await ownerPage
    .getByRole("button", { name: "Record approved policy" })
    .click();
  await expect(
    ownerPage.getByText(
      "Approved policy saved and recorded in the audit history.",
    ),
  ).toBeVisible();
  await ownerPage.goto("/products");
  await expect(
    ownerPage.getByRole("heading", { name: "Products", exact: true }),
  ).toBeVisible();
  await ownerPage
    .getByLabel("SKU (leave blank to generate)")
    .fill("SYN-PILOT-001");
  await ownerPage.getByLabel("Product name").fill("Synthetic Pilot Lotion");
  await ownerPage.getByLabel("Generic").check();
  await ownerPage.getByLabel("Senior Citizen eligible").check();
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
  await expect(productRow).toContainText("Generic");
  await expect(productRow).toContainText("₱5.00");
  await expect(
    ownerPage.getByText(/approved SYNTHETIC-E2E-TAX-12-HALF-UP/i),
  ).toBeVisible();

  await productRow.getByRole("button", { name: "Edit" }).click();
  await expect(ownerPage.getByLabel("Generic")).toBeChecked();
  await expect(ownerPage.getByLabel("Senior Citizen eligible")).toBeChecked();
  await expect(ownerPage.getByLabel("PWD eligible")).not.toBeChecked();
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

  const secondCashierCreated = await ownerContext.request.post("/api/users", {
    data: {
      email: "inventory.second.cashier@example.test",
      password: "SyntheticInventorySecondCashier-39!",
      role: "cashier",
    },
    headers: { "x-csrf-token": csrf.token },
  });
  expect(secondCashierCreated.status()).toBe(201);

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
  await expect(catalogRow).toContainText("Generic");
  await expect(catalogRow).toContainText("₱11.99 · 5 available");
  await expect(
    cashierPage.getByText(/average cost|inventory value|gross profit/i),
  ).toHaveCount(0);
  await catalogRow.getByRole("button", { name: "Add to cart" }).click();
  await catalogRow.getByRole("button", { name: "Add to cart" }).click();
  await cashierPage.getByLabel("Sale benefit").selectOption("PWD");
  await expect(
    cashierPage.getByRole("checkbox", {
      name: /Synthetic Pilot Lotion .* not eligible/,
    }),
  ).toBeDisabled();
  await cashierPage.getByLabel("Sale benefit").selectOption("SENIOR_CITIZEN");
  await expect(
    cashierPage.getByRole("checkbox", {
      name: /Synthetic Pilot Lotion .* eligible/,
    }),
  ).toBeEnabled();
  await cashierPage.getByLabel("Sale benefit").selectOption("REGULAR");
  await expect(cashierPage.getByText("₱11.99 × 2")).toBeVisible();
  await expect(cashierPage.getByText("₱23.98")).toBeVisible();
  await cashierPage.getByLabel("Opening cash (₱)").fill("50.00");
  await cashierPage.getByRole("button", { name: "Open shift" }).click();
  await expect(cashierPage.getByText("Cashier shift opened.")).toBeVisible();
  const secondCashierContext = await browser.newContext();
  const secondCashierPage = await secondCashierContext.newPage();
  await signIn(
    secondCashierPage,
    "inventory.second.cashier@example.test",
    "SyntheticInventorySecondCashier-39!",
  );
  await expect(
    secondCashierPage.getByText(/The single cash register is already open/),
  ).toBeVisible();
  await expect(
    secondCashierPage.getByRole("button", { name: "Open shift" }),
  ).toBeDisabled();
  await expect(
    cashierPage.getByText(/Approved tax profile: SYNTHETIC-E2E-TAX-12-HALF-UP/),
  ).toBeVisible();
  await cashierPage
    .getByRole("button", { name: "Calculate line taxes and discounts" })
    .click();
  await expect(
    cashierPage.getByRole("heading", { name: "Server calculation" }),
  ).toBeVisible();
  await expect(cashierPage.getByText("Rounded cash total")).toBeVisible();
  await expect(
    cashierPage.getByText(/Line total before cash rounding: ₱23\.98/),
  ).toBeVisible();
  await expect(
    cashierPage.getByText(/cash rounding adjustment: ₱0\.02/),
  ).toBeVisible();
  await cashierPage.getByRole("button", { name: "Confirm sale" }).click();
  await expect(cashierPage.getByText("Sale saved.")).toBeVisible();
  await expect(
    cashierPage.getByText("INTERNAL SALES RECORD — NOT AN INVOICE"),
  ).toBeVisible();
  const transactionId = await cashierPage
    .locator(".sale-saved-card span")
    .first()
    .innerText();
  expect(transactionId).toMatch(/^MTX-\d{8}-\d{6}$/);
  const saleResponse = await ownerContext.request.get(
    `/api/sales/${transactionId}`,
  );
  expect(saleResponse.status()).toBe(200);
  const savedSale = (await saleResponse.json()) as {
    sale: {
      amountDue: string;
      cashRoundingMode: string;
      cashRoundingAdjustment: string;
      lines: Array<{
        cogs: string;
        quantity: number;
        productType: string;
        isScEligible: boolean;
        isPwdEligible: boolean;
      }>;
    };
  };
  expect(savedSale.sale).toMatchObject({
    amountDue: "24.00",
    cashRoundingMode: "NEAREST_25_CENTAVOS",
    cashRoundingAdjustment: "0.02",
    lines: [
      {
        quantity: 2,
        cogs: "10.80",
        productType: "GENERIC",
        isScEligible: true,
        isPwdEligible: false,
      },
    ],
  });

  await ownerPage.goto("/stock");
  await expect(
    ownerPage.locator(
      ".stock-list-card .inventory-table tbody tr.inventory-row-selected",
    ),
  ).toContainText("3");
  const saleStockEvent = ownerPage
    .locator(".stock-history-card .inventory-table tbody tr")
    .filter({ hasText: "SALE" });
  await expect(saleStockEvent).toContainText("SALE");
  await expect(saleStockEvent).toContainText("10.80");

  await ownerPage.goto("/sales");
  await expect(
    ownerPage.getByRole("heading", { name: "Sales history", exact: true }),
  ).toBeVisible();
  const saleHistoryRow = ownerPage.getByRole("row").filter({
    hasText: transactionId,
  });
  await saleHistoryRow.getByRole("button", { name: "Review" }).click();
  await expect(
    ownerPage.getByRole("heading", { name: transactionId }),
  ).toBeVisible();
  await ownerPage
    .getByLabel("Returned item is sellable; restore to stock")
    .check();
  await ownerPage
    .getByLabel("Reason for reversal")
    .fill("Synthetic browser-test sellable return");
  await ownerPage
    .getByLabel("Owner password")
    .fill("SyntheticOwnerPassword-48!");
  const openShifts = await ownerContext.request.get("/api/shifts/open");
  const cashierShift = (
    (await openShifts.json()) as {
      shifts: Array<{ id: string; cashierEmail: string }>;
    }
  ).shifts.find(
    (shift) => shift.cashierEmail === "inventory.cashier@example.test",
  );
  expect(cashierShift).toBeDefined();
  await ownerPage
    .getByLabel("Cash refund from open drawer")
    .selectOption(cashierShift!.id);
  await ownerPage
    .getByRole("button", { name: "Approve full reversal" })
    .click();
  await expect(
    ownerPage.locator(".banner-success").filter({
      hasText: /Reversal MTR-\d{8}-\d{6} saved/,
    }),
  ).toBeVisible();
  await expect(saleHistoryRow).toContainText("Reversed");
  const cashierShiftResponse = await cashierContext.request.get(
    "/api/shifts/current",
  );
  const cashierShiftState = (await cashierShiftResponse.json()) as {
    shift: { expectedCash: string };
  };
  expect(cashierShiftState.shift.expectedCash).toBe("50.00");
  await cashierPage.goto("/checkout");
  await cashierPage.getByText("Close shift and count cash").click();
  await cashierPage.getByLabel("Actual cash count (₱)").fill("48.00");
  await cashierPage
    .getByLabel("Variance reason if count differs")
    .fill("Synthetic browser-test cash variance");
  await cashierPage.getByRole("button", { name: "Close shift" }).click();
  await expect(cashierPage.getByText("Cashier shift closed.")).toBeVisible();
  await ownerPage.goto("/stock");
  await ownerPage.goto("/sales");
  const varianceRow = ownerPage
    .locator(".variance-approval-row")
    .filter({ hasText: "inventory.cashier@example.test" });
  await expect(varianceRow).toContainText("₱-2.00");
  await varianceRow
    .getByLabel("Owner password")
    .fill("SyntheticOwnerPassword-48!");
  await varianceRow
    .getByLabel("Owner decision note")
    .fill("Synthetic browser-test variance reviewed");
  await varianceRow.getByRole("button", { name: "Approve variance" }).click();
  await expect(
    ownerPage.getByText("Cash variance approved and recorded."),
  ).toBeVisible();
  await expect(
    ownerPage.getByText("No non-zero variances need review."),
  ).toBeVisible();
  const cashierHistoryDenied = await cashierContext.request.get(
    "/api/shifts/history",
  );
  expect(cashierHistoryDenied.status()).toBe(403);
  await ownerPage.goto("/shifts");
  await expect(
    ownerPage.getByRole("heading", { name: "Shift history", exact: true }),
  ).toBeVisible();
  const shiftHistoryRow = ownerPage
    .getByRole("row")
    .filter({ hasText: "inventory.cashier@example.test" });
  await expect(shiftHistoryRow).toContainText("CLOSED");
  await expect(shiftHistoryRow).toContainText("50.00");
  await expect(shiftHistoryRow).toContainText("24.00");
  await expect(shiftHistoryRow).toContainText("48.00");
  await expect(shiftHistoryRow).toContainText("-2.00");
  await ownerPage.goto("/stock");
  const restoredRow = ownerPage
    .locator(".stock-list-card .inventory-table tbody tr")
    .filter({ hasText: "Synthetic Pilot Lotion" });
  await expect(restoredRow).toContainText("5");
  await expect(restoredRow).toContainText("₱27.00");

  const cashierReportDenied =
    await cashierContext.request.get("/api/reports/daily");
  expect(cashierReportDenied.status()).toBe(403);
  const cashierRangeReportDenied = await cashierContext.request.get(
    "/api/reports/range?startDate=2026-04-30&endDate=2026-05-01",
  );
  expect(cashierRangeReportDenied.status()).toBe(403);
  const cashierBackupDenied = await cashierContext.request.get(
    "/api/backups/status",
  );
  expect(cashierBackupDenied.status()).toBe(403);
  await ownerPage.goto("/reports");
  await expect(
    ownerPage.getByRole("heading", { name: "Sales reports", exact: true }),
  ).toBeVisible();
  await expect(ownerPage.getByText("Current inventory value")).toBeVisible();
  await expect(
    ownerPage.getByText("Full reversals", { exact: true }),
  ).toBeVisible();
  await ownerPage.getByLabel("Start date").fill("2026-04-30");
  await ownerPage.getByLabel("End date").fill("2026-05-01");
  await expect(
    ownerPage.getByText("2026-04-30 to 2026-05-01", { exact: true }),
  ).toBeVisible();
  const reportDownload = ownerPage.waitForEvent("download");
  await ownerPage.getByRole("button", { name: "Export CSV" }).click();
  expect((await reportDownload).suggestedFilename()).toMatch(
    /^medtryx-report-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  await ownerPage.getByRole("button", { name: "Month to date" }).click();
  await expect(ownerPage.getByLabel("Start date")).toHaveValue(/-01$/);

  await ownerPage.goto("/backups");
  await expect(
    ownerPage.getByRole("heading", {
      name: "Backups and restore",
      exact: true,
    }),
  ).toBeVisible();
  await ownerPage.getByLabel("Store name").fill("Synthetic E2E Pharmacy");
  await ownerPage.getByRole("button", { name: "Save store identity" }).click();
  await expect(ownerPage.getByText("Store identity saved.")).toBeVisible();
  await expect(ownerPage.getByText("READY", { exact: true })).toBeVisible();
  await ownerPage.getByRole("button", { name: "Create backup now" }).click();
  await expect(
    ownerPage.getByText(/was created and verified in both locations/),
  ).toBeVisible();
  const backupRow = ownerPage
    .locator(".backup-row")
    .filter({ hasText: "Synthetic E2E Pharmacy" });
  await expect(backupRow).toContainText("primary verified");
  await expect(backupRow).toContainText("secondary verified");
  await backupRow.getByRole("radio").check();
  await ownerPage.getByLabel("Verified copy").selectOption("secondary");
  await ownerPage
    .getByLabel("Type the store name above to confirm")
    .fill("Synthetic E2E Pharmacy");
  await ownerPage
    .getByLabel("Current owner password")
    .fill("SyntheticOwnerPassword-48!");
  await ownerPage.getByRole("button", { name: "Restore and sign out" }).click();
  await expect(
    ownerPage.getByText(/Restore completed\. Safety backup/),
  ).toBeVisible();
  await expect(ownerPage).toHaveURL(/\/login$/);
  await signIn(ownerPage, "owner@example.test", "SyntheticOwnerPassword-48!");
  await secondCashierContext.close();
  await cashierContext.close();
  await ownerContext.close();
});

test("owner can page through older shift history", async ({ page }) => {
  await page.route(/\/api\/shifts\/history/u, async (route) => {
    const isOlderPage = new URL(route.request().url()).searchParams.has(
      "beforeOpenedAt",
    );
    const shifts = !isOlderPage
      ? Array.from({ length: 200 }, (_, index) => ({
          id: `synthetic-history-${index}`,
          status: "CLOSED",
          openedAt: new Date(
            Date.UTC(2026, 0, 2) - index * 60_000,
          ).toISOString(),
          closedAt: new Date(
            Date.UTC(2026, 0, 2) - index * 60_000 + 30_000,
          ).toISOString(),
          openedByEmail: "history.cashier@example.test",
          closedByEmail: "history.cashier@example.test",
          openingCash: "50.00",
          cashSales: "10.00",
          qrSales: "0.00",
          cashRefunds: "0.00",
          cashIn: "0.00",
          cashOut: "0.00",
          expectedCash: "60.00",
          actualCashCount: "60.00",
          variance: "0.00",
        }))
      : [
          {
            id: "synthetic-history-older",
            status: "CLOSED",
            openedAt: "2025-01-01T00:00:00.000Z",
            closedAt: "2025-01-01T00:30:00.000Z",
            openedByEmail: "older.history.cashier@example.test",
            closedByEmail: "older.history.cashier@example.test",
            openingCash: "25.00",
            cashSales: "5.00",
            qrSales: "0.00",
            cashRefunds: "0.00",
            cashIn: "0.00",
            cashOut: "0.00",
            expectedCash: "30.00",
            actualCashCount: "30.00",
            variance: "0.00",
          },
        ];
    await route.fulfill({
      json: { shifts, hasMore: !isOlderPage },
    });
  });

  await signIn(page, "owner@example.test", "SyntheticOwnerPassword-48!");
  await page.goto("/shifts");
  await expect(
    page.getByRole("heading", { name: "Shift history", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".shift-history-table tbody tr")).toHaveCount(200);
  await page.getByRole("button", { name: "Load older shifts" }).click();
  await expect(page.locator(".shift-history-table tbody tr")).toHaveCount(201);
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "older.history.cashier@example.test" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Load older shifts" }),
  ).toHaveCount(0);
});
