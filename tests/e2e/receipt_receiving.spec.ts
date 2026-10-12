import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function signInAsOwner(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticOwnerPassword-48!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
}

test("owner can open the receipt receiving workflow and choose receipt pages", async ({
  page,
}) => {
  await signInAsOwner(page);

  await page.goto("/receipt-receiving");
  await expect(
    page.getByRole("heading", { name: "Receipt receiving" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose PDF or image pages" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Extract receipt with AI" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Load receipt CSV into editor" }),
  ).toBeVisible();

  const uploadStep = await page.locator(".receipt-step").nth(0).boundingBox();
  const reviewStep = await page.locator(".receipt-step").nth(1).boundingBox();
  expect(uploadStep).not.toBeNull();
  expect(reviewStep).not.toBeNull();
  expect(reviewStep!.y).toBeGreaterThan(uploadStep!.y);
});

test("owner receipt draft survives leaving and reopening the page", async ({
  page,
}) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");

  const columns = [
    "originaldescription",
    "draftid",
    "rearrangedname",
    "quantity",
    "unitcost",
    "supplier",
    "matchstatus",
    "selectedproductid",
    "conversionapproved",
  ];
  const row = [
    "Parsed medicine line",
    randomUUID(),
    "Parsed medicine line",
    "2",
    "14.50",
    "Saved supplier",
    "NEW_PRODUCT",
    "",
    "FALSE",
  ];
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [columns.map(cell).join(","), row.map(cell).join(",")].join(
    "\r\n",
  );
  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "receipt-review.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();

  await page.getByLabel("Supplier", { exact: true }).fill("Edited supplier");
  await page.goto("/checkout");
  await page.goto("/receipt-receiving");

  await expect(page.getByText("1 line items ready to edit")).toBeVisible();
  await expect(page.getByLabel("Supplier", { exact: true })).toHaveValue(
    "Edited supplier",
  );
});

test("owner can collapse and restore a source receipt group", async ({
  page,
}) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");

  const columns = [
    "originaldescription",
    "draftid",
    "sourcegroupid",
    "sourcefile",
    "rearrangedname",
    "quantity",
    "unitcost",
    "supplier",
    "matchstatus",
    "selectedproductid",
    "conversionapproved",
  ];
  const draftId = randomUUID();
  const firstGroupId = randomUUID();
  const secondGroupId = randomUUID();
  const rows = [
    [
      "First parsed medicine",
      draftId,
      firstGroupId,
      "first-page.pdf",
      "First parsed medicine",
      "1",
      "10.00",
      "Saved supplier",
      "NEW_PRODUCT",
      "",
      "FALSE",
    ],
    [
      "Second parsed medicine",
      draftId,
      firstGroupId,
      "first-page.pdf",
      "Second parsed medicine",
      "2",
      "12.00",
      "Saved supplier",
      "NEW_PRODUCT",
      "",
      "FALSE",
    ],
    [
      "Third parsed medicine",
      draftId,
      secondGroupId,
      "second-page.pdf",
      "Third parsed medicine",
      "3",
      "14.00",
      "Saved supplier",
      "NEW_PRODUCT",
      "",
      "FALSE",
    ],
  ];
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    columns.map(cell).join(","),
    ...rows.map((row) => row.map(cell).join(",")),
  ].join("\r\n");
  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "receipt-review.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();

  await page.getByRole("button", { name: "Hide group first-page.pdf" }).click();
  await expect(
    page.getByText("First parsed medicine", { exact: true }),
  ).toBeHidden();
  await expect(
    page.getByText("Second parsed medicine", { exact: true }),
  ).toBeHidden();
  await expect(
    page.getByText("Third parsed medicine", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Show group first-page.pdf" }),
  ).toBeVisible();
  await expect(page.getByText("3 line items ready to edit")).toBeVisible();

  await page.goto("/checkout");
  await page.goto("/receipt-receiving");
  await expect(
    page.getByRole("button", { name: "Show group first-page.pdf" }),
  ).toBeVisible();
  await expect(
    page.getByText("Third parsed medicine", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show group first-page.pdf" }).click();
  await expect(
    page.getByText("First parsed medicine", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Second parsed medicine", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Hide group first-page.pdf" }).click();
  let reviewedCsv = "";
  await page.route("**/api/stock/receipts/ai-review", async (route) => {
    reviewedCsv = route.request().postData() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        valid: true,
        lineCount: 3,
        newProducts: 3,
        existingProducts: 0,
        conversions: 0,
        lines: rows.map((row, index) => ({
          row: index + 1,
          name: row[4],
          quantity: Number(row[5]),
          unitCost: row[6],
          unitCostRounded: false,
          lineTotal: row[6],
          conversionFactor: null,
        })),
      }),
    });
  });
  await page.getByRole("button", { name: "Validate receipt" }).click();
  await expect(page.getByText("Ready for confirmation")).toBeVisible();
  expect(reviewedCsv).toContain("First parsed medicine");
  expect(reviewedCsv).toContain("Second parsed medicine");
  expect(reviewedCsv).toContain("Third parsed medicine");

  let importedCsv = "";
  await page.route("**/api/stock/receipts/ai-import", async (route) => {
    importedCsv = route.request().postData() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        receiptId: randomUUID(),
        importedCount: 3,
        productsAffected: 3,
        createdProducts: [],
      }),
    });
  });
  await page.getByRole("button", { name: "Import all" }).click();
  await expect(page.locator(".banner-success")).toContainText(
    "Received 3 lines across 3 products.",
  );
  expect(importedCsv).toContain("First parsed medicine");
  expect(importedCsv).toContain("Second parsed medicine");
  expect(importedCsv).toContain("Third parsed medicine");
});

