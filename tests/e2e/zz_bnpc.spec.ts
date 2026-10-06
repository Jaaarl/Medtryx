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
  if (
    email === "cashier@example.test" &&
    !(await page
      .waitForURL(/\/checkout$/u, { timeout: 2_000 })
      .then(() => true)
      .catch(() => false))
  ) {
    await page
      .getByLabel("Password", { exact: true })
      .fill("SyntheticCashierPassword-84!");
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page).toHaveURL(/\/checkout$/u);
}

test("owner approval and cashier BNPC checkout preserve normal VAT", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, "owner@example.test", "SyntheticOwnerPassword-48!");
  const csrf = (await (
    await ownerPage.request.get("/api/auth/csrf")
  ).json()) as {
    token: string;
  };
  const productResponse = await ownerPage.request.post("/api/products", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      sku: "SYN-BNPC-E2E-001",
      name: "Synthetic BNPC E2E product",
      unit: "piece",
      sellingPrice: "112.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      bnpcEligible: true,
      bnpcCategory: "BASIC_NECESSITY",
      openingQuantity: 2,
      openingUnitCost: "30.00",
    },
  });
  expect(productResponse.status()).toBe(201);

  await ownerPage.goto("/settings");
  await expect(
    ownerPage.getByRole("heading", { name: "BNPC 5% benefit policy" }),
  ).toBeVisible();
  await ownerPage
    .getByLabel("I verified this establishment is covered by this policy.")
    .check();
  await ownerPage
    .getByLabel("Owner/accountant review reference")
    .fill("Synthetic E2E approval fixture only");
  await ownerPage
    .getByLabel("Enable this version for live checkout after review.")
    .check();
  await ownerPage
    .getByLabel(
      "The accountant approved the exact centavo, tax, booklet, four-kind, promotion, weekly-cap, and reversal behavior recorded above.",
    )
    .check();
  await ownerPage
    .getByRole("button", { name: "Save new BNPC policy version" })
    .click();
  await expect(
    ownerPage.getByText(/A new BNPC policy version is enabled/u),
  ).toBeVisible();
  await ownerContext.close();

  const cashierContext = await browser.newContext();
  const cashierPage = await cashierContext.newPage();
  await signIn(
    cashierPage,
    "cashier@example.test",
    "SyntheticCashierPassword-72!",
  );
  await expect(
    cashierPage.getByRole("heading", { name: "Open a cashier shift" }),
  ).toBeVisible();
  await cashierPage.getByLabel(/Opening cash/).fill("100.00");
  await cashierPage.getByRole("button", { name: "Open shift" }).click();
  await expect(cashierPage.getByText("Cashier shift opened.")).toBeVisible();
  await cashierPage.getByLabel("Search catalog").fill("SYN-BNPC-E2E-001");
  await cashierPage.getByRole("button", { name: "Add to cart" }).click();
  await cashierPage.getByLabel("Sale benefit").selectOption("PWD");
  await cashierPage
    .getByLabel("Synthetic BNPC E2E product · BNPC 5% eligible")
    .check();
  await expect(cashierPage.getByLabel("Birthday")).toHaveAttribute(
    "required",
    "",
  );
  await cashierPage.getByLabel("Customer name").fill("Synthetic Holder");
  await cashierPage.getByLabel("Birthday").fill("1965-02-03");
  await cashierPage.getByLabel("ID type").fill("Synthetic PWD ID");
  await cashierPage.getByLabel("ID number").fill("SYNTHETIC-ID-DO-NOT-USE");
  await cashierPage.getByLabel("I checked the physical ID").check();
  await cashierPage.getByLabel("I checked the current booklet.").check();
  await cashierPage
    .getByLabel(/I confirmed prior purchase and discount amounts/)
    .check();
  await cashierPage
    .getByRole("button", { name: "Calculate line taxes and discounts" })
    .click();
  await expect(cashierPage.getByText("BNPC discount ₱5.60")).toBeVisible();
  await expect(
    cashierPage.getByText(/Tax basis ₱95.00 · VAT ₱11.40/u),
  ).toBeVisible();
  await cashierPage.getByRole("button", { name: "Confirm sale" }).click();
  await expect(cashierPage.getByText("Sale saved.")).toBeVisible();
  await cashierContext.close();
});
