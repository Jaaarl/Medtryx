import { expect, test } from "@playwright/test";

test("owner can open the receipt receiving workflow and choose receipt pages", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);

  await page.goto("/receipt-receiving");
  await expect(
    page.getByRole("heading", { name: "Receipt receiving" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose PDF or image pages" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Extract and prepare CSV" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Upload edited CSV for validation" }),
  ).toBeDisabled();
});
