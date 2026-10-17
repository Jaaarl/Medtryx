import { expect, test } from "@playwright/test";

for (const width of [375, 1440]) {
  test(`checkout previews and records a partial refund at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/login");
    await page
      .getByLabel("Email address or username")
      .fill("owner@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("SyntheticOwnerPassword-48!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/checkout$/);
    const fixture = await page.evaluate(async (viewport) => {
      async function post(path: string, body: unknown) {
        const csrf = (await (await fetch("/api/auth/csrf")).json()) as {
          token: string;
        };
        const response = await fetch(`/api${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrf.token,
          },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
        return result;
      }
      const product = (await post("/products", {
        name: `Synthetic partial refund ${viewport}`,
        unit: "tablet",
        sellingPrice: "10.00",
        taxClass: "VATABLE",
        productType: "BRANDED",
        isScEligible: false,
        isPwdEligible: false,
        openingQuantity: 10,
        openingUnitCost: "4.00",
      })) as { product: { id: string } };
      const current = (await (await fetch("/api/shifts/current")).json()) as {
        shift: unknown;
      };
      if (!current.shift) await post("/shifts", { openingCash: "100.00" });
      const sale = (await post("/sales", {
        benefitType: "REGULAR",
        paymentMethod: "CASH",
        requestKey: crypto.randomUUID(),
        items: [{ productId: product.product.id, quantity: 3 }],
      })) as { sale: { transactionId: string } };
      return {
        transactionId: sale.sale.transactionId,
        productId: product.product.id,
      };
    }, width);
    const { transactionId } = fixture;
    await page.reload();
    const transaction = page.locator("article").filter({
      has: page.locator(".recent-transaction-heading", {
        hasText: transactionId,
      }),
    });
    await transaction
      .getByRole("button", { name: "Cancel sale", exact: true })
      .click();
    await expect(transaction.getByRole("status")).toContainText("₱30.00");
    await transaction.getByLabel("Refund option").selectOption("PARTIAL");
    const submit = transaction.getByRole("button", {
      name: "Record partial refund",
    });
    await expect(submit).toBeDisabled();
    await transaction.getByLabel(/quantity to refund/).fill("1");
    await expect(transaction.getByRole("status")).toContainText("₱10.00");
    await transaction
      .getByRole("radio", { name: "Returned and saleable; restock" })
      .check();
    await transaction
      .getByLabel("Cancellation reason")
      .selectOption("Customer Fault");
    await expect(submit).toBeEnabled();
    await transaction.screenshot({
      path: `/tmp/medtryx-partial-refund-${width}.png`,
    });
    const response = page.waitForResponse(
      (result) =>
        result.url().endsWith(`/sales/${transactionId}/reversals`) &&
        result.request().method() === "POST",
    );
    await submit.click();
    expect((await response).status()).toBe(201);
    await expect(transaction).toContainText("Partial refund recorded");
    await page.goto(`/sales?transactionId=${transactionId}`);
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: transactionId })
        .getByText("Partially refunded", { exact: true }),
    ).toBeVisible();
    const ownerSaleId = await page.evaluate(async (productId) => {
      const csrf = (await (await fetch("/api/auth/csrf")).json()) as {
        token: string;
      };
      const response = await fetch("/api/sales", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf.token,
        },
        body: JSON.stringify({
          benefitType: "REGULAR",
          paymentMethod: "CASH",
          requestKey: crypto.randomUUID(),
          items: [{ productId, quantity: 3 }],
        }),
      });
      const result = (await response.json()) as {
        sale: { transactionId: string };
      };
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result.sale.transactionId;
    }, fixture.productId);
    await page.goto(`/sales?transactionId=${ownerSaleId}`);
    await page.getByLabel("Refund option").selectOption("PARTIAL");
    await page.getByLabel(/quantity to refund/).fill("1");
    await expect(
      page.getByRole("status").filter({ hasText: "Amount to refund customer" }),
    ).toContainText("₱10.00");
    await page
      .getByLabel("Reason for reversal")
      .fill("One unused item returned");
    await page
      .getByLabel("Owner password")
      .last()
      .fill("SyntheticOwnerPassword-48!");
    const approved = page.waitForResponse(
      (result) =>
        result.url().endsWith(`/sales/${ownerSaleId}/reversals`) &&
        result.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Approve partial refund", exact: true })
      .click();
    const ownerRefund = await approved;
    expect(ownerRefund.status()).toBe(201);
    expect(
      ((await ownerRefund.json()) as { reversal: { amount: string } }).reversal
        .amount,
    ).toBe("10.00");
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: ownerSaleId })
        .getByText("Partially refunded", { exact: true }),
    ).toBeVisible();
  });
}