test("owner sees specific AI receipt preparation activity while it loads", async ({
  page,
}) => {
  await signInAsOwner(page);
  const draftResponse = {
    csv: [
      "originaldescription,draftid,rearrangedname,quantity,unitcost,matchstatus,selectedproductid,conversionapproved",
      `${JSON.stringify("Example item")},${randomUUID()},${JSON.stringify("Example item")},1,10.00,NEW_PRODUCT,,FALSE`,
    ].join("\r\n"),
    filename: "receipt-review.csv",
    lineCount: 1,
  };
  await page.addInitScript((completePayload) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (!String(input).includes("/api/stock/receipts/ai-draft-stream"))
        return originalFetch(input, init);
      const encoder = new TextEncoder();
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              let step = 1;
              const send = () => {
                if (step <= 5) {
                  controller.enqueue(
                    encoder.encode(
                      `event: progress\ndata: ${JSON.stringify({ step })}\n\n`,
                    ),
                  );
                  step += 1;
                  window.setTimeout(send, 250);
                } else {
                  controller.enqueue(
                    encoder.encode(
                      `event: complete\ndata: ${JSON.stringify(completePayload)}\n\n`,
                    ),
                  );
                  controller.close();
                }
              };
              send();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          },
        ),
      );
    };
  }, draftResponse);
  await page.goto("/receipt-receiving");

  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
  });
  await page.getByRole("button", { name: "Extract receipt with AI" }).click();

  const progress = page.getByRole("status");
  const activeStep = progress.locator(".receipt-progress-active");
  await expect(activeStep).toContainText(
    "AI extracts supplier, reference, and receipt lines",
  );
  await expect(activeStep).toContainText(
    "AI normalizes quantities, package costs, lots, and expiry dates",
  );
  await expect(activeStep).toContainText(
    "AI formats product names from the receipt text",
  );
  await expect(activeStep).toContainText(
    "AI matches receipt lines against the product catalog",
  );
  await expect(activeStep).toContainText("Build an editable receipt draft");
  await expect(page.getByText("1 line items ready to edit")).toBeVisible();
});

