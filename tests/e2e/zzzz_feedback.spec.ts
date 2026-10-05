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
  const response = await page.request.post(path, {
    data,
    headers: { "x-csrf-token": token },
  });
  return response;
}

test("benefit report, ten-minute payment switch and cancellation, and transaction history work in the UI", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, owner);

  const productResponse = await postApi(ownerPage, "/api/products", {
    sku: "SYN-FEEDBACK-E2E-001",
    name: "Synthetic Feedback Medicine",
    unit: "piece",
    sellingPrice: "112.00",
    taxClass: "VATABLE",
    productType: "BRANDED",
    isScEligible: true,
    isPwdEligible: true,
    openingQuantity: 10,
    openingUnitCost: "40.00",
  });
  expect(productResponse.status()).toBe(201);
  const { product } = (await productResponse.json()) as {
    product: { id: string };
  };

  const cashierContext = await browser.newContext();
  const cashierPage = await cashierContext.newPage();
  await signIn(cashierPage, cashier);
  const currentShiftResponse = await cashierPage.request.get(
    "/api/shifts/current",
  );
  expect(currentShiftResponse.status()).toBe(200);
  const currentShift = (await currentShiftResponse.json()) as {
    shift: unknown | null;
  };
  if (!currentShift.shift) {
    const shiftResponse = await postApi(cashierPage, "/api/shifts", {
      openingCash: "200.00",
    });
    expect(shiftResponse.status()).toBe(201);
  }

  const createSale = async (
    benefitType: "REGULAR" | "SENIOR_CITIZEN" | "PWD",
    paymentMethod: "CASH" | "QR",
    customerName?: string,
  ) => {
    const response = await postApi(cashierPage, "/api/sales", {
      benefitType,
      items: [
        {
          productId: product.id,
          quantity: 1,
          ...(benefitType === "REGULAR" ? {} : { benefitApplied: true }),
        },
      ],
      paymentMethod,
      requestKey: randomUUID(),
      ...(customerName
        ? {
            customerName,
            customerIdType: `${benefitType} Card`,
            customerIdNumber: `SYN-${benefitType}-${randomUUID().slice(0, 8)}`,
            customerIdChecked: true,
          }
        : {}),
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).sale as { transactionId: string };
  };

  const seniorSale = await createSale(
    "SENIOR_CITIZEN",
    "QR",
    "Synthetic E2E Senior",
  );
  const pwdSale = await createSale("PWD", "QR", "Synthetic E2E PWD");
  const correctionSale = await createSale("REGULAR", "CASH");

  await cashierPage.goto("/checkout");
  const recentTransaction = cashierPage
    .locator(".recent-transaction")
    .filter({ hasText: correctionSale.transactionId });
  await expect(recentTransaction).toBeVisible();
  await recentTransaction
    .getByLabel("Reason for payment correction")
    .fill("Synthetic customer changed payment method");
  await recentTransaction
    .getByRole("button", { name: "Switch cash to QR" })
    .click();
  await expect(
    cashierPage.getByRole("status").filter({ hasText: "Payment switched" }),
  ).toBeVisible();

  await recentTransaction
    .getByLabel("Cancellation reason")
    .fill("Synthetic customer cancelled after payment correction");
  await recentTransaction.getByLabel("Returned and saleable; restock").check();
  await recentTransaction
    .getByLabel("I sent the QR refund to the customer.")
    .check();
  await recentTransaction
    .getByRole("button", { name: "Cancel and refund sale" })
    .click();
  await expect(
    cashierPage.getByRole("status").filter({ hasText: "Cancellation" }),
  ).toBeVisible();
  await expect(recentTransaction.getByText(/Cancelled as/)).toBeVisible();

  await ownerPage.goto("/reports");
  await expect(
    ownerPage.getByRole("heading", {
      name: "Senior citizen and PWD customers",
    }),
  ).toBeVisible();
  const benefitTable = ownerPage.locator(".report-low-stock table").first();
  await expect(benefitTable.getByText("Synthetic E2E Senior")).toBeVisible();
  await expect(benefitTable.getByText("Synthetic E2E PWD")).toBeVisible();
  await expect(
    benefitTable.getByText(/Synthetic Feedback Medicine/).first(),
  ).toBeVisible();

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  await ownerPage.getByRole("button", { name: "Month to date" }).click();
  await expect(ownerPage.getByLabel("Start date")).toHaveValue(
    `${today.slice(0, 7)}-01`,
  );
  await expect(ownerPage.getByLabel("End date")).toHaveValue(today);
  await ownerPage.getByRole("button", { name: "Year to date" }).click();
  await expect(ownerPage.getByLabel("Start date")).toHaveValue(
    `${today.slice(0, 4)}-01-01`,
  );
  await ownerPage.getByRole("button", { name: "Today", exact: true }).click();
  await expect(ownerPage.getByLabel("Start date")).toHaveValue(today);
  await expect(ownerPage.getByLabel("End date")).toHaveValue(today);

  await ownerPage.goto("/sales");
  const saleRow = ownerPage
    .getByRole("row")
    .filter({ hasText: correctionSale.transactionId });
  await expect(saleRow).toBeVisible();
  await saleRow.getByRole("button", { name: "Review" }).click();
  await expect(
    ownerPage.getByRole("heading", { name: correctionSale.transactionId }),
  ).toBeVisible();
  const changes = ownerPage.locator(".transaction-change-list");
  await expect(changes.getByText("Payment switched")).toBeVisible();
  await expect(changes.getByText("Sale cancelled")).toBeVisible();
  await expect(
    changes.getByText("Synthetic customer changed payment method"),
  ).toBeVisible();
  await expect(
    changes.getByText("Synthetic customer cancelled after payment correction"),
  ).toBeVisible();
  await expect(changes.getByText(cashier.email).first()).toBeVisible();
  await expect(
    changes
      .getByText(/Synthetic Feedback Medicine \(SYN-FEEDBACK-E2E-001\)/)
      .first(),
  ).toBeVisible();

  await cashierContext.close();
  await ownerContext.close();
  expect(seniorSale.transactionId).toMatch(/^MTX-/);
  expect(pwdSale.transactionId).toMatch(/^MTX-/);
});
