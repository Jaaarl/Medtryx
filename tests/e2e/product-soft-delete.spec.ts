import { expect, test } from "@playwright/test";

for (const width of [320, 1440]) {
  test(`owner can confirm or cancel soft deletion with stock at ${width}px`, async ({
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
    const productName = `Synthetic mistaken product ${width}px`;
    const created = await page.evaluate(async (name) => {
      const csrf = (await (await fetch("/api/auth/csrf")).json()) as {
        token: string;
      };
      const result = await fetch("/api/products", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf.token,
        },
        body: JSON.stringify({
          name,
          unit: "tablet",
          sellingPrice: "10.00",
          taxClass: "VATABLE",
          productType: "BRANDED",
          isScEligible: false,
          isPwdEligible: false,
          openingQuantity: 10,
          openingUnitCost: "7.00",
        }),
      });
      return {
        status: result.status,
        body: (await result.json()) as { product: { id: string } },
      };
    }, productName);
    expect(created.status).toBe(201);
    await page.goto(`/products?edit=${created.body.product.id}`);
    const deleteButton = page.getByRole("button", {
      name: "Delete product",
      exact: true,
    });
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();
    const dialog = page.getByRole("dialog", {
      name: "Delete product?",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await expect(dialog).toContainText("10 tablet");
    await expect(dialog).toContainText("₱70.00");
    await expect(dialog).toContainText("inventory correction");
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/medtryx-product-soft-delete-${width}.png`,
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("row").filter({ hasText: productName }),
    ).toBeVisible();
    await deleteButton.click();
    const deletedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().endsWith(`/products/${created.body.product.id}`),
    );
    await dialog
      .getByRole("button", { name: "Delete product", exact: true })
      .click();
    expect((await deletedResponse).status()).toBe(204);
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Its history has been kept" }),
    ).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: productName }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Products", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: productName }),
    ).toHaveCount(0);
  });
}