test("owner can append a parsed image as a separate receipt group", async ({
  page,
}) => {
  await signInAsOwner(page);
  const makeDraft = (description: string, supplier: string) => ({
    csv: [
      "originaldescription,draftid,rearrangedname,quantity,unitcost,supplier,matchstatus,selectedproductid,conversionapproved",
      [
        description,
        randomUUID(),
        description,
        "1",
        "10.00",
        supplier,
        "NEW_PRODUCT",
        "",
        "FALSE",
      ]
        .map((value) => `"${value.replaceAll('"', '""')}"`)
        .join(","),
    ].join("\r\n"),
    filename: "receipt-review.csv",
    lineCount: 1,
  });
  await page.addInitScript(
    (drafts) => {
      const originalFetch = window.fetch.bind(window);
      let nextDraft = 0;
      window.fetch = (input, init) => {
        if (!String(input).includes("/api/stock/receipts/ai-draft-stream"))
          return originalFetch(input, init);
        const draft = drafts[nextDraft++];
        if (!draft) throw new Error("Unexpected receipt extraction request.");
        const body = [
          `event: progress\ndata: ${JSON.stringify({ step: 1 })}\n\n`,
          `event: complete\ndata: ${JSON.stringify(draft)}\n\n`,
        ].join("");
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          }),
        );
      };
    },
    [
      makeDraft("First page medicine", "Supplier One"),
      makeDraft("Second page medicine", "Supplier Two"),
    ],
  );
  await page.goto("/receipt-receiving");

  const receiptInput = page.locator('input[type="file"][accept*="image/png"]');
  await receiptInput.setInputFiles({
    name: "first-page.png",
    mimeType: "image/png",
    buffer: Buffer.from("first page"),
  });
  await page.getByRole("button", { name: "Extract receipt with AI" }).click();
  await expect(page.locator(".receipt-line-group-heading")).toHaveCount(1);

  await receiptInput.setInputFiles({
    name: "second-page.png",
    mimeType: "image/png",
    buffer: Buffer.from("second page"),
  });
  await page.getByRole("button", { name: "Extract and append pages" }).click();

  await expect(page.locator(".receipt-line-group-heading")).toHaveCount(2);
  await expect(page.getByText("2 line items ready to edit")).toBeVisible();
  await expect(page.getByText("First page medicine").first()).toBeVisible();
  await expect(page.getByText("Second page medicine").first()).toBeVisible();
  await expect(page.getByText(/Supplier: Supplier One/)).toBeVisible();
  await expect(page.getByText(/Supplier: Supplier Two/)).toBeVisible();
  await page.reload();
  await expect(page.locator(".receipt-line-group-heading")).toHaveCount(2);
  await expect(page.getByText("Second page medicine").first()).toBeVisible();
});

test("groups receipt rows by source PDF or image name", async ({ page }) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");

  const columns = [
    "originaldescription",
    "draftid",
    "sourcegroupid",
    "sourcefile",
    "rearrangedname",
    "quantity",
    "unitcost",
    "matchstatus",
    "selectedproductid",
    "conversionapproved",
  ];
  const rows = [
    ["First page line one", "group-one", "first-page.pdf"],
    ["Second page line", "group-three", "second-page.png"],
    ["First page line two", "group-two", "first-page.pdf"],
  ].map(([description, groupId, sourceFile]) => [
    description!,
    randomUUID(),
    groupId!,
    sourceFile!,
    description!,
    "1",
    "10.00",
    "NEW_PRODUCT",
    "",
    "FALSE",
  ]);
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    columns.map(cell).join(","),
    ...rows.map((row) => row.map(cell).join(",")),
  ].join("\r\n");

  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "receipt-review.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();

  const groups = page.locator(".receipt-line-group-heading");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText("first-page.pdf");
  await expect(groups.nth(0)).toContainText("2 line items");
  await expect(groups.nth(1)).toContainText("second-page.png");
  await expect(groups.nth(1)).toContainText("1 line item");

  const lineEditors = page.locator(".receipt-line-editor");
  await expect(lineEditors).toHaveCount(3);
  await expect(lineEditors.nth(0)).toContainText("First page line one");
  await expect(lineEditors.nth(1)).toContainText("First page line two");
  await expect(lineEditors.nth(2)).toContainText("Second page line");
});

