import { expect, test } from "@playwright/test";

const ownerCredentials = {
  username: "owner",
  password: "SyntheticOwnerPassword-48!",
};
const cashierCredentials = {
  username: "cashier",
  password: "SyntheticCashierPassword-72!",
};

async function signIn(
  page: import("@playwright/test").Page,
  credentials: { username: string; password: string },
) {
  await page.goto("/login");
  await page.getByLabel("Email address or username").fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test("Monthly Goals is separate from Dashboard and cashier access follows the owner setting", async ({
  page,
}) => {
  await page.goto("/monthly-goals");
  await page
    .getByLabel("Email address or username")
    .fill(ownerCredentials.username);
  await page
    .getByLabel("Password", { exact: true })
    .fill(ownerCredentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/monthly-goals$/);
  await expect(
    page.getByRole("heading", { name: "Monthly Goals" }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Show Monthly Goals to cashiers" }),
  ).not.toBeChecked();
  await page.goto("/dashboard");
  await expect(page.locator(".monthly-incentive-card")).toHaveCount(0);

  await page.getByRole("button", { name: "Log out" }).click();
  await signIn(page, cashierCredentials);
  await expect(page.getByRole("link", { name: "Monthly Goals" })).toHaveCount(
    0,
  );
  await page.goto("/monthly-goals");
  await expect(page).toHaveURL(/\/checkout$/);

  await page.getByRole("button", { name: "Log out" }).click();
  await signIn(page, ownerCredentials);
  await page.goto("/monthly-goals");
  await page
    .getByRole("checkbox", { name: "Show Monthly Goals to cashiers" })
    .check();
  await page.getByRole("button", { name: "Save incentive settings" }).click();
  await expect(
    page.getByText("Progress is available on Monthly Goals."),
  ).toBeVisible();
  await expect(page.getByText("Potential incentive")).toBeVisible();
  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(page.getByRole("button", { name: "This month" })).toBeVisible();
  await page.getByRole("button", { name: "This month" }).click();

  await page.getByRole("button", { name: "Log out" }).click();
  await signIn(page, cashierCredentials);
  const monthlyGoalsLink = page.getByRole("link", { name: "Monthly Goals" });
  await expect(monthlyGoalsLink).toBeVisible({ timeout: 20_000 });
  await monthlyGoalsLink.click();
  await expect(
    page.getByRole("heading", { name: "Monthly Goals" }),
  ).toBeVisible();
  await expect(page.locator(".monthly-incentive-card")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Previous month" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save incentive settings" }),
  ).toHaveCount(0);
  await expect(page.getByText("Potential incentive")).toHaveCount(0);
});
