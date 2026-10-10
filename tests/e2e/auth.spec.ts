import { expect, test } from "@playwright/test";

const ownerCredentials = {
  username: "owner",
  password: "SyntheticOwnerPassword-48!",
};

test("owner can sign in, open a browser route directly, and add a cashier", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login$/);
  await page
    .getByLabel("Email address or username")
    .fill(ownerCredentials.username);
  await page
    .getByLabel("Password", { exact: true })
    .fill(ownerCredentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "Staff accounts" }),
  ).toBeVisible();

  await page
    .getByLabel("Email address", { exact: true })
    .fill("pilot.cashier@example.test");
  await page.getByLabel("Username", { exact: true }).fill("pilot-cashier");
  await page.getByLabel("Temporary password").fill("SyntheticPilotCashier-53!");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Staff account created.")).toBeVisible();
  await expect(page.getByText("pilot.cashier@example.test")).toBeVisible();
  await expect(
    page.getByText("@pilot-cashier", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Staff accounts" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email address or username").fill("pilot-cashier");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticPilotCashier-53!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
});

test("cashier cannot see or open owner pages and direct owner API requests are forbidden", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page
    .getByLabel("Email address or username")
    .fill("cashier@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticCashierPassword-72!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByRole("link", { name: "Products" })).toHaveCount(0);
  await page.goto("/products");
  await expect(page).toHaveURL(/\/checkout$/);

  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const response = await page.request.post("/api/users", {
    data: {
      email: "api.attack@example.test",
      password: "SyntheticApiAttack-31!",
      role: "owner",
    },
    headers: { "x-csrf-token": csrf.token },
  });
  expect(response.status()).toBe(403);

  await page.reload();
  await page.getByRole("link", { name: "My account" }).click();
  await expect(
    page.getByRole("heading", { name: "Change password" }),
  ).toBeVisible();
  await page
    .getByLabel("Current password")
    .fill("SyntheticCashierPassword-72!");
  await page
    .getByLabel("New password", { exact: true })
    .fill("SyntheticCashierPassword-84!");
  await page
    .getByLabel("Confirm new password")
    .fill("SyntheticCashierPassword-84!");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/);
  await expect(
    page.getByText("Password changed. Sign in with your new password."),
  ).toBeVisible();
  await page
    .getByLabel("Email address or username")
    .fill("cashier@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticCashierPassword-84!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await context.close();
});