test("owner can apply one supplier to every image group and restore group suppliers", async ({
  page,
}) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");
  const columns = [
    "originaldescription",
    "draftid",
    "sourcegroupid",
    "sourcefile",
    "sourcegroupsupplier",
    "rearrangedname",
    "quantity",
    "unitcost",
    "supplier",
    "matchstatus",
    "selectedproductid",
    "conversionapproved",
  ];
  const draftId = randomUUID();
  const rows = [
    [
      "First supplier line",
      draftId,
      "group-one",
      "first-page.png",
      "Supplier One",
      "First supplier line",
      "1",
      "10.00",
      "Supplier One",
      "NEW_PRODUCT",
      "",
      "FALSE",
    ],
    [
      "Second supplier line",
      draftId,
      "group-two",
      "second-page.png",
      "Supplier Two",
      "Second supplier line",
      "1",
      "12.00",
      "Supplier Two",
      "NEW_PRODUCT",
      "",
      "FALSE",
    ],
  ];
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    columns.map(cell).join(","),
    ...rows.map((row) => row.map(cell).join(",")),
  ].join("\r\n");
  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "grouped-receipts.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();

  const sharedSupplierToggle = page.getByLabel(
    "Use one supplier for all receipt pages",
  );
  await sharedSupplierToggle.check();
  const sharedSupplierField = page.getByLabel(
    "Supplier for all receipt pages",
    { exact: true },
  );
  await sharedSupplierField.fill("Unified Supplier");
  await expect(page.locator(".receipt-line-group-heading")).toHaveCount(2);
  await expect(
    page.locator(".receipt-line-group-heading").nth(0),
  ).toContainText("Unified Supplier");
  await expect(
    page.locator(".receipt-line-group-heading").nth(1),
  ).toContainText("Unified Supplier");

  await page.reload();
  await expect(sharedSupplierToggle).toBeChecked();
  await expect(sharedSupplierField).toHaveValue("Unified Supplier");
  await sharedSupplierToggle.uncheck();
  await expect(
    page.locator(".receipt-line-group-heading").nth(0),
  ).toContainText("Supplier One");
  await expect(
    page.locator(".receipt-line-group-heading").nth(1),
  ).toContainText("Supplier Two");
});

test("owner can process multiple receipt images one at a time", async ({
  page,
}) => {
  await signInAsOwner(page);
  const makeDraft = (description: string, supplier: string) => ({
    csv: [
      "originaldescription,draftid,rearrangedname,quantity,unitcost,supplier,matchstatus,selectedproductid,conversionapproved",
      [
        description,
        randomUUID(),
        description,
        "1",
        "10.00",
        supplier,
        "NEW_PRODUCT",
        "",
        "FALSE",
      ]
        .map((value) => `"${value.replaceAll('"', '""')}"`)
        .join(","),
    ].join("\r\n"),
    filename: "receipt-review.csv",
    lineCount: 1,
  });
  await page.addInitScript(
    (
      draftsByFilename: Record<
        string,
        { csv: string; filename: string; lineCount: number }
      >,
    ) => {
      const testWindow = window as typeof window & {
        __receiptUploadRequests: string[][];
        __receiptMaxConcurrent: number;
      };
      testWindow.__receiptUploadRequests = [];
      testWindow.__receiptMaxConcurrent = 0;
      let activeRequests = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (!String(input).includes("/api/stock/receipts/ai-draft-stream"))
          return originalFetch(input, init);
        const requestBody = JSON.parse(String(init?.body)) as {
          files: Array<{ name: string }>;
        };
        const filenames = requestBody.files.map((file) => file.name);
        testWindow.__receiptUploadRequests.push(filenames);
        const draft = draftsByFilename[filenames[0] ?? ""];
        if (!draft) throw new Error("Unexpected receipt extraction request.");
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                activeRequests += 1;
                testWindow.__receiptMaxConcurrent = Math.max(
                  testWindow.__receiptMaxConcurrent,
                  activeRequests,
                );
                const encoder = new TextEncoder();
                window.setTimeout(() => {
                  controller.enqueue(
                    encoder.encode(
                      `event: progress\ndata: ${JSON.stringify({ step: 1 })}\n\n`,
                    ),
                  );
                  controller.enqueue(
                    encoder.encode(
                      `event: complete\ndata: ${JSON.stringify(draft)}\n\n`,
                    ),
                  );
                  controller.close();
                  activeRequests -= 1;
                }, 250);
              },
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream; charset=utf-8" },
            },
          ),
        );
      };
    },
    {
      "first-page.png": makeDraft("First image item", "Supplier One"),
      "second-page.png": makeDraft("Second image item", "Supplier Two"),
      "third-page.png": makeDraft("Third image item", "Supplier Three"),
    },
  );
  await page.goto("/receipt-receiving");

  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles([
    {
      name: "first-page.png",
      mimeType: "image/png",
      buffer: Buffer.from("first image"),
    },
    {
      name: "second-page.png",
      mimeType: "image/png",
      buffer: Buffer.from("second image"),
    },
    {
      name: "third-page.png",
      mimeType: "image/png",
      buffer: Buffer.from("third image"),
    },
  ]);
  await page.getByRole("button", { name: "Extract receipt with AI" }).click();

  await expect(
    page.getByText("Reading file 1 of 3: first-page.png"),
  ).toBeVisible();
  await expect(
    page.getByText("Reading file 2 of 3: second-page.png"),
  ).toBeVisible();
  await expect(
    page.getByText("Reading file 3 of 3: third-page.png"),
  ).toBeVisible();
  await expect(page.getByText("3 line items ready to edit")).toBeVisible();
  await expect(page.locator(".receipt-line-group-heading")).toHaveCount(3);

  const requestLog = await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __receiptUploadRequests: string[][];
      __receiptMaxConcurrent: number;
    };
    return {
      requests: testWindow.__receiptUploadRequests,
      maxConcurrent: testWindow.__receiptMaxConcurrent,
    };
  });
  expect(requestLog.requests).toEqual([
    ["first-page.png"],
    ["second-page.png"],
    ["third-page.png"],
  ]);
  expect(requestLog.maxConcurrent).toBe(1);
});

