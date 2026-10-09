import { useRef, useState } from "react";
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

type PreparedReceipt = { csv: string; lineCount: number; filename: string };
type ReviewLine = {
  row: number;
  name: string;
  quantity: number;
  unitCost: string;
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
      "The AI response could not be validated. Try a clearer scan or split this receipt into fewer pages.",
    receipt_file_invalid: "Use a valid PDF, JPEG, PNG, or WebP receipt file.",
    receipt_upload_too_large: "Keep the combined upload under 18 MB.",
    too_many_receipt_lines:
      "This receipt has too many line items for one review file. Split it into smaller receipts.",
    receipt_upload_invalid: "Choose up to 20 PDF or image files.",
    receipt_review_invalid:
      "The edited CSV has validation errors. Review the row messages below.",
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
  const [reviewCsv, setReviewCsv] = useState("");
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [issues, setIssues] = useState<RowIssue[]>([]);
  const [error, setError] = useState("");
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<"prepare" | "review" | "import" | null>(
    null,
  );

  function chooseReceiptFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.currentTarget.files ?? []);
    const bytes = chosen.reduce((total, file) => total + file.size, 0);
    const supported = chosen.every((file) =>
      ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(
        fileMimeType(file),
      ),
    );
    setPrepared(null);
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
    setError("");
    setIssues([]);
    try {
      const response = await api.post<PreparedReceipt>(
        "/stock/receipts/ai-draft",
        {
          files: await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              mimeType: fileMimeType(file),
              dataBase64: await base64File(file),
            })),
          ),
        },
      );
      setPrepared(response);
      downloadCsv(response.csv, response.filename);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusy(null);
    }
  }

  async function reviewEditedCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError("");
    setIssues([]);
    setReview(null);
    setImported(null);
    setBusy("review");
    try {
      const csv = await file.text();
      setReviewCsv(csv);
      const response = await api.postCsv<ReviewResult>(
        "/stock/receipts/ai-review",
        csv,
      );
      setReview(response);
    } catch (requestError) {
      setError(errorText(requestError));
      setIssues(rowIssues(requestError));
    } finally {
      setBusy(null);
    }
  }

  async function importReviewedCsv() {
    if (!review || !reviewCsv || busy) return;
    setBusy("import");
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
    } catch (requestError) {
      setError(errorText(requestError));
      setIssues(rowIssues(requestError));
    } finally {
      setBusy(null);
    }
  }

  function startOver() {
    setFiles([]);
    setPrepared(null);
    setReview(null);
    setReviewCsv("");
    setIssues([]);
    setError("");
    setImported(null);
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
            Extract a supplier receipt, review the prepared CSV, then record
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
          <strong>Fix these CSV rows and upload the edited file again.</strong>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.row}-${index}`}>
                Row {issue.row}: {issue.message}
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
                : "Extract and prepare CSV"}
            </button>
          </div>
        </section>

        <section
          className={`settings-main-card receipt-step ${review ? "receipt-step-complete" : ""}`}
        >
          <div className="receipt-step-number">2</div>
          <div className="receipt-step-content">
            <div className="card-heading receipt-card-heading">
              <div>
                <h2>Review the CSV</h2>
                <p>
                  Check original text, product suggestions, quantities, lots,
                  expiry dates, and conversion approvals. Select matches
                  yourself.
                </p>
              </div>
              {review && <Check size={18} aria-label="Complete" />}
            </div>
            {prepared ? (
              <div className="receipt-prepared-file">
                <span>
                  <strong>{prepared.lineCount}</strong> line items prepared
                </span>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => downloadCsv(prepared.csv, prepared.filename)}
                >
                  <ArrowDownToLine size={15} /> Download CSV again
                </button>
              </div>
            ) : (
              <p className="receipt-step-hint">
                Prepare a receipt first. The CSV download will open after
                extraction.
              </p>
            )}
            <input
              ref={reviewInput}
              className="receipt-file-input"
              type="file"
              accept="text/csv,.csv"
              onChange={(event) => void reviewEditedCsv(event)}
            />
            <button
              className="button button-secondary receipt-action"
              type="button"
              onClick={() => reviewInput.current?.click()}
              disabled={!prepared || busy !== null}
            >
              {busy === "review" ? (
                <LoaderCircle className="receipt-spinner" size={16} />
              ) : (
                <FileUp size={16} />
              )}
              {busy === "review"
                ? "Validating CSV…"
                : "Upload edited CSV for validation"}
            </button>
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
                        <th>Unit cost</th>
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
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {review.lines.length > 8 && (
                    <small>Showing 8 of {review.lines.length} lines.</small>
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
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="receipt-safety-note">
        <strong>Review rules</strong>
        <p>
          AI matches are suggestions only. For a new product, complete its
          sellable unit, sale price, tax class, and product type in the CSV. To
          for every suggested conversion, set conversionApproved to TRUE to
          convert or FALSE to keep the package quantity. Check the package count
          and factor; the POS calculates exact per-unit cost and converts only
          to a discrete sellable unit. Birth-control products are blocked.
          Unreadable fields stay blank.
        </p>
      </section>
    </section>
  );
}
