import { expect, test } from "@playwright/test";

test("checkout shows a one-hour correction and cancellation window", async ({
  page,
}) => {
  await page.goto("/login");
  await page
    .getByLabel("Email address or username")
    .fill("cashier@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticCashierPassword-72!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);

  await expect(
    page.getByText(
      "Correct a payment or cancel a sale within 1 hour. These are separate actions.",
    ),
  ).toBeVisible();
});
