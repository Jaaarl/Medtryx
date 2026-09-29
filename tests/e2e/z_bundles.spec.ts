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

test("owner approves a virtual bundle and cashier checks out its components", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, "owner@example.test", "SyntheticOwnerPassword-48!");
  const csrfResponse = await ownerPage.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const products = [];
  for (const product of [
    {
      sku: "SYN-BUNDLE-001",
      name: "Synthetic bundle umbrella",
      sellingPrice: "20.00",
    },
    {
      sku: "SYN-BUNDLE-002",
      name: "Synthetic bundle tablets",
      sellingPrice: "10.00",
    },
  ]) {
    const response = await ownerPage.request.post("/api/products", {
      headers: { "x-csrf-token": csrf.token },
      data: {
        ...product,
        unit: "piece",
        taxClass: "VAT_EXEMPT",
        productType: "GENERIC",
        isScEligible: false,
        isPwdEligible: false,
        openingQuantity: 5,
        openingUnitCost: "3.00",
      },
    });
    expect(response.status()).toBe(201);
    products.push((await response.json()).product as { id: string });
  }

  await ownerPage.goto("/bundles");
  await expect(
    ownerPage.getByRole("heading", { name: "Virtual sales bundles" }),
  ).toBeVisible();
  await ownerPage.getByLabel("Bundle code").fill("SYN-RAINY-E2E");
  await ownerPage
    .getByLabel("Bundle name")
    .fill("Synthetic Rainy Season Offer");
  await ownerPage.getByLabel("Active from (Manila date)").fill(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  );
  await ownerPage
    .getByLabel("Suggested reduction rule")
    .selectOption("PERCENT");
  await ownerPage.getByLabel("Percentage reduction").fill("10");
  await ownerPage.getByLabel("Approved promotional price (PHP)").fill("27.00");
  await ownerPage
    .getByLabel("Bundle component 1")
    .selectOption(products[0]!.id);
  await ownerPage
    .getByLabel("Bundle component 2")
    .selectOption(products[1]!.id);
  await ownerPage
    .getByLabel("I approve this exact final promotional price.")
    .check();
  await ownerPage
    .getByRole("button", { name: "Create and approve offer" })
    .click();
  await expect(ownerPage.getByText(/Version saved/)).toBeVisible();
  await expect(
    ownerPage.getByText("SYN-RAINY-E2E · Synthetic Rainy Season Offer · v1"),
  ).toBeVisible();
  await ownerContext.close();

  const cashierContext = await browser.newContext();
  const cashierPage = await cashierContext.newPage();
  await signIn(
    cashierPage,
    "cashier@example.test",
    "SyntheticCashierPassword-84!",
  );
  await cashierPage.getByLabel("Opening cash (₱)").fill("100.00");
  await cashierPage.getByRole("button", { name: "Open shift" }).click();
  await expect(cashierPage.getByText("Cashier shift opened.")).toBeVisible();
  await cashierPage.getByRole("button", { name: "Add bundle" }).click();
  await expect(
    cashierPage.getByText(/Synthetic Rainy Season Offer · SYN-RAINY-E2E/),
  ).toHaveCount(2);
  await cashierPage
    .getByRole("button", { name: "Calculate line taxes and discounts" })
    .click();
  await expect(cashierPage.getByText(/advertised ₱27.00/)).toBeVisible();
  await expect(
    cashierPage.getByText("Synthetic bundle umbrella × 1", { exact: true }),
  ).toBeVisible();
  await cashierPage.getByRole("button", { name: "Confirm sale" }).click();
  await expect(cashierPage.getByText("Sale saved.")).toBeVisible();
  await cashierContext.close();

  const editContext = await browser.newContext();
  const editPage = await editContext.newPage();
  await signIn(editPage, "owner@example.test", "SyntheticOwnerPassword-48!");
  await editPage.goto("/bundles");
  await editPage
    .getByRole("article")
    .filter({ hasText: "SYN-RAINY-E2E" })
    .getByRole("button", { name: "Edit version" })
    .click();
  await editPage.getByLabel("Approved promotional price (PHP)").fill("26.00");
  await editPage
    .getByLabel("I approve this exact final promotional price.")
    .check();
  await editPage.getByRole("button", { name: "Approve new version" }).click();
  await expect(editPage.getByText(/Version saved/)).toBeVisible();
  const savedOffer = editPage
    .getByRole("article")
    .filter({ hasText: "SYN-RAINY-E2E" });
  await expect(savedOffer).toContainText("v2");
  await savedOffer.getByRole("button", { name: "Deactivate" }).click();
  await expect(editPage.getByText("Bundle offer deactivated.")).toBeVisible();
  await expect(savedOffer).toContainText("Inactive");
  await editContext.close();
});
