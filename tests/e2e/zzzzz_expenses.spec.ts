import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email address or username").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/(checkout|dashboard)$/);
}

async function post(page: Page, path: string, data: Record<string, unknown>) {
  const token = (await (await page.request.get("/api/auth/csrf")).json())
    .token as string;
  return page.request.post(`/api${path}`, {
    data,
    headers: { "x-csrf-token": token },
  });
}

test("owner and cashier record expenses from zero cash and reconcile negative balances", async ({
  page: ownerPage,
  browser,
}, testInfo) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  ownerPage.on("pageerror", (error) => pageErrors.push(error.message));
  await signIn(ownerPage, "owner@example.test", "SyntheticOwnerPassword-48!");
  const email = `expense-${randomUUID().slice(0, 8)}@example.test`;
  const secondEmail = `expense-entry-${randomUUID().slice(0, 8)}@example.test`;
  const password = "SyntheticExpenseCashier-42!";
  expect(
    (
      await post(ownerPage, "/users", { email, password, role: "cashier" })
    ).status(),
  ).toBe(201);
  expect(
    (
      await post(ownerPage, "/users", {
        email: secondEmail,
        password,
        role: "cashier",
      })
    ).status(),
  ).toBe(201);
  const current = await (
    await ownerPage.request.get("/api/shifts/current")
  ).json();
  if (current.registerShift) {
    expect(
      (
        await post(
          ownerPage,
          `/shifts/${current.registerShift.id}/emergency-close`,
          {
            actualCashCount: current.registerShift.expectedCash.startsWith("-")
              ? "0.00"
              : current.registerShift.expectedCash,
            ...(current.registerShift.expectedCash.startsWith("-")
              ? { varianceReason: "No Fault" }
              : {}),
          },
        )
      ).status(),
    ).toBe(200);
  }
  const cashierContext = await browser.newContext({
    baseURL: new URL(ownerPage.url()).origin,
  });
  await cashierContext.addInitScript(() => {
    Object.defineProperty(window.crypto, "randomUUID", { value: undefined });
  });
  const page = await cashierContext.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await signIn(page, email, password);
    const shift = await post(page, "/shifts", { openingCash: "0.00" });
    expect(shift.status()).toBe(201);
    const shiftId = (await shift.json()).shift.id as string;
    await page.reload();
    await page
      .getByRole("link", { name: "Payments & Expenses", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Payments & Expenses", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Amount (₱)", { exact: true }).fill("40.00");
    await page.getByLabel("Description (optional)").fill("E2E staff lunch");
    await page
      .getByRole("button", { name: "Record expense", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Expected cashier cash: ₱-40.00",
    );

    await page
      .getByRole("combobox", { name: "Category", exact: true })
      .selectOption("DELIVERY");
    await page
      .getByLabel("This delivery fee is already included in product unit cost")
      .check();
    await page.getByLabel("Delivery fee (₱)").fill("20.00");
    await page
      .getByLabel("Description (optional)")
      .fill("E2E delivery already in unit cost");
    await page
      .getByRole("button", { name: "Record expense", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Expected cashier cash: ₱-60.00",
    );

    await page
      .getByRole("combobox", {
        name: "Who pays the delivery fee?",
        exact: true,
      })
      .selectOption("OWNER");
    await page.getByLabel("Delivery fee (₱)").fill("10.00");
    await page
      .getByLabel("Description (optional)")
      .fill("E2E delivery paid by owner");
    await page
      .getByRole("button", { name: "Record expense", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("Paid by owner");
    await expect(
      page
        .locator(".report-summary-strip > div")
        .filter({ hasText: "OPERATING EXPENSES" }),
    ).toContainText("₱50.00");
    await expect(
      page
        .locator(".report-summary-strip > div")
        .filter({ hasText: "ALREADY IN UNIT COST" }),
    ).toContainText("₱20.00");

    await ownerPage.goto("/expenses");
    await expect(
      ownerPage.getByRole("link", { name: "Payments & Expenses", exact: true }),
    ).toBeVisible();
    await ownerPage
      .getByRole("combobox", { name: "Category", exact: true })
      .selectOption("OTHER");
    await ownerPage.getByLabel("Amount (₱)", { exact: true }).fill("15.00");
    await ownerPage
      .getByLabel("Description", { exact: true })
      .fill("E2E cleaning supplies");
    await ownerPage
      .getByRole("button", { name: "Record expense", exact: true })
      .click();
    await expect(ownerPage.getByRole("status")).toContainText(
      "Expected cashier cash: ₱-75.00",
    );
    await expect(
      ownerPage.getByText("E2E cleaning supplies", { exact: true }),
    ).toBeVisible();
    await ownerPage
      .getByRole("combobox", { name: "Category", exact: true })
      .selectOption("STOCK_PURCHASE");
    await ownerPage
      .getByRole("combobox", {
        name: "Who paid the stock purchase?",
        exact: true,
      })
      .selectOption("OWNER");
    await ownerPage
      .getByLabel("Product amount (₱)", { exact: true })
      .fill("15000.00");
    await ownerPage
      .getByLabel("Separate delivery fee (₱, optional)", { exact: true })
      .fill("200.00");
    await ownerPage
      .getByLabel("Supplier (optional)", { exact: true })
      .fill("E2E COD supplier");
    await ownerPage
      .getByLabel("Invoice / receipt reference (optional)", { exact: true })
      .fill("E2E-OWNER-COD");
    await expect(
      ownerPage.getByText("Total payment: ₱15200.00", { exact: true }),
    ).toBeVisible();
    await ownerPage
      .getByRole("button", { name: "Record stock payment", exact: true })
      .click();
    await expect(ownerPage.getByRole("status")).toContainText("Paid by owner");
    await page
      .getByRole("combobox", { name: "Category", exact: true })
      .selectOption("STOCK_PURCHASE");
    await page
      .getByLabel("Product amount (₱)", { exact: true })
      .fill("15000.00");
    await page
      .getByLabel("Separate delivery fee (₱, optional)", { exact: true })
      .fill("200.00");
    await page
      .getByLabel("Supplier (optional)", { exact: true })
      .fill("E2E COD supplier");
    await page
      .getByLabel("Invoice / receipt reference (optional)", { exact: true })
      .fill("E2E-CASHIER-COD");
    await page
      .getByRole("button", { name: "Record stock payment", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Expected cashier cash: ₱-15275.00",
    );
    await ownerPage.screenshot({
      path: testInfo.outputPath("medtryx-expenses-desktop.png"),
      fullPage: true,
    });

    await page.goto("/daily-sales");
    await expect(
      page
        .locator(".report-summary-strip > div")
        .filter({ hasText: "OPERATING EXPENSES" }),
    ).toContainText("₱65.00");
    await expect(
      page.getByText("E2E cleaning supplies", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".report-summary-strip > div")
        .filter({ hasText: /^PAID FROM CASHIER/ }),
    ).toContainText("₱15275.00");
    await expect(
      page
        .locator(".report-summary-strip > div")
        .filter({ hasText: "TOTAL STOCK PAYMENTS" }),
    ).toContainText("₱15200.00");
    await ownerPage.goto("/reports");
    await expect(
      ownerPage
        .locator(".report-metric-row")
        .filter({ hasText: "Operating expenses" }),
    ).toContainText("₱65.00");
    await expect(
      ownerPage
        .locator(".report-metric-row")
        .filter({ hasText: "Total stock purchase payments" }),
    ).toContainText("₱30400.00");
    await expect(
      ownerPage
        .getByRole("row")
        .filter({ hasText: "E2E delivery already in unit cost" }),
    ).toBeVisible();

    await ownerPage.goto("/expenses");
    const ownerCancellation = ownerPage
      .getByRole("row")
      .filter({ hasText: "E2E cleaning supplies" });
    ownerPage.once("dialog", (dialog) => void dialog.accept());
    await ownerCancellation
      .getByRole("button", { name: "Cancel payment", exact: true })
      .click();
    await expect(ownerPage.getByRole("status")).toContainText(
      "Expected cashier cash: \u20B1-15260.00",
    );
    await expect(ownerCancellation).toContainText(
      "Cancelled by owner@example.test",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/expenses");
    await expect(
      page.getByRole("heading", {
        name: "Record payment or expense",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Record expense", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("medtryx-expenses-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
    const secondCashierContext = await browser.newContext({
      baseURL: new URL(ownerPage.url()).origin,
    });
    try {
      const secondCashierPage = await secondCashierContext.newPage();
      secondCashierPage.on("pageerror", (error) =>
        pageErrors.push(error.message),
      );
      await signIn(secondCashierPage, secondEmail, password);
      await secondCashierPage.goto("/expenses");
      await expect(
        secondCashierPage.getByText(`Charged to ${email}`, { exact: true }),
      ).toBeVisible();
      await expect(
        secondCashierPage.getByRole("button", {
          name: "Record expense",
          exact: true,
        }),
      ).toBeEnabled();
      await secondCashierPage
        .locator('input[inputmode="decimal"]')
        .fill("5.00");
      await secondCashierPage
        .getByLabel("Description (optional)")
        .fill("E2E second cashier lunch");
      await secondCashierPage
        .getByRole("button", { name: "Record expense", exact: true })
        .click();
      await expect(secondCashierPage.getByRole("status")).toContainText(
        "Expected cashier cash: ₱-15265.00",
      );
      await expect(
        secondCashierPage.getByText("E2E second cashier lunch", {
          exact: true,
        }),
      ).toBeVisible();
    } finally {
      await secondCashierContext.close();
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/expenses");
    const cashierCancellation = page
      .getByRole("row")
      .filter({ hasText: "E2E-CASHIER-COD" });
    page.once("dialog", (dialog) => void dialog.accept());
    await cashierCancellation
      .getByRole("button", { name: "Cancel payment", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Expected cashier cash: \u20B1-65.00",
    );
    await expect(cashierCancellation).toContainText(`Cancelled by ${email}`);

    await page.goto("/checkout");
    await page
      .getByRole("button", { name: "Close shift", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Close cashier shift" });
    await dialog.getByLabel("Actual cash count (₱)").fill("0.00");
    await expect(dialog.getByLabel("Actual cash count (₱)")).toHaveValue(
      "0.00",
    );
    await dialog
      .getByRole("combobox", { name: "Variance reason if count differs" })
      .selectOption("No Fault");
    await dialog
      .getByRole("button", { name: "Close shift", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    const history = (
      await (await ownerPage.request.get("/api/shifts/history")).json()
    ).shifts as Array<{
      id: string;
      expectedCash: string;
      actualCashCount: string;
      variance: string;
    }>;
    expect(history.find(({ id }) => id === shiftId)).toMatchObject({
      expectedCash: "-65.00",
      actualCashCount: "0.00",
      variance: "65.00",
    });
  } finally {
    await cashierContext.close();
  }
});