test("owner gets an explanation when AI cannot extract a receipt", async ({
  page,
}) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");
  await page.route("**/api/stock/receipts/ai-draft-stream", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `event: progress\ndata: {"step":1}\n\nevent: error\ndata: {"error":"receipt_extraction_invalid"}\n\n`,
    });
  });

  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgo=", "base64"),
  });
  await page.getByRole("button", { name: "Extract receipt with AI" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Receipt reading failed: AI could not return supplier and item details in the expected format.",
  );
});

test("owner can edit a receipt CSV in the app before receiving stock", async ({
  page,
}) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");

  const columns = [
    "originaldescription",
    "draftid",
    "rearrangedname",
    "sourcequantity",
    "sourceunitcost",
    "sourcelinetotal",
    "sourcelot",
    "sourceexpiry",
    "quantity",
    "unitcost",
    "lotcode",
    "expirydate",
    "supplier",
    "reference",
    "matchstatus",
    "suggestedproductid",
    "suggestedproductname",
    "suggestedproductsku",
    "selectedproductid",
    "sku",
    "unit",
    "sellingprice",
    "taxclass",
    "producttype",
    "issceligible",
    "ispwdeligible",
    "bnpceligible",
    "bnpccategory",
    "trackslots",
    "conversionrecommended",
    "unitsperpackage",
    "conversionconfidence",
    "conversionreason",
    "conversionapproved",
    "zerocostreason",
  ];
  const row: Record<string, string> = {
    originaldescription: "E2E example item 500mg tablet",
    draftid: randomUUID(),
    rearrangedname: "AI suggested item name",
    sourcequantity: "2",
    sourceunitcost: "12.00",
    sourcelinetotal: "24.00",
    sourcelot: "",
    sourceexpiry: "",
    quantity: "2",
    unitcost: "12.00",
    lotcode: "",
    expirydate: "",
    supplier: "Test supplier",
    reference: "E2E receipt",
    matchstatus: "NEW_PRODUCT",
    suggestedproductid: "",
    suggestedproductname: "",
    suggestedproductsku: "",
    selectedproductid: "",
    sku: "",
    unit: "",
    sellingprice: "",
    taxclass: "",
    producttype: "",
    issceligible: "FALSE",
    ispwdeligible: "FALSE",
    bnpceligible: "FALSE",
    bnpccategory: "",
    trackslots: "FALSE",
    conversionrecommended: "FALSE",
    unitsperpackage: "",
    conversionconfidence: "LOW",
    conversionreason: "",
    conversionapproved: "FALSE",
    zerocostreason: "",
  };
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    columns.map(cell).join(","),
    columns.map((column) => cell(row[column] ?? "")).join(","),
  ].join("\r\n");

  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "receipt-review.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();
  await page.getByLabel("Product name").fill("Edited in app product");
  await page.getByLabel("New product SKU (optional)").fill("E2E-RECEIPT-EDIT");
  await page
    .getByRole("textbox", { name: "Sellable unit", exact: true })
    .fill("tablet");
  await page.getByLabel("Selling price").fill("25.00");
  await page.getByLabel("Tax class").selectOption("VATABLE");
  await page.getByLabel("Product type").selectOption("GENERIC");

  await page.getByRole("button", { name: "Validate receipt" }).click();
  await expect(page.getByText("Ready for confirmation")).toBeVisible();
  await page.getByRole("button", { name: "Import all" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Received 1 lines across 1 products",
  );
  await expect(page.getByRole("status")).toContainText("E2E-RECEIPT-EDIT");
});

