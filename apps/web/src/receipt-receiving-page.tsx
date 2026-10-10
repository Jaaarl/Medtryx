import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  ArrowDownToLine,
  Check,
  FileUp,
  LoaderCircle,
  RotateCcw,
  Upload,
} from "lucide-react";
import { ApiError, api } from "./api";
import { parseReceiptCsv, serializeReceiptCsv } from "./receipt-csv";
import type { ReceiptCsvRow } from "./receipt-csv";

type PreparedReceipt = { lineCount: number; filename: string };
type AiDraftResponse = PreparedReceipt & { csv: string };
type ReviewLine = {
  row: number;
  name: string;
  quantity: number;
  unitCost: string;
  unitCostRounded: boolean;
  lineTotal: string;
  conversionFactor: number | null;
};
type ReviewResult = {
  valid: true;
  lineCount: number;
  newProducts: number;
  existingProducts: number;
  conversions: number;
  lines: ReviewLine[];
};
type ImportResult = {
  receiptId: string;
  importedCount: number;
  productsAffected: number;
  createdProducts: Array<{ id: string; sku: string; name: string }>;
};
type RowIssue = { row: number; message: string };
type ReceiptTask = "prepare" | "review" | "import";
type ProductOption = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  tracksLots: boolean;
};

const receiptProgressSteps: Record<ReceiptTask, string[]> = {
  prepare: [
    "Prepare selected pages for upload",
    "AI extracts and transforms receipt details, then matches products",
    "Build an editable receipt draft",
  ],
  review: [
    "Send the edited receipt for validation",
    "Check products, quantities, conversions, lots, and expiry dates",
    "Prepare the receipt preview",
  ],
  import: [
    "Receipt passed review",
    "Recheck the CSV and record stock and lot movements",
    "Save receipt history and show the result",
  ],
};

const receiptPreparationDetails = [
  "Extract supplier, reference, item descriptions, quantities, costs, lot codes, and expiry dates",
  "Normalize package quantities and unit costs; format clear expiry dates",
  "Reorder medicine names and match each line against the product catalog",
];

function ReceiptProgressChecklist({
  task,
  activeStep,
}: {
  task: ReceiptTask;
  activeStep: number;
}) {
  return (
    <div
      className="receipt-progress"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <strong>What’s happening now</strong>
      <ul>
        {receiptProgressSteps[task].map((label, index) => {
          const state =
            index < activeStep
              ? "complete"
              : index === activeStep
                ? "active"
                : "pending";
          return (
            <li
              className={`receipt-progress-item receipt-progress-${state}`}
              key={label}
            >
              <span className="receipt-progress-marker" aria-hidden="true">
                {state === "complete" ? (
                  <Check size={13} />
                ) : state === "active" ? (
                  <LoaderCircle className="receipt-spinner" size={13} />
                ) : (
                  index + 1
                )}
              </span>
              <span>{label}</span>
              {state === "active" && (
                <span className="receipt-progress-current">In progress</span>
              )}
              {task === "prepare" && state === "active" && (
                <ul className="receipt-progress-details">
                  {receiptPreparationDetails.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <small>Keep this page open while processing finishes.</small>
    </div>
  );
}

const MAX_UPLOAD_BYTES = 18 * 1024 * 1024;

function fileMimeType(file: File): string {
  if (
    ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(
      file.type,
    )
  )
    return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "";
}

async function base64File(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return btoa(chunks.join(""));
}

function downloadCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function ReceiptField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  step,
  min,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "date";
  placeholder?: string;
  step?: string;
  min?: string;
}) {
  return (
    <label className="receipt-edit-field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        step={step}
        min={min}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function ReceiptSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="receipt-edit-field">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReceiptCheck({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="receipt-edit-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function errorText(error: unknown): string {
  if (!(error instanceof ApiError))
    return "The receipt could not be processed. Please try again.";
  const messages: Record<string, string> = {
    mixroute_api_key_not_configured:
      "Add MIXROUTE_API_KEY to the local .env file, then restart the app.",
    mixroute_unavailable:
      "MixRoute could not be reached. Check the local network connection and try again.",
    mixroute_request_failed:
      "MixRoute rejected a model request. Check the API key, account credits, and model access.",
    mixroute_response_invalid:
      "The AI returned an incomplete response. Try again, or split the receipt into fewer pages.",
    receipt_extraction_invalid:
      "Receipt reading failed: AI could not return supplier and item details in the expected format. Check scan clarity or try one page at a time.",
    receipt_normalization_invalid:
      "Receipt details were read, but AI could not normalize every line's quantity, cost, lot, and expiry fields. Try a clearer scan or fewer pages.",
    receipt_product_names_invalid:
      "Receipt lines were extracted, but AI could not format a product name for every line. Try again or split the receipt.",
    receipt_catalog_matching_invalid:
      "Receipt lines were extracted, but AI could not complete product matching for every line. Try again or split the receipt.",
    receipt_file_invalid: "Use a valid PDF, JPEG, PNG, or WebP receipt file.",
    receipt_upload_too_large: "Keep the combined upload under 18 MB.",
    too_many_receipt_lines:
      "This receipt has too many line items for one review file. Split it into smaller receipts.",
    receipt_upload_invalid: "Choose up to 20 PDF or image files.",
    receipt_review_invalid:
      "Some receipt fields need attention. Review the line messages below.",
    duplicate_new_product_definition:
      "Rows for the same new product have different POS details. Make their product fields match, or use separate SKUs.",
    receipt_already_imported:
      "This receipt was already imported. No stock was added again.",
    request_too_large: "The uploaded file is too large.",
  };
  return (
    messages[error.code] ??
    "The request could not be completed. Review the file and try again."
  );
}

function rowIssues(error: unknown): RowIssue[] {
  if (!(error instanceof ApiError)) return [];
  const issues = error.responseBody?.rowErrors;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is RowIssue =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as RowIssue).row === "number" &&
      typeof (issue as RowIssue).message === "string",
  );
}

export function ReceiptReceivingPage() {
  const receiptInput = useRef<HTMLInputElement>(null);
  const reviewInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [prepared, setPrepared] = useState<PreparedReceipt | null>(null);
  const [draftHeaders, setDraftHeaders] = useState<string[]>([]);
  const [draftRows, setDraftRows] = useState<ReceiptCsvRow[]>([]);
  const [reviewCsv, setReviewCsv] = useState("");
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [issues, setIssues] = useState<RowIssue[]>([]);
  const [error, setError] = useState("");
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<"prepare" | "review" | "import" | null>(
    null,
  );
  const [progressStep, setProgressStep] = useState(0);
  const [productChooserRow, setProductChooserRow] = useState<number | null>(
    null,
  );
  const [productSearch, setProductSearch] = useState("");
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [searchingProducts, setSearchingProducts] = useState(false);
  const [productSearchError, setProductSearchError] = useState("");

  useEffect(() => {
    if (productChooserRow === null) return;
    const query = productSearch.trim();
    if (query.length < 2) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchingProducts(true);
      setProductSearchError("");
      api
        .get<{ products: ProductOption[] }>(
          `/catalog?q=${encodeURIComponent(query)}`,
        )
        .then((response) => {
          if (!cancelled) setProductOptions(response.products);
        })
        .catch(() => {
          if (!cancelled) {
            setProductOptions([]);
            setProductSearchError("Unable to search the product catalog.");
          }
        })
        .finally(() => {
          if (!cancelled) setSearchingProducts(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [productChooserRow, productSearch]);

  function clearReviewState() {
    setReview(null);
    setReviewCsv("");
    setIssues([]);
    setError("");
  }

  function updateRow(index: number, changes: Record<string, string>) {
    setDraftRows((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...changes } : row,
      ),
    );
    clearReviewState();
  }

  function openProductChooser(index: number) {
    const row = draftRows[index];
    setProductChooserRow(index);
    setProductSearch(
      row?.suggestedproductsku ||
        row?.suggestedproductname ||
        row?.rearrangedname ||
        "",
    );
    setProductOptions([]);
    setProductSearchError("");
    setSearchingProducts(false);
  }

  function closeProductChooser() {
    setProductChooserRow(null);
    setProductOptions([]);
    setSearchingProducts(false);
  }

  function changeProductSearch(value: string) {
    setProductSearch(value);
    setProductOptions([]);
    setProductSearchError("");
    setSearchingProducts(false);
    if (value.trim().length < 2) {
      return;
    }
  }

  function chooseProduct(index: number, product: ProductOption) {
    updateRow(index, {
      matchstatus: "EXACT_MATCH",
      selectedproductid: product.id,
      rearrangedname: product.name,
      sku: product.sku,
      unit: product.unit,
      trackslots: product.tracksLots ? "TRUE" : "FALSE",
    });
    closeProductChooser();
  }

  function loadCsvIntoEditor(csv: string, filename: string) {
    const document = parseReceiptCsv(csv);
    setDraftHeaders(document.headers);
    setDraftRows(document.rows);
    setPrepared({ lineCount: document.rows.length, filename });
    setReview(null);
    setReviewCsv("");
    setIssues([]);
    setImported(null);
    setError("");
  }

  function chooseReceiptFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.currentTarget.files ?? []);
    const bytes = chosen.reduce((total, file) => total + file.size, 0);
    const supported = chosen.every((file) =>
      ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(
        fileMimeType(file),
      ),
    );
    setPrepared(null);
    setDraftHeaders([]);
    setDraftRows([]);
    setReview(null);
    setReviewCsv("");
    setImported(null);
    setIssues([]);
    if (chosen.length > 20) {
      setFiles([]);
      setError("Choose no more than 20 files at a time.");
    } else if (!supported) {
      setFiles([]);
      setError("Use PDF, JPEG, PNG, or WebP files.");
    } else if (bytes > MAX_UPLOAD_BYTES) {
      setFiles([]);
      setError("Keep the combined upload under 18 MB.");
    } else {
      setFiles(chosen);
      setError("");
    }
  }

  async function prepareReceipt() {
    if (!files.length || busy) return;
    setBusy("prepare");
    setProgressStep(0);
    setError("");
    setIssues([]);
    try {
      const uploadFiles = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mimeType: fileMimeType(file),
          dataBase64: await base64File(file),
        })),
      );
      setProgressStep(1);
      const response = await api.post<AiDraftResponse>(
        "/stock/receipts/ai-draft",
        { files: uploadFiles },
      );
      setProgressStep(2);
      loadCsvIntoEditor(response.csv, response.filename);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusy(null);
      setProgressStep(0);
    }
  }

  async function loadEditedCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const csv = await file.text();
      loadCsvIntoEditor(csv, file.name);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : errorText(requestError),
      );
    }
  }

  async function validateDraft() {
    if (!draftHeaders.length || !draftRows.length || busy) return;
    const csv = serializeReceiptCsv(draftHeaders, draftRows);
    setBusy("review");
    setProgressStep(0);
    setError("");
    setIssues([]);
    try {
      setProgressStep(1);
      const response = await api.postCsv<ReviewResult>(
        "/stock/receipts/ai-review",
        csv,
      );
      setProgressStep(2);
      setReviewCsv(csv);
      setReview(response);
    } catch (requestError) {
      setError(errorText(requestError));
      setIssues(rowIssues(requestError));
    } finally {
      setBusy(null);
      setProgressStep(0);
    }
  }

  function addReceiptLine() {
    const firstRow = draftRows[0];
    if (!firstRow) return;
    const newRow = {
      ...Object.fromEntries(draftHeaders.map((header) => [header, ""])),
      draftid: firstRow.draftid,
      supplier: firstRow.supplier,
      reference: firstRow.reference,
      matchstatus: "NEW_PRODUCT",
      selectedproductid: "",
      quantity: "1",
      unitcost: "",
      conversionapproved: "FALSE",
      conversionrecommended: "FALSE",
      conversionconfidence: "LOW",
      issceligible: "FALSE",
      ispwdeligible: "FALSE",
      bnpceligible: "FALSE",
      trackslots: "FALSE",
    } as ReceiptCsvRow;
    setDraftRows((rows) => [...rows, newRow]);
    clearReviewState();
  }

  function removeReceiptLine(index: number) {
    setDraftRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
    setProductChooserRow(null);
    clearReviewState();
  }

  function downloadCurrentCsv() {
    if (!prepared || !draftHeaders.length) return;
    downloadCsv(
      serializeReceiptCsv(draftHeaders, draftRows),
      prepared.filename,
    );
  }

  async function importReviewedCsv() {
    if (!review || !reviewCsv || busy) return;
    setBusy("import");
    setProgressStep(1);
    setError("");
    setIssues([]);
    try {
      const result = await api.postCsv<ImportResult>(
        "/stock/receipts/ai-import",
        reviewCsv,
      );
      setImported(result);
      setReview(null);
      setReviewCsv("");
      setPrepared(null);
      setDraftHeaders([]);
      setDraftRows([]);
      setProgressStep(2);
    } catch (requestError) {
      setError(errorText(requestError));
      setIssues(rowIssues(requestError));
    } finally {
      setBusy(null);
      setProgressStep(0);
    }
  }

  function startOver() {
    setFiles([]);
    setPrepared(null);
    setDraftHeaders([]);
    setDraftRows([]);
    setReview(null);
    setReviewCsv("");
    setIssues([]);
    setError("");
    setImported(null);
    setProductChooserRow(null);
    setProductSearch("");
    setProductOptions([]);
    if (receiptInput.current) receiptInput.current.value = "";
    if (reviewInput.current) reviewInput.current.value = "";
  }

  return (
    <section className="page-section inventory-page receipt-receiving-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            <span /> INVENTORY WORKFLOW
          </span>
          <h1>Receipt receiving</h1>
          <p>
            Extract a supplier receipt, edit and confirm the draft, then record
            stock and lot movements.
          </p>
        </div>
        {(prepared || imported) && (
          <button
            className="button button-secondary"
            type="button"
            onClick={startOver}
          >
            <RotateCcw size={15} /> Start another receipt
          </button>
        )}
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {issues.length > 0 && (
        <div className="receipt-issues" role="alert">
          <strong>Fix these receipt lines, then validate again.</strong>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.row}-${index}`}>
                Line {Math.max(1, issue.row - 1)}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {imported && (
        <div className="banner banner-success" role="status">
          Received {imported.importedCount} lines across{" "}
          {imported.productsAffected} products. Receipt ID: {imported.receiptId}
          {imported.createdProducts.length > 0 && (
            <>
              {" "}
              New product SKUs:{" "}
              {imported.createdProducts
                .map((product) => product.sku)
                .join(", ")}
              .
            </>
          )}
        </div>
      )}

      <div className="receipt-steps">
        <section
          className={`settings-main-card receipt-step ${prepared ? "receipt-step-complete" : ""}`}
        >
          <div className="receipt-step-number">1</div>
          <div className="receipt-step-content">
            <div className="card-heading receipt-card-heading">
              <div>
                <h2>Upload receipt pages</h2>
                <p>
                  Choose receipt images or PDFs. Files are sent to MixRoute for
                  extraction and are not stored by this workflow.
                </p>
              </div>
              {prepared && <Check size={18} aria-label="Complete" />}
            </div>
            <input
              ref={receiptInput}
              className="receipt-file-input"
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp"
              multiple
              onChange={chooseReceiptFiles}
            />
            <div className="receipt-upload-row">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => receiptInput.current?.click()}
                disabled={busy !== null}
              >
                <FileUp size={16} /> Choose PDF or image pages
              </button>
              <span className="receipt-file-count">
                {files.length
                  ? `${files.length} file${files.length === 1 ? "" : "s"} · ${(files.reduce((sum, file) => sum + file.size, 0) / (1024 * 1024)).toFixed(1)} MB`
                  : "Up to 20 files, 18 MB combined"}
              </span>
            </div>
            {files.length > 0 && (
              <ul className="receipt-file-list">
                {files.map((file) => (
                  <li key={`${file.name}-${file.size}`}>{file.name}</li>
                ))}
              </ul>
            )}
            <button
              className="button button-primary receipt-action"
              type="button"
              onClick={() => void prepareReceipt()}
              disabled={!files.length || busy !== null}
            >
              {busy === "prepare" ? (
                <LoaderCircle className="receipt-spinner" size={16} />
              ) : (
                <Upload size={16} />
              )}
              {busy === "prepare"
                ? "Reading receipt…"
                : "Extract receipt with AI"}
            </button>
            {busy === "prepare" && (
              <ReceiptProgressChecklist
                task="prepare"
                activeStep={progressStep}
              />
            )}
          </div>
        </section>

        <section
          className={`settings-main-card receipt-step ${draftRows.length ? "receipt-step-complete" : ""}`}
        >
          <div className="receipt-step-number">2</div>
          <div className="receipt-step-content">
            <div className="card-heading receipt-card-heading">
              <div>
                <h2>Review and edit receipt</h2>
                <p>
                  Correct the AI draft here. Nothing changes inventory until you
                  validate the receipt and confirm it.
                </p>
              </div>
              {review && <Check size={18} aria-label="Complete" />}
            </div>
            {prepared ? (
              <div className="receipt-prepared-file">
                <span>
                  <strong>{draftRows.length}</strong> line items ready to edit
                </span>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={downloadCurrentCsv}
                >
                  <ArrowDownToLine size={15} /> Download current CSV
                </button>
              </div>
            ) : (
              <p className="receipt-step-hint">
                You can also load a receipt CSV from a previous session and
                continue editing it here.
              </p>
            )}
            <input
              ref={reviewInput}
              className="receipt-file-input"
              type="file"
              accept="text/csv,.csv"
              onChange={(event) => void loadEditedCsv(event)}
            />
            <button
              className="button button-secondary receipt-action"
              type="button"
              onClick={() => reviewInput.current?.click()}
              disabled={busy !== null}
            >
              <FileUp size={16} />
              {busy === "review"
                ? "Validating CSV…"
                : "Load receipt CSV into editor"}
            </button>
            {prepared && draftRows.length > 0 && (
              <>
                <div className="receipt-editor-heading">
                  <div>
                    <strong>Edit each receipt line</strong>
                    <small>
                      Source text is kept for reference. Update the fields that
                      will be used to receive stock.
                    </small>
                  </div>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={addReceiptLine}
                    disabled={busy !== null || draftRows.length >= 500}
                  >
                    Add missing line
                  </button>
                </div>
                <fieldset
                  className="receipt-editor-fieldset"
                  disabled={busy !== null}
                >
                  <div className="receipt-line-list">
                    {draftRows.map((row, index) => {
                      const isNewProduct = row.matchstatus === "NEW_PRODUCT";
                      const conversionRecommended =
                        row.conversionrecommended?.toUpperCase() === "TRUE";
                      const zeroCost =
                        row.unitcost.trim() !== "" &&
                        Number(row.unitcost) === 0;
                      return (
                        <article
                          className="receipt-line-editor"
                          key={`${row.draftid}-${index}`}
                        >
                          <div className="receipt-line-heading">
                            <div>
                              <strong>Line {index + 1}</strong>
                              {conversionRecommended && (
                                <span className="receipt-ai-badge">
                                  AI suggests package conversion
                                </span>
                              )}
                            </div>
                            <button
                              className="receipt-remove-line"
                              type="button"
                              onClick={() => removeReceiptLine(index)}
                              disabled={busy !== null || draftRows.length <= 1}
                              aria-label={`Remove line ${index + 1}`}
                            >
                              Remove
                            </button>
                          </div>

                          <div className="receipt-source-description">
                            <span>Original receipt text</span>
                            <p>
                              {row.originaldescription ||
                                "Enter the source item text below."}
                            </p>
                            {!row.originaldescription && (
                              <ReceiptField
                                label="Source item description"
                                value={row.originaldescription}
                                onChange={(value) =>
                                  updateRow(index, {
                                    originaldescription: value,
                                  })
                                }
                              />
                            )}
                            {(row.sourcequantity ||
                              row.sourceunitcost ||
                              row.sourcelot ||
                              row.sourceexpiry) && (
                              <small className="receipt-source-values">
                                AI read:{" "}
                                {row.sourcequantity || "quantity unclear"}
                                {row.sourceunitcost
                                  ? ` at ${row.sourceunitcost} per package`
                                  : ""}
                                {row.sourcelot ? ` · lot ${row.sourcelot}` : ""}
                                {row.sourceexpiry
                                  ? ` · expiry ${row.sourceexpiry}`
                                  : ""}
                              </small>
                            )}
                          </div>

                          <div className="receipt-edit-grid">
                            <ReceiptField
                              label="Product name"
                              value={row.rearrangedname}
                              onChange={(value) =>
                                updateRow(index, { rearrangedname: value })
                              }
                            />
                            <ReceiptField
                              label="Receipt quantity / packages"
                              type="number"
                              min="1"
                              step="1"
                              value={row.quantity}
                              onChange={(value) =>
                                updateRow(index, { quantity: value })
                              }
                            />
                            <ReceiptField
                              label="Unit cost (as purchased)"
                              type="number"
                              min="0"
                              step="0.01"
                              value={row.unitcost}
                              onChange={(value) =>
                                updateRow(index, { unitcost: value })
                              }
                            />
                            <ReceiptField
                              label="Lot code"
                              value={row.lotcode}
                              onChange={(value) =>
                                updateRow(index, { lotcode: value })
                              }
                            />
                            <ReceiptField
                              label="Expiry date"
                              type={
                                !row.expirydate ||
                                /^\d{4}-\d{2}-\d{2}$/u.test(row.expirydate)
                                  ? "date"
                                  : "text"
                              }
                              placeholder="YYYY-MM-DD"
                              value={row.expirydate}
                              onChange={(value) =>
                                updateRow(index, { expirydate: value })
                              }
                            />
                            <ReceiptField
                              label="Supplier"
                              value={row.supplier}
                              onChange={(value) =>
                                updateRow(index, { supplier: value })
                              }
                            />
                            <ReceiptField
                              label="Reference"
                              value={row.reference}
                              onChange={(value) =>
                                updateRow(index, { reference: value })
                              }
                            />
                          </div>

                          <div className="receipt-product-section">
                            <ReceiptSelect
                              label="Product handling"
                              value={
                                isNewProduct
                                  ? "NEW_PRODUCT"
                                  : "EXISTING_PRODUCT"
                              }
                              onChange={(value) => {
                                if (value === "NEW_PRODUCT") {
                                  updateRow(index, {
                                    matchstatus: "NEW_PRODUCT",
                                    selectedproductid: "",
                                    sku: "",
                                    unit: "",
                                    sellingprice: "",
                                    taxclass: "",
                                    producttype: "",
                                    trackslots: "FALSE",
                                  });
                                } else {
                                  updateRow(index, {
                                    matchstatus: "EXACT_MATCH",
                                    selectedproductid: "",
                                  });
                                }
                              }}
                              options={[
                                {
                                  value: "EXISTING_PRODUCT",
                                  label: "Use an existing product",
                                },
                                {
                                  value: "NEW_PRODUCT",
                                  label: "Create a new product",
                                },
                              ]}
                            />

                            {isNewProduct ? (
                              <div className="receipt-product-setup">
                                <div className="receipt-edit-grid">
                                  <ReceiptField
                                    label="New product SKU (optional)"
                                    value={row.sku}
                                    onChange={(value) =>
                                      updateRow(index, { sku: value })
                                    }
                                  />
                                  <ReceiptField
                                    label="Sellable unit"
                                    value={row.unit}
                                    placeholder="e.g. tablet, bottle"
                                    onChange={(value) =>
                                      updateRow(index, { unit: value })
                                    }
                                  />
                                  <ReceiptField
                                    label="Selling price"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={row.sellingprice}
                                    onChange={(value) =>
                                      updateRow(index, { sellingprice: value })
                                    }
                                  />
                                  <ReceiptSelect
                                    label="Tax class"
                                    value={row.taxclass.toUpperCase()}
                                    onChange={(value) =>
                                      updateRow(index, { taxclass: value })
                                    }
                                    options={[
                                      { value: "", label: "Choose tax class" },
                                      { value: "VATABLE", label: "Vatable" },
                                      {
                                        value: "VAT_EXEMPT",
                                        label: "VAT exempt",
                                      },
                                      {
                                        value: "ZERO_RATED",
                                        label: "Zero rated",
                                      },
                                    ]}
                                  />
                                  <ReceiptSelect
                                    label="Product type"
                                    value={row.producttype.toUpperCase()}
                                    onChange={(value) =>
                                      updateRow(index, { producttype: value })
                                    }
                                    options={[
                                      {
                                        value: "",
                                        label: "Choose product type",
                                      },
                                      { value: "GENERIC", label: "Generic" },
                                      { value: "BRANDED", label: "Branded" },
                                      {
                                        value: "NOT_APPLICABLE",
                                        label: "Not applicable",
                                      },
                                    ]}
                                  />
                                </div>
                                <div className="receipt-edit-check-row">
                                  <ReceiptCheck
                                    label="Track lot and expiry"
                                    checked={
                                      row.trackslots.toUpperCase() === "TRUE"
                                    }
                                    onChange={(checked) =>
                                      updateRow(index, {
                                        trackslots: checked ? "TRUE" : "FALSE",
                                      })
                                    }
                                  />
                                  <ReceiptCheck
                                    label="Senior citizen eligible"
                                    checked={
                                      row.issceligible.toUpperCase() === "TRUE"
                                    }
                                    onChange={(checked) =>
                                      updateRow(index, {
                                        issceligible: checked
                                          ? "TRUE"
                                          : "FALSE",
                                      })
                                    }
                                  />
                                  <ReceiptCheck
                                    label="PWD eligible"
                                    checked={
                                      row.ispwdeligible.toUpperCase() === "TRUE"
                                    }
                                    onChange={(checked) =>
                                      updateRow(index, {
                                        ispwdeligible: checked
                                          ? "TRUE"
                                          : "FALSE",
                                      })
                                    }
                                  />
                                  <ReceiptCheck
                                    label="BNPC eligible"
                                    checked={
                                      row.bnpceligible.toUpperCase() === "TRUE"
                                    }
                                    onChange={(checked) =>
                                      updateRow(index, {
                                        bnpceligible: checked
                                          ? "TRUE"
                                          : "FALSE",
                                        ...(checked
                                          ? {}
                                          : { bnpccategory: "" }),
                                      })
                                    }
                                  />
                                </div>
                                {row.bnpceligible.toUpperCase() === "TRUE" && (
                                  <ReceiptSelect
                                    label="BNPC category"
                                    value={row.bnpccategory.toUpperCase()}
                                    onChange={(value) =>
                                      updateRow(index, { bnpccategory: value })
                                    }
                                    options={[
                                      {
                                        value: "",
                                        label: "Choose BNPC category",
                                      },
                                      {
                                        value: "BASIC_NECESSITY",
                                        label: "Basic necessity",
                                      },
                                      {
                                        value: "PRIME_COMMODITY",
                                        label: "Prime commodity",
                                      },
                                    ]}
                                  />
                                )}
                              </div>
                            ) : (
                              <div className="receipt-existing-product">
                                <div>
                                  <strong>
                                    {row.selectedproductid
                                      ? row.rearrangedname || row.sku
                                      : "No catalog product selected"}
                                  </strong>
                                  <small>
                                    {row.selectedproductid
                                      ? `${row.sku || "No SKU"} · ${row.unit || "unit not set"}`
                                      : row.suggestedproductsku
                                        ? `AI suggestion: ${row.suggestedproductname} (${row.suggestedproductsku})`
                                        : "Search the active catalog and select the matching product."}
                                  </small>
                                </div>
                                <button
                                  className="button button-secondary"
                                  type="button"
                                  onClick={() => openProductChooser(index)}
                                  disabled={busy !== null}
                                >
                                  {row.selectedproductid
                                    ? "Change product"
                                    : "Choose product"}
                                </button>
                                {productChooserRow === index && (
                                  <div className="receipt-product-picker">
                                    <label className="receipt-edit-field">
                                      <span>Search active products</span>
                                      <input
                                        autoFocus
                                        value={productSearch}
                                        onChange={(event) =>
                                          changeProductSearch(
                                            event.currentTarget.value,
                                          )
                                        }
                                        placeholder="Search by product name or SKU"
                                      />
                                    </label>
                                    {searchingProducts && (
                                      <small>Searching catalog…</small>
                                    )}
                                    {productSearchError && (
                                      <small className="receipt-picker-error">
                                        {productSearchError}
                                      </small>
                                    )}
                                    {!searchingProducts &&
                                      productSearch.trim().length >= 2 &&
                                      productOptions.length === 0 &&
                                      !productSearchError && (
                                        <small>
                                          No active products matched.
                                        </small>
                                      )}
                                    {productSearch.trim().length >= 2 &&
                                      productOptions.length > 0 && (
                                        <ul>
                                          {productOptions.map((product) => (
                                            <li key={product.id}>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  chooseProduct(index, product)
                                                }
                                              >
                                                <strong>{product.name}</strong>
                                                <small>
                                                  {product.sku} · {product.unit}
                                                  {product.tracksLots
                                                    ? " · lot tracked"
                                                    : ""}
                                                </small>
                                              </button>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    <button
                                      className="receipt-picker-close"
                                      type="button"
                                      onClick={closeProductChooser}
                                    >
                                      Close search
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          <div className="receipt-conversion-panel">
                            <div>
                              <strong>Package conversion</strong>
                              <small>
                                {conversionRecommended
                                  ? `AI suggests this conversion (${row.conversionconfidence || "LOW"} confidence). ${row.conversionreason || "Review the package before approving."}`
                                  : "Leave conversion off to receive the quantity as printed."}
                              </small>
                            </div>
                            <ReceiptField
                              label="Units per package"
                              type="number"
                              min="2"
                              step="1"
                              value={row.unitsperpackage}
                              onChange={(value) =>
                                updateRow(index, { unitsperpackage: value })
                              }
                            />
                            <ReceiptCheck
                              label="Convert packages into sellable units"
                              checked={
                                row.conversionapproved.toUpperCase() === "TRUE"
                              }
                              onChange={(checked) =>
                                updateRow(index, {
                                  conversionapproved: checked
                                    ? "TRUE"
                                    : "FALSE",
                                })
                              }
                            />
                          </div>
                          {zeroCost && (
                            <ReceiptField
                              label="Reason for zero cost"
                              value={row.zerocostreason}
                              onChange={(value) =>
                                updateRow(index, { zerocostreason: value })
                              }
                            />
                          )}
                        </article>
                      );
                    })}
                  </div>
                </fieldset>
                <button
                  className="button button-primary receipt-action"
                  type="button"
                  onClick={() => void validateDraft()}
                  disabled={busy !== null || draftRows.length === 0}
                >
                  {busy === "review" ? (
                    <LoaderCircle className="receipt-spinner" size={16} />
                  ) : (
                    <Check size={16} />
                  )}
                  {busy === "review" ? "Checking receipt…" : "Validate receipt"}
                </button>
                {busy === "review" && (
                  <ReceiptProgressChecklist
                    task="review"
                    activeStep={progressStep}
                  />
                )}
              </>
            )}
            {review && (
              <div className="receipt-review-summary">
                <strong>Ready for confirmation</strong>
                <div className="receipt-review-stats">
                  <span>{review.lineCount} lines</span>
                  <span>{review.existingProducts} confirmed products</span>
                  <span>{review.newProducts} new products</span>
                  <span>{review.conversions} approved conversions</span>
                </div>
                <div className="receipt-review-table-wrap">
                  <table className="receipt-review-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Receive</th>
                        <th>Avg. unit cost</th>
                        <th>Line total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {review.lines.slice(0, 8).map((line) => (
                        <tr key={line.row}>
                          <td>{line.name}</td>
                          <td>
                            {line.quantity}
                            {line.conversionFactor
                              ? ` units (×${line.conversionFactor})`
                              : ""}
                          </td>
                          <td>{line.unitCost}</td>
                          <td>{line.lineTotal}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {review.lines.length > 8 && (
                    <small>Showing 8 of {review.lines.length} lines.</small>
                  )}
                  {review.lines.some((line) => line.unitCostRounded) && (
                    <small>
                      Average unit cost is rounded to centavos; line total
                      preserves the exact package cost.
                    </small>
                  )}
                </div>
                <button
                  className="button button-primary receipt-action"
                  type="button"
                  onClick={() => void importReviewedCsv()}
                  disabled={busy !== null}
                >
                  {busy === "import" ? (
                    <LoaderCircle className="receipt-spinner" size={16} />
                  ) : (
                    <Check size={16} />
                  )}
                  {busy === "import"
                    ? "Recording stock…"
                    : "Confirm and receive stock"}
                </button>
                {busy === "import" && (
                  <ReceiptProgressChecklist
                    task="import"
                    activeStep={progressStep}
                  />
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="receipt-safety-note">
        <strong>Review before receiving</strong>
        <p>
          AI product matches and package conversions are suggestions. Confirm
          the catalog item, quantity, unit cost, lot, expiry, and new product
          details before validating. Approved package conversions must use an
          exact sellable unit cost; conversions for birth-control products are
          blocked. Stock is recorded only after you confirm the validated
          receipt.
        </p>
      </section>
    </section>
  );
}