test("owner preselects high-confidence lines and keeps unselected rows as a new draft", async ({
  page,
}) => {
  await signInAsOwner(page);
  const originalDraftId = randomUUID();
  let importedCsv = "";
  await page.route("**/api/stock/receipts/ai-review", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        valid: true,
        lineCount: 2,
        newProducts: 2,
        existingProducts: 0,
        conversions: 0,
        lines: [
          {
            row: 2,
            name: "Selected product",
            quantity: 1,
            unitCost: "3.00",
            unitCostRounded: false,
            lineTotal: "3.00",
            conversionFactor: null,
          },
          {
            row: 3,
            name: "Remaining product",
            quantity: 2,
            unitCost: "5.00",
            unitCostRounded: false,
            lineTotal: "10.00",
            conversionFactor: null,
          },
        ],
      }),
    });
  });
  await page.route("**/api/stock/receipts/ai-import", async (route) => {
    importedCsv = route.request().postData() ?? "";
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        receiptId: randomUUID(),
        importedCount: 1,
        productsAffected: 1,
        createdProducts: [],
      }),
    });
  });
  await page.goto("/receipt-receiving");

  const columns = [
    "originaldescription",
    "draftid",
    "rearrangedname",
    "quantity",
    "unitcost",
    "matchstatus",
    "selectedproductid",
    "conversionrecommended",
    "unitsperpackage",
    "conversionconfidence",
    "conversionapproved",
  ];
  const rows = [
    [
      "Selected product",
      originalDraftId,
      "Selected product",
      "1",
      "3.00",
      "NEW_PRODUCT",
      "",
      "TRUE",
      "20",
      "HIGH",
      "FALSE",
    ],
    [
      "Remaining product",
      originalDraftId,
      "Remaining product",
      "2",
      "5.00",
      "NEW_PRODUCT",
      "",
      "TRUE",
      "20",
      "LOW",
      "FALSE",
    ],
  ];
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    columns.map(cell).join(","),
    ...rows.map((row) => row.map(cell).join(",")),
  ].join("\r\n");

  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "selected-lines.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();
  await page.getByRole("button", { name: "Validate receipt" }).click();
  await expect(page.getByText("Ready for confirmation")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import selected (1)" }),
  ).toBeEnabled();

  await expect(
    page.getByRole("checkbox", { name: "Select line 2: Selected product" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select line 3: Remaining product" }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Import selected (1)" }).click();

  await expect(page.getByRole("status")).toContainText(
    "1 unselected lines remain in the editor as a new draft",
  );
  await expect(page.locator(".receipt-prepared-file")).toContainText(
    "1 line items ready to edit",
  );
  expect(importedCsv).toContain("Selected product");
  expect(importedCsv).not.toContain("Remaining product");

  const savedDraft = await page.evaluate(() => {
    const value = window.localStorage.getItem("medtryx-receipt-draft-v1");
    return value
      ? (JSON.parse(value) as {
          rows: Array<{ originaldescription: string; draftid: string }>;
        })
      : null;
  });
  expect(savedDraft?.rows).toHaveLength(1);
  expect(savedDraft?.rows[0]?.originaldescription).toBe("Remaining product");
  expect(savedDraft?.rows[0]?.draftid).not.toBe(originalDraftId);
});

test("shows converted unit cost for high- and medium-confidence suggestions", async ({
  page,
}) => {
  await signInAsOwner(page);
  await page.goto("/receipt-receiving");

  const columns = [
    "originaldescription",
    "draftid",
    "rearrangedname",
    "quantity",
    "unitcost",
    "matchstatus",
    "selectedproductid",
    "conversionrecommended",
    "unitsperpackage",
    "conversionconfidence",
    "conversionapproved",
  ];
  const rows = [
    [
      "High-confidence medicine",
      randomUUID(),
      "High-confidence medicine",
      "2",
      "100.00",
      "NEW_PRODUCT",
      "",
      "TRUE",
      "20",
      "HIGH",
      "FALSE",
    ],
    [
      "Medium-confidence medicine",
      randomUUID(),
      "Medium-confidence medicine",
      "3",
      "90.00",
      "NEW_PRODUCT",
      "",
      "TRUE",
      "10",
      "MEDIUM",
      "FALSE",
    ],
    [
      "Low-confidence medicine",
      randomUUID(),
      "Low-confidence medicine",
      "3",
      "90.00",
      "NEW_PRODUCT",
      "",
      "TRUE",
      "10",
      "LOW",
      "FALSE",
    ],
  ];
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    columns.map(cell).join(","),
    ...rows.map((row) => row.map(cell).join(",")),
  ].join("\r\n");

  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "receipt-review.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();

  const preview = page.locator(".receipt-conversion-preview");
  await expect(preview).toHaveCount(2);
  await expect(preview.nth(0)).toContainText("5.00 per sellable unit");
  await expect(preview.nth(0)).toContainText("100.00 per package");
  await expect(preview.nth(0)).toContainText("40 sellable units");
  await expect(preview.nth(1)).toContainText("9.00 per sellable unit");
  await expect(preview.nth(1)).toContainText("90.00 per package");
  await expect(preview.nth(1)).toContainText("30 sellable units");
});

test("owner can search and select an existing catalog product in the editor", async ({
  page,
}) => {
  await signInAsOwner(page);
  const csrfResponse = await page.request.get("/api/auth/csrf");
  const csrf = (await csrfResponse.json()) as { token: string };
  const sku = `E2E-RECEIPT-${randomUUID().slice(0, 8)}`;
  const createdProduct = await page.request.post("/api/products", {
    headers: { "x-csrf-token": csrf.token },
    data: {
      sku,
      name: "E2E Catalog Medicine",
      unit: "tablet",
      sellingPrice: "25.00",
      taxClass: "VATABLE",
      productType: "GENERIC",
      isScEligible: false,
      isPwdEligible: false,
      tracksLots: false,
      openingQuantity: 0,
    },
  });
  expect(createdProduct.status()).toBe(201);
  await page.goto("/receipt-receiving");

  const columns = [
    "originaldescription",
    "draftid",
    "rearrangedname",
    "quantity",
    "unitcost",
    "matchstatus",
    "selectedproductid",
    "conversionapproved",
  ];
  const row: Record<string, string> = {
    originaldescription: "E2E Catalog Medicine",
    draftid: randomUUID(),
    rearrangedname: "E2E Catalog Medicine",
    quantity: "3",
    unitcost: "10.00",
    matchstatus: "POSSIBLE_MATCH",
    selectedproductid: "",
    conversionapproved: "FALSE",
  };
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    columns.map(cell).join(","),
    columns.map((column) => cell(row[column] ?? "")).join(","),
  ].join("\r\n");
  await page
    .locator('input[type="file"][accept="text/csv,.csv"]')
    .setInputFiles({
      name: "receipt-review.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page
    .getByRole("button", { name: "Load receipt CSV into editor" })
    .click();
  await page.getByRole("button", { name: "Choose product" }).click();
  await page
    .getByRole("button", {
      name: new RegExp(`E2E Catalog Medicine.*${sku}`, "i"),
    })
    .click();

  await page.getByRole("button", { name: "Validate receipt" }).click();
  await expect(page.getByText("Ready for confirmation")).toBeVisible();
  await page.getByRole("button", { name: "Import all" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Received 1 lines across 1 products",
  );
});
