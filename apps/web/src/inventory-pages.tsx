import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Package,
  Search,
  ShoppingCart,
  X,
} from "lucide-react";
import { api, ApiError } from "./api";
import { RecentTransactions } from "./recent-transactions";

type Product = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  unit: string;
  sellingPrice: string;
  taxClass: "VATABLE" | "VAT_EXEMPT" | "ZERO_RATED";
  isScEligible: boolean;
  isPwdEligible: boolean;
  isBnpcEligible: boolean;
  bnpcCategory: "BASIC_NECESSITY" | "PRIME_COMMODITY" | null;
  productType: "GENERIC" | "BRANDED" | "NOT_APPLICABLE" | null;
  tracksLots: boolean;
  quantityOnHand: number;
  unallocatedQuantity: number;
  saleableQuantity: number;
  reorderLevel: number | null;
  active: boolean;
  latestAcquisitionCost: string | null;
  weightedAverageUnitCost: string;
  inventoryValue: string;
  unitPriceSpread: string;
  estimatedUnitGrossProfit: string;
  grossProfitEstimateApproved: boolean;
};

type CatalogProduct = Pick<
  Product,
  | "id"
  | "sku"
  | "name"
  | "barcode"
  | "unit"
  | "sellingPrice"
  | "taxClass"
  | "isScEligible"
  | "isPwdEligible"
  | "isBnpcEligible"
  | "bnpcCategory"
  | "productType"
  | "tracksLots"
> & {
  quantityAvailable: number;
  physicalQuantity: number;
  assignedLots: Array<{
    lotId: string;
    lotCode: string;
    expiryDate: string;
    quantityAvailable: number;
  }>;
};

type InventoryLot = {
  id: string;
  productId: string;
  lotCode: string;
  expiryDate: string;
  quarantined: boolean;
  quantity: number;
  saleableQuantity: number;
  sku: string;
  productName: string;
  alert: "EXPIRED" | "NEAR_EXPIRY" | null;
};

function lotStatusPresentation(
  lot: Pick<InventoryLot, "quarantined" | "alert">,
) {
  if (lot.quarantined) {
    return { label: "Quarantined", className: "is-quarantined" };
  }
  if (lot.alert === "EXPIRED") {
    return { label: "Expired", className: "is-expired" };
  }
  if (lot.alert === "NEAR_EXPIRY") {
    return { label: "Near expiry", className: "is-near-expiry" };
  }
  return { label: "Saleable", className: "is-saleable" };
}

type StockEvent = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  type: string;
  quantityDelta: number;
  unitCost: string | null;
  inventoryValueDelta: string;
  reference: string | null;
  supplier: string | null;
  reason: string | null;
  actorEmail: string | null;
  createdAt: string;
};

const EMPTY_FORM = {
  name: "",
  unit: "piece",
  sellingPrice: "",
  reorderLevel: "",
  taxClass: "VATABLE" as Product["taxClass"],
  isScEligible: false,
  isPwdEligible: false,
  isBnpcEligible: false,
  bnpcCategory: "" as "BASIC_NECESSITY" | "PRIME_COMMODITY" | "",
  productType: "" as Product["productType"] | "",
  tracksLots: false,
  openingQuantity: "0",
  openingUnitCost: "",
  openingZeroCostReason: "",
  openingReference: "",
  openingLotCode: "",
  openingExpiryDate: "",
  openingSupplier: "",
};

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "Something went wrong. Please try again.";
  const messages: Record<string, string> = {
    invalid_request: "Check the fields and try again.",
    sku_already_exists: "That SKU is already in the catalog.",
    barcode_already_exists:
      "That barcode is already assigned to another product.",
    zero_rated_not_approved:
      "Zero-rated products are unavailable until tax settings are approved.",
    product_not_found:
      "That product could not be found. Refresh and try again.",
    receipt_lot_required:
      "Enter the lot or batch code and expiry date for this tracked product.",
    adjustment_lot_required:
      "Choose the exact lot being adjusted and enter batch details for a new lot.",
    expiry_disposal_requires_lot:
      "Choose the exact lot before recording an expiry disposal.",
    expired_lot_not_allowed:
      "Expired stock cannot be received or added to saleable inventory.",
    insufficient_saleable_lot_stock:
      "There is not enough unexpired, non-quarantined lot stock for this sale.",
    lot_pick_confirmation_required:
      "Review and confirm the assigned FEFO lots before finalizing the sale.",
    insufficient_lot_stock:
      "The selected lot does not have enough units for this change.",
    active_lots_require_tracking:
      "Lot tracking cannot be turned off while physical stock remains.",
    product_does_not_track_lots:
      "This product is not configured for lot tracking.",
    insufficient_unallocated_stock:
      "The reconciliation quantity exceeds unallocated legacy stock.",
    returned_lot_not_saleable:
      "A sold lot is expired or quarantined. Use the write-off treatment.",
    lot_return_verification_required:
      "Confirm that the returned items match their saved lots before restocking.",
    unit_locked_after_stock_history:
      "A product unit cannot change after stock history exists.",
    inventory_value_overflow:
      "The resulting stock value is outside the supported range.",
    tax_policy_not_approved:
      "Checkout is locked until the owner records accountant-approved tax and cost-basis settings.",
    open_shift_required: "Open a cashier shift before finalizing a sale.",
    shift_already_open:
      "Only one cash register may be open at a time. Use emergency close if the previous cashier left a shift open.",
    product_not_senior_eligible:
      "This product is not marked eligible for a Senior Citizen benefit.",
    product_not_pwd_eligible:
      "This product is not marked eligible for a PWD benefit.",
    bnpc_classification_review_required:
      "Choose Basic Necessity or Prime Commodity for this BNPC-eligible product.",
    insufficient_stock:
      "The requested change exceeds available stock. Refresh and review the cart.",
    customer_encryption_unavailable:
      "Customer ID encryption is not configured for this environment.",
    variance_reason_required:
      "Enter a reason when the cash count differs from expected cash.",
    idempotency_key_reused:
      "This checkout request changed after submission. Calculate the total again.",
    product_unavailable:
      "A product in this cart is no longer active. Refresh and review the cart.",
  };
  return (
    messages[error.code] ?? "The request was rejected. Refresh and try again."
  );
}

function productTypeLabel(productType: Product["productType"]): string {
  if (productType === null) return "Unclassified";
  if (productType === "GENERIC") return "Generic";
  if (productType === "BRANDED") return "Branded";
  return "N/A";
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <label className="inventory-field" htmlFor={id}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </div>
  );
}

function centsFromMoney(value: string): bigint {
  const negative = value.startsWith("-");
  const normalized = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? "−" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}₱${(absolute / 100n).toLocaleString("en-PH")}.${String(absolute % 100n).padStart(2, "0")}`;
}

function createBrowserUuid(): string {
  if (typeof window.crypto.randomUUID === "function")
    return window.crypto.randomUUID();

  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function eventAcquisitionSpread(
  event: StockEvent,
  products: Product[],
): string | null {
  if (!["OPENING", "RECEIPT"].includes(event.type) || event.unitCost === null) {
    return null;
  }
  const product = products.find((item) => item.id === event.productId);
  return product
    ? formatCents(
        centsFromMoney(product.sellingPrice) - centsFromMoney(event.unitCost),
      )
    : null;
}

function useProducts() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function refresh() {
    setError("");
    const result = await api.get<{ products: Product[] }>("/products");
    setProducts(result.products);
  }
  useEffect(() => {
    let active = true;
    void api
      .get<{ products: Product[] }>("/products")
      .then((result) => {
        if (active) setProducts(result.products);
      })
      .catch(() => {
        if (active) setError("Unable to load products.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // Fetch persisted product data on mount.
  }, []);
  return { products, setProducts, loading, error, setError, refresh };
}

function productCsvErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "The CSV import could not be completed. No products were imported.";
  if (error.code === "csv_import_invalid") {
    const rowErrors = error.responseBody?.rowErrors;
    if (Array.isArray(rowErrors)) {
      const details = rowErrors
        .map((item) => {
          if (typeof item !== "object" || item === null) return "";
          const row = "row" in item ? item.row : "?";
          const message = "message" in item ? item.message : "Invalid row.";
          return `Row ${String(row)}: ${String(message)}`;
        })
        .filter(Boolean)
        .join(" ");
      if (details) return `No products were imported. ${details}`;
    }
    return "The CSV headers or rows are invalid. No products were imported.";
  }
  if (error.code === "sku_already_exists")
    return "A SKU already exists. No products were imported.";
  if (error.code === "barcode_already_exists")
    return "A barcode already exists. No products were imported.";
  if (error.code === "zero_rated_not_approved")
    return "Zero-rated products are unavailable until tax settings are approved. No products were imported.";
  return "The CSV import failed. Check the product rows and try again.";
}

function ProductCsvImportPanel({
  onImported,
}: {
  onImported: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function importCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    if (file.size > 200_000) {
      setError("Choose a CSV file that is 200 KB or smaller.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.postCsv<{ createdCount: number }>(
        "/products/import-csv",
        await file.text(),
      );
      setNotice(
        `Imported ${result.createdCount} product${result.createdCount === 1 ? "" : "s"} with opening stock.`,
      );
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      await onImported().catch(() => {
        setError("Products imported, but the catalog could not be refreshed.");
      });
    } catch (caught) {
      setError(productCsvErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-main-card csv-import-card">
      <div className="card-heading">
        <div>
          <h2>Import new products from CSV</h2>
          <p>
            Create catalog products with opening stock and optional lot and
            expiry details. The whole file is checked before any products are
            added; up to 500 rows and 200 KB per file. Replace or remove the
            downloaded sample row before importing.
          </p>
          <a
            className="text-action csv-template-download"
            href="/csv-templates/new-products-opening-stock.csv"
            download
          >
            <ArrowDownToLine size={14} />
            Download new products CSV sample
          </a>
        </div>
      </div>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner banner-success" role="status">
          {notice}
        </div>
      )}
      <form
        className="csv-import-form"
        onSubmit={(event) => void importCsv(event)}
      >
        <Field id="product-csv-file" label="New products CSV file">
          <input
            ref={inputRef}
            id="product-csv-file"
            className="text-input"
            type="file"
            accept=".csv,text/csv"
            required
            disabled={saving}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <button
          className="button button-secondary"
          type="submit"
          disabled={saving || !file}
        >
          {saving ? "Importing products…" : "Import products"}
        </button>
      </form>
    </section>
  );
}

function stockCsvErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "The stock import could not be completed. No stock was changed.";
  if (error.code === "csv_import_invalid") {
    const rowErrors = error.responseBody?.rowErrors;
    if (Array.isArray(rowErrors)) {
      const details = rowErrors
        .map((item) => {
          if (typeof item !== "object" || item === null) return "";
          const row = "row" in item ? item.row : "?";
          const message = "message" in item ? item.message : "Invalid row.";
          return `Row ${String(row)}: ${String(message)}`;
        })
        .filter(Boolean)
        .join(" ");
      if (details) return `No stock was changed. ${details}`;
    }
    return "The CSV headers or rows are invalid. No stock was changed.";
  }
  if (error.code === "inventory_value_overflow")
    return "The import would exceed a stock limit. No stock was changed.";
  return "The stock import failed. Check the SKU, quantity, cost, and lot details.";
}

function StockCsvImportPanel({
  onImported,
}: {
  onImported: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function importCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    if (file.size > 200_000) {
      setError("Choose a CSV file that is 200 KB or smaller.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.postCsv<{
        importedCount: number;
        productsAffected: number;
      }>("/stock/receipts/import-csv", await file.text());
      setNotice(
        `Imported ${result.importedCount} stock receipt${result.importedCount === 1 ? "" : "s"} across ${result.productsAffected} product${result.productsAffected === 1 ? "" : "s"}.`,
      );
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      await onImported().catch(() => {
        setError(
          "Stock was imported, but the stock view could not be refreshed.",
        );
      });
    } catch (caught) {
      setError(stockCsvErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-main-card csv-import-card">
      <div className="card-heading">
        <div>
          <h2>Import stock for existing products</h2>
          <p>
            Add receipt rows to existing SKUs. Tracked products need a lot code
            and expiry date. The whole file is checked before stock changes; up
            to 500 rows and 200 KB per file. Replace or remove the downloaded
            sample row before importing.
          </p>
          <a
            className="text-action csv-template-download"
            href="/csv-templates/existing-products-stock.csv"
            download
          >
            <ArrowDownToLine size={14} />
            Download existing stock CSV sample
          </a>
        </div>
      </div>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner banner-success" role="status">
          {notice}
        </div>
      )}
      <form
        className="csv-import-form"
        onSubmit={(event) => void importCsv(event)}
      >
        <Field id="stock-csv-file" label="Existing products stock CSV file">
          <input
            ref={inputRef}
            id="stock-csv-file"
            className="text-input"
            type="file"
            accept=".csv,text/csv"
            required
            disabled={saving}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <button
          className="button button-secondary"
          type="submit"
          disabled={saving || !file}
        >
          {saving ? "Importing stock…" : "Import stock"}
        </button>
      </form>
    </section>
  );
}

export function ProductsPage() {
  const { products, loading, error, setError, refresh } = useProducts();
  const productTableRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [zeroRatedAllowed, setZeroRatedAllowed] = useState(false);
  const [productTableScroll, setProductTableScroll] = useState({
    canScrollLeft: false,
    canScrollRight: false,
    isScrollable: false,
  });

  function updateProductTableScroll() {
    const table = productTableRef.current;
    if (!table) return;
    const maxScrollLeft = table.scrollWidth - table.clientWidth;
    const next = {
      canScrollLeft: table.scrollLeft > 1,
      canScrollRight: maxScrollLeft - table.scrollLeft > 1,
      isScrollable: maxScrollLeft > 1,
    };
    setProductTableScroll((current) =>
      current.canScrollLeft === next.canScrollLeft &&
      current.canScrollRight === next.canScrollRight &&
      current.isScrollable === next.isScrollable
        ? current
        : next,
    );
  }

  function scrollProductTable(direction: -1 | 1) {
    productTableRef.current?.scrollBy({
      left: direction * 360,
      behavior: "smooth",
    });
  }

  useEffect(() => {
    const table = productTableRef.current;
    if (!table) return;
    updateProductTableScroll();
    const observer = new ResizeObserver(updateProductTableScroll);
    observer.observe(table);
    const tableContent = table.querySelector("table");
    if (tableContent) observer.observe(tableContent);
    window.addEventListener("resize", updateProductTableScroll);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateProductTableScroll);
    };
  }, [loading, products.length, query]);
  useEffect(() => {
    let active = true;
    void api
      .get<{ policy: { approved: boolean; allowZeroRated: boolean } }>(
        "/tax-policy",
      )
      .then(({ policy }) => {
        if (active) {
          setZeroRatedAllowed(policy.approved && policy.allowZeroRated);
        }
      })
      .catch(() => {
        if (active) setZeroRatedAllowed(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const visibleProducts = products.filter((product) => {
    const text =
      `${product.name} ${product.sku} ${product.barcode ?? ""}`.toLowerCase();
    return text.includes(query.trim().toLowerCase());
  });

  function startEdit(product: Product) {
    setNotice("");
    setError("");
    setEditing(product);
    setForm({
      ...EMPTY_FORM,
      name: product.name,
      unit: product.unit,
      sellingPrice: product.sellingPrice,
      reorderLevel:
        product.reorderLevel === null ? "" : String(product.reorderLevel),
      taxClass: product.taxClass,
      isScEligible: product.isScEligible,
      isPwdEligible: product.isPwdEligible,
      isBnpcEligible: product.isBnpcEligible,
      bnpcCategory: product.bnpcCategory ?? "",
      productType: product.productType ?? "",
      tracksLots: product.tracksLots,
    });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError("");
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    const common = {
      name: form.name,
      unit: form.unit,
      sellingPrice: form.sellingPrice,
      reorderLevel: form.reorderLevel === "" ? null : Number(form.reorderLevel),
      taxClass: form.taxClass,
      isScEligible: form.isScEligible,
      isPwdEligible: form.isPwdEligible,
      bnpcEligible: form.isBnpcEligible,
      ...(form.isBnpcEligible
        ? {
            bnpcCategory: form.bnpcCategory || undefined,
          }
        : {}),
      tracksLots: form.tracksLots,
      ...(form.productType ? { productType: form.productType } : {}),
    };
    try {
      if (editing) {
        await api.patch(`/products/${editing.id}`, common);
        setNotice("Product changes saved.");
      } else {
        const body = {
          ...common,
          openingQuantity: Number(form.openingQuantity),
          ...(Number(form.openingQuantity) > 0
            ? { openingUnitCost: form.openingUnitCost }
            : {}),
          ...(form.tracksLots && Number(form.openingQuantity) > 0
            ? {
                openingReference: form.openingReference.trim(),
                openingLotCode: form.openingLotCode.trim(),
                openingExpiryDate: form.openingExpiryDate,
                ...(form.openingSupplier.trim()
                  ? { openingSupplier: form.openingSupplier.trim() }
                  : {}),
              }
            : {}),
          ...(Number(form.openingQuantity) > 0 &&
          centsFromMoney(form.openingUnitCost) === 0n
            ? { zeroCostReason: form.openingZeroCostReason.trim() }
            : {}),
        };
        const result = await api.post<{
          product: Product;
          generatedSku: boolean;
        }>("/products", body);
        setNotice(
          result.generatedSku
            ? `Product created with SKU ${result.product.sku}.`
            : "Product created.",
        );
      }
      await refresh();
      setEditing(null);
      setForm(EMPTY_FORM);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(product: Product) {
    setError("");
    setNotice("");
    try {
      await api.patch(`/products/${product.id}`, { active: !product.active });
      setNotice(
        product.active
          ? "Product deactivated; its history remains available."
          : "Product reactivated.",
      );
      await refresh();
      setEditing({ ...product, active: !product.active });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="page-section inventory-page">
      <PageHeading
        eyebrow="OWNER CATALOG"
        title="Products"
        description="Maintain selling prices, classifications, and starting inventory for each SKU."
      />
      {(error || notice) && (
        <div
          className={`banner ${error ? "banner-error" : "banner-success"}`}
          role={error ? "alert" : "status"}
        >
          {error || notice}
        </div>
      )}
      <ProductCsvImportPanel onImported={refresh} />
      <div className="inventory-layout">
        <section className="settings-main-card product-list-card">
          <div className="card-heading inventory-card-heading">
            <div>
              <h2>Product catalog</h2>
              <p>Owner view includes acquisition cost and inventory value.</p>
            </div>
            <span className="count-chip">{products.length} SKUs</span>
          </div>
          <div className="inventory-search-row">
            <Search size={16} />
            <input
              className="text-input"
              aria-label="Search products"
              placeholder="Search name, SKU, or barcode"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {productTableScroll.isScrollable && (
            <div className="inventory-table-scroll-controls">
              <span>Scroll to see more columns</span>
              <div>
                <button
                  type="button"
                  aria-label="Scroll product table left"
                  title="Scroll left"
                  disabled={!productTableScroll.canScrollLeft}
                  onClick={() => scrollProductTable(-1)}
                >
                  <ChevronLeft size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Scroll product table right"
                  title="Scroll right"
                  disabled={!productTableScroll.canScrollRight}
                  onClick={() => scrollProductTable(1)}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}
          <div
            className="inventory-table-wrap"
            ref={productTableRef}
            onScroll={updateProductTableScroll}
          >
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>PRODUCT</th>
                  <th>ON HAND</th>
                  <th>SELL PRICE</th>
                  <th>LATEST COST</th>
                  <th>AVG. COST</th>
                  <th>PRICE SPREAD</th>
                  <th>EST. GROSS PROFIT</th>
                  <th>INVENTORY VALUE</th>
                  <th>STATUS</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={7} className="table-loading">
                      Loading products…
                    </td>
                  </tr>
                ) : visibleProducts.length ? (
                  visibleProducts.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <strong>{product.name}</strong>
                        <small>
                          {product.sku}
                          {` · ${productTypeLabel(product.productType)}`}
                          {product.barcode
                            ? ` · ${product.barcode}`
                            : ""} ·{" "}
                          {product.isBnpcEligible
                            ? `BNPC ${product.bnpcCategory === "BASIC_NECESSITY" ? "Basic Necessity" : "Prime Commodity"}`
                            : "BNPC ineligible"}
                          {product.unit}
                        </small>
                      </td>
                      <td>
                        {product.quantityOnHand}
                        {product.tracksLots && (
                          <small>
                            {product.saleableQuantity} saleable ·{" "}
                            {product.unallocatedQuantity} unallocated
                          </small>
                        )}
                        {product.reorderLevel !== null &&
                          product.quantityOnHand <= product.reorderLevel && (
                            <span className="low-stock-tag">
                              <AlertTriangle size={12} /> Low
                            </span>
                          )}
                      </td>
                      <td>₱{product.sellingPrice}</td>
                      <td>₱{product.latestAcquisitionCost ?? "—"}</td>
                      <td>₱{product.weightedAverageUnitCost}</td>
                      <td>₱{product.unitPriceSpread}</td>
                      <td>₱{product.estimatedUnitGrossProfit}</td>
                      <td>₱{product.inventoryValue}</td>
                      <td>
                        <span
                          className={`product-state ${product.active ? "product-state-active" : ""}`}
                        >
                          {product.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>
                        <button
                          className="text-action"
                          onClick={() => startEdit(product)}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10} className="table-loading">
                      {query
                        ? "No matching products."
                        : "No products yet. Add the first product using the form."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        <aside className="create-card inventory-form-card">
          <span className="create-card-icon">
            <Package size={17} />
          </span>
          <h2>{editing ? "Edit product" : "Add a product"}</h2>
          <p>
            {editing
              ? "Changes apply to future sales; past records stay unchanged."
              : "Set a single selling price and optional opening stock."}
          </p>
          <form
            className="form-stack inventory-form"
            onSubmit={(event) => void saveProduct(event)}
          >
            <Field id="product-name" label="Product name">
              <input
                id="product-name"
                className="text-input"
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                required
                maxLength={160}
              />
            </Field>
            <Field id="product-unit" label="Stock unit">
              <input
                id="product-unit"
                className="text-input"
                value={form.unit}
                onChange={(event) =>
                  setForm({ ...form, unit: event.target.value })
                }
                required
                maxLength={32}
              />
            </Field>
            <Field id="product-price" label="Selling price (₱)">
              <input
                id="product-price"
                className="text-input"
                inputMode="decimal"
                value={form.sellingPrice}
                onChange={(event) =>
                  setForm({ ...form, sellingPrice: event.target.value })
                }
                required
                pattern="[0-9]+(\.[0-9]{1,2})?"
              />
            </Field>
            <Field id="product-reorder-level" label="Reorder level (optional)">
              <input
                id="product-reorder-level"
                className="text-input"
                type="number"
                min="0"
                step="1"
                value={form.reorderLevel}
                onChange={(event) =>
                  setForm({ ...form, reorderLevel: event.target.value })
                }
              />
            </Field>
            <Field id="product-tax-class" label="Tax class">
              <select
                id="product-tax-class"
                className="text-input select-input"
                value={form.taxClass}
                onChange={(event) =>
                  setForm({
                    ...form,
                    taxClass: event.target.value as Product["taxClass"],
                  })
                }
              >
                <option value="VATABLE">VATable</option>
                <option value="VAT_EXEMPT">VAT exempt</option>
                <option value="ZERO_RATED" disabled={!zeroRatedAllowed}>
                  {zeroRatedAllowed
                    ? "Zero rated"
                    : "Zero rated (approval required)"}
                </option>
              </select>
            </Field>
            <fieldset className="inventory-radio-group">
              <legend className="field-label">Product type</legend>
              <div className="inventory-radio-options">
                {(
                  [
                    ["GENERIC", "Generic"],
                    ["BRANDED", "Branded"],
                    ["NOT_APPLICABLE", "N/A"],
                  ] as const
                ).map(([value, label]) => (
                  <label className="inventory-radio-option" key={value}>
                    <input
                      type="radio"
                      name="product-type"
                      value={value}
                      checked={form.productType === value}
                      onChange={() => setForm({ ...form, productType: value })}
                      required={!editing || form.productType === ""}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              {editing && !form.productType && (
                <small className="field-hint">
                  This existing product is unclassified. Choose one to record
                  its type.
                </small>
              )}
            </fieldset>
            <div
              className="inventory-checkbox-group"
              role="group"
              aria-label="Discount eligibility"
            >
              <span className="field-label">Discount eligibility</span>
              <label className="inventory-checkbox">
                <input
                  type="checkbox"
                  checked={form.isScEligible}
                  onChange={(event) =>
                    setForm({ ...form, isScEligible: event.target.checked })
                  }
                />
                <span>
                  Senior Citizen 20% discount + VAT exemption eligible
                </span>
              </label>
              <label className="inventory-checkbox">
                <input
                  type="checkbox"
                  checked={form.isPwdEligible}
                  onChange={(event) =>
                    setForm({ ...form, isPwdEligible: event.target.checked })
                  }
                />
                <span>PWD 20% discount + VAT exemption eligible</span>
              </label>
              <label className="inventory-checkbox">
                <input
                  type="checkbox"
                  checked={form.isBnpcEligible}
                  onChange={(event) =>
                    setForm({ ...form, isBnpcEligible: event.target.checked })
                  }
                />
                <span>BNPC 5% discount eligible</span>
              </label>
            </div>
            {form.isBnpcEligible && (
              <div
                className="inventory-checkbox-group"
                role="group"
                aria-label="BNPC eligibility review"
              >
                <span className="field-label">BNPC eligibility review</span>
                <Field
                  id="product-bnpc-category"
                  label="Covered goods category"
                >
                  <select
                    id="product-bnpc-category"
                    className="text-input select-input"
                    required
                    value={form.bnpcCategory}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        bnpcCategory: event.target.value as NonNullable<
                          Product["bnpcCategory"]
                        >,
                      })
                    }
                  >
                    <option value="">Choose category</option>
                    <option value="BASIC_NECESSITY">Basic Necessity</option>
                    <option value="PRIME_COMMODITY">Prime Commodity</option>
                  </select>
                </Field>
                <small className="field-hint">
                  The official list has two covered-goods sections. Both get 5%;
                  choose the section that lists this product.
                </small>
              </div>
            )}
            <label className="inventory-checkbox">
              <input
                type="checkbox"
                checked={form.tracksLots}
                onChange={(event) =>
                  setForm({ ...form, tracksLots: event.target.checked })
                }
              />
              <span>Track lots and expiry for this product</span>
            </label>
            {!editing && (
              <>
                <div className="inventory-form-divider">OPENING STOCK</div>
                <div className="inventory-two-fields">
                  <Field id="opening-quantity" label="Counted quantity">
                    <input
                      id="opening-quantity"
                      className="text-input"
                      type="number"
                      min="0"
                      step="1"
                      value={form.openingQuantity}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          openingQuantity: event.target.value,
                        })
                      }
                      required
                    />
                  </Field>
                  <Field id="opening-cost" label="Unit cost (₱)">
                    <input
                      id="opening-cost"
                      className="text-input"
                      inputMode="decimal"
                      value={form.openingUnitCost}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          openingUnitCost: event.target.value,
                        })
                      }
                      required={Number(form.openingQuantity) > 0}
                      disabled={Number(form.openingQuantity) === 0}
                      placeholder={
                        Number(form.openingQuantity) === 0
                          ? "Not needed"
                          : "Required"
                      }
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                    />
                  </Field>
                </div>
                {Number(form.openingQuantity) > 0 &&
                form.openingUnitCost !== "" &&
                /^0+(?:\.0{1,2})?$/.test(form.openingUnitCost) ? (
                  <Field
                    id="opening-zero-cost-reason"
                    label="Reason for zero cost"
                  >
                    <input
                      id="opening-zero-cost-reason"
                      className="text-input"
                      value={form.openingZeroCostReason}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          openingZeroCostReason: event.target.value,
                        })
                      }
                      required
                      minLength={3}
                      maxLength={500}
                    />
                  </Field>
                ) : null}
                {form.tracksLots && Number(form.openingQuantity) > 0 && (
                  <>
                    <Field
                      id="opening-reference"
                      label="Reference / supplier note"
                    >
                      <input
                        id="opening-reference"
                        className="text-input"
                        value={form.openingReference}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            openingReference: event.target.value,
                          })
                        }
                        maxLength={200}
                      />
                    </Field>
                    <Field
                      id="opening-lot-code"
                      label="Opening lot / batch code"
                    >
                      <input
                        id="opening-lot-code"
                        className="text-input"
                        value={form.openingLotCode}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            openingLotCode: event.target.value,
                          })
                        }
                        required
                        maxLength={100}
                      />
                    </Field>
                    <Field
                      id="opening-expiry-date"
                      label="Expiry date (last saleable day)"
                    >
                      <input
                        id="opening-expiry-date"
                        className="text-input"
                        type="date"
                        min={new Date().toLocaleDateString("en-CA", {
                          timeZone: "Asia/Manila",
                        })}
                        value={form.openingExpiryDate}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            openingExpiryDate: event.target.value,
                          })
                        }
                        required
                      />
                    </Field>
                    <Field id="opening-supplier" label="Supplier (optional)">
                      <input
                        id="opening-supplier"
                        className="text-input"
                        value={form.openingSupplier}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            openingSupplier: event.target.value,
                          })
                        }
                        maxLength={160}
                      />
                    </Field>
                  </>
                )}
              </>
            )}
            <button
              className="button button-primary create-submit"
              type="submit"
              disabled={saving}
            >
              {saving ? "Saving…" : editing ? "Save product" : "Create product"}
              <CirclePlus size={16} />
            </button>
            {editing && (
              <>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => void toggleActive(editing)}
                >
                  {editing.active ? "Deactivate product" : "Reactivate product"}
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={cancelEdit}
                >
                  Cancel editing
                </button>
              </>
            )}
          </form>
        </aside>
      </div>
    </section>
  );
}

export function StockPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [events, setEvents] = useState<StockEvent[]>([]);
  const [lots, setLots] = useState<InventoryLot[]>([]);
  const [warningDays, setWarningDays] = useState(30);
  const [warningDaysInput, setWarningDaysInput] = useState("30");
  const [selectedId, setSelectedId] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [receiptQty, setReceiptQty] = useState("1");
  const [receiptCost, setReceiptCost] = useState("");
  const [zeroCostReason, setZeroCostReason] = useState("");
  const [reference, setReference] = useState("");
  const [supplier, setSupplier] = useState("");
  const [receiptLotCode, setReceiptLotCode] = useState("");
  const [receiptExpiryDate, setReceiptExpiryDate] = useState("");
  const [adjustQty, setAdjustQty] = useState("");
  const [reasonType, setReasonType] = useState("COUNT_CORRECTION");
  const [reason, setReason] = useState("");
  const [adjustCost, setAdjustCost] = useState("");
  const [adjustZeroCostReason, setAdjustZeroCostReason] = useState("");
  const [adjustLotId, setAdjustLotId] = useState("");
  const [adjustLotCode, setAdjustLotCode] = useState("");
  const [adjustExpiryDate, setAdjustExpiryDate] = useState("");
  const [reconcileLotCode, setReconcileLotCode] = useState("");
  const [reconcileExpiryDate, setReconcileExpiryDate] = useState("");
  const [reconcileQuantity, setReconcileQuantity] = useState("");
  const [reconcileReason, setReconcileReason] = useState("");
  const [physicalCountConfirmed, setPhysicalCountConfirmed] = useState(false);
  const [lotStatusReason, setLotStatusReason] = useState("");
  const selected = products.find((product) => product.id === selectedId);
  const filteredProducts = lowOnly
    ? products.filter(
        (product) =>
          product.reorderLevel !== null &&
          product.quantityOnHand <= product.reorderLevel,
      )
    : products;
  const selectedLots = lots.filter(
    (lot) => lot.productId === selectedId && lot.quantity > 0,
  );

  async function refreshProducts() {
    const result = await api.get<{ products: Product[] }>("/products");
    setProducts(result.products);
    if (!selectedId && result.products[0]) setSelectedId(result.products[0].id);
  }
  async function refreshEvents(id = selectedId) {
    const path = id
      ? `/stock/events?productId=${encodeURIComponent(id)}`
      : "/stock/events";
    const result = await api.get<{ events: StockEvent[] }>(path);
    setEvents(result.events);
  }
  async function refreshLots() {
    const result = await api.get<{
      warningDays: number;
      lots: InventoryLot[];
    }>("/stock/lots");
    setLots(result.lots);
    setWarningDays(result.warningDays);
    setWarningDaysInput(String(result.warningDays));
  }
  async function refreshAfterCsvImport() {
    await Promise.all([
      refreshProducts(),
      refreshEvents(selectedId),
      refreshLots(),
    ]);
  }
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<{ products: Product[] }>("/products"),
      api.get<{ events: StockEvent[] }>("/stock/events"),
      api.get<{ warningDays: number; lots: InventoryLot[] }>("/stock/lots"),
    ])
      .then(([productData, eventData, lotData]) => {
        if (!active) return;
        setProducts(productData.products);
        setEvents(eventData.events);
        setLots(lotData.lots);
        setWarningDays(lotData.warningDays);
        setWarningDaysInput(String(lotData.warningDays));
        if (productData.products[0]) setSelectedId(productData.products[0].id);
      })
      .catch(() => {
        if (active) setError("Unable to load stock records.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (loading) return;
    let active = true;
    const path = selectedId
      ? `/stock/events?productId=${encodeURIComponent(selectedId)}`
      : "/stock/events";
    void api
      .get<{ events: StockEvent[] }>(path)
      .then((result) => {
        if (active) setEvents(result.events);
      })
      .catch(() => {
        if (active) setError("Unable to load stock history.");
      });
    return () => {
      active = false;
    };
    // The selected product controls the history query.
  }, [selectedId, loading]);

  async function receive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.post("/stock/receipts", {
        productId: selected.id,
        quantity: Number(receiptQty),
        unitCost: receiptCost,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
        ...(selected.tracksLots
          ? { lotCode: receiptLotCode.trim(), expiryDate: receiptExpiryDate }
          : {}),
        ...(centsFromMoney(receiptCost) === 0n
          ? { zeroCostReason: zeroCostReason.trim() }
          : {}),
      });
      await Promise.all([
        refreshProducts(),
        refreshEvents(selected.id),
        refreshLots(),
      ]);
      setNotice(
        `Received ${receiptQty} ${selected.unit} for ${selected.name}.`,
      );
      setReceiptQty("1");
      setReceiptCost("");
      setReference("");
      setZeroCostReason("");
      setSupplier("");
      setReceiptLotCode("");
      setReceiptExpiryDate("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }
  async function adjust(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const quantityDelta = Number(adjustQty);
      await api.post("/stock/adjustments", {
        productId: selected.id,
        quantityDelta,
        reasonType,
        reason: reason.trim(),
        ...(quantityDelta > 0 ? { unitCost: adjustCost } : {}),
        ...(selected.tracksLots && quantityDelta < 0
          ? { lotId: adjustLotId }
          : {}),
        ...(selected.tracksLots && quantityDelta > 0
          ? {
              ...(adjustLotId ? { lotId: adjustLotId } : {}),
              ...(!adjustLotId
                ? {
                    lotCode: adjustLotCode.trim(),
                    expiryDate: adjustExpiryDate,
                  }
                : {}),
              ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
            }
          : {}),
        ...(quantityDelta > 0 && centsFromMoney(adjustCost) === 0n
          ? { zeroCostReason: adjustZeroCostReason.trim() }
          : {}),
      });
      await Promise.all([
        refreshProducts(),
        refreshEvents(selected.id),
        refreshLots(),
      ]);
      setNotice(`Stock adjustment recorded for ${selected.name}.`);
      setAdjustQty("");
      setReason("");
      setAdjustCost("");
      setAdjustZeroCostReason("");
      setAdjustLotId("");
      setAdjustLotCode("");
      setAdjustExpiryDate("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function saveExpiryWarning(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      const result = await api.put<{ warningDays: number }>(
        "/settings/expiry-warning",
        { warningDays: Number(warningDaysInput) },
      );
      setWarningDays(result.warningDays);
      setNotice("Expiry warning horizon updated.");
      await refreshLots();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function reconcileLegacyLot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.post("/stock/lots/reconcile", {
        productId: selected.id,
        reason: reconcileReason.trim(),
        physicalCountConfirmed,
        allocations: [
          {
            lotCode: reconcileLotCode.trim(),
            expiryDate: reconcileExpiryDate,
            quantity: Number(reconcileQuantity),
          },
        ],
      });
      await Promise.all([refreshProducts(), refreshLots()]);
      setNotice("Verified legacy units were assigned to the recorded lot.");
      setReconcileLotCode("");
      setReconcileExpiryDate("");
      setReconcileQuantity("");
      setReconcileReason("");
      setPhysicalCountConfirmed(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function toggleQuarantine(lot: InventoryLot) {
    setError("");
    setNotice("");
    try {
      await api.patch(`/stock/lots/${lot.id}/quarantine`, {
        quarantined: !lot.quarantined,
        reason: lotStatusReason.trim(),
      });
      await refreshLots();
      setNotice(
        lot.quarantined ? "Lot released from quarantine." : "Lot quarantined.",
      );
      setLotStatusReason("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="page-section inventory-page">
      <PageHeading
        eyebrow="OWNER INVENTORY"
        title="Stock"
        description="Receive deliveries, correct counts, record write-offs, and trace every stock change."
      />
      {(error || notice) && (
        <div
          className={`banner ${error ? "banner-error" : "banner-success"}`}
          role={error ? "alert" : "status"}
        >
          {error || notice}
        </div>
      )}
      <StockCsvImportPanel onImported={refreshAfterCsvImport} />
      <div className="stock-summary-grid">
        <div className="stock-summary-card">
          <span>PRODUCTS</span>
          <strong>{products.length}</strong>
        </div>
        <div className="stock-summary-card">
          <span>LOW STOCK</span>
          <strong>
            {
              products.filter(
                (p) =>
                  p.reorderLevel !== null && p.quantityOnHand <= p.reorderLevel,
              ).length
            }
          </strong>
        </div>
        <div className="stock-summary-card">
          <span>INVENTORY VALUE</span>
          <strong>
            {formatCents(
              products.reduce(
                (sum, p) => sum + centsFromMoney(p.inventoryValue),
                0n,
              ),
            )}
          </strong>
        </div>
      </div>
      <div className="inventory-layout stock-workspace">
        <section className="settings-main-card stock-list-card">
          <div className="card-heading inventory-card-heading">
            <div>
              <h2>Current stock</h2>
              <p>Value follows moving weighted-average acquisition cost.</p>
            </div>
            <label className="inventory-checkbox compact-checkbox">
              <input
                type="checkbox"
                checked={lowOnly}
                onChange={(event) => setLowOnly(event.target.checked)}
              />
              <span>Low stock only</span>
            </label>
          </div>
          <div className="inventory-table-wrap">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>PRODUCT</th>
                  <th>ON HAND</th>
                  <th>AVG. COST</th>
                  <th>STOCK VALUE</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={4} className="table-loading">
                      Loading stock…
                    </td>
                  </tr>
                ) : filteredProducts.length ? (
                  filteredProducts.map((product) => (
                    <tr
                      key={product.id}
                      className={
                        selectedId === product.id
                          ? "inventory-row-selected"
                          : ""
                      }
                      onClick={() => setSelectedId(product.id)}
                    >
                      <td>
                        <strong>{product.name}</strong>
                        <small>
                          {product.sku} · {product.unit}
                        </small>
                      </td>
                      <td>
                        {product.quantityOnHand}
                        {product.reorderLevel !== null &&
                          product.quantityOnHand <= product.reorderLevel && (
                            <span className="low-stock-tag">
                              <AlertTriangle size={12} /> Low
                            </span>
                          )}
                      </td>
                      <td>₱{product.weightedAverageUnitCost}</td>
                      <td>₱{product.inventoryValue}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="table-loading">
                      {lowOnly
                        ? "No products are below their reorder level."
                        : "Create a product before receiving stock."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="inventory-estimate-note">
            <Activity size={14} />
            <span>
              Stock quantity and inventory value update together with a
              permanent event record. Negative stock is blocked.
            </span>
          </div>
        </section>
        <aside className="stock-actions-column">
          <div className="create-card inventory-form-card">
            <span className="create-card-icon">
              <ArrowDownToLine size={17} />
            </span>
            <h2>Receive stock</h2>
            <p>
              Each receipt keeps its own acquisition cost; selling price remains
              separate.
            </p>
            {selected ? (
              <form
                className="form-stack inventory-form"
                onSubmit={(event) => void receive(event)}
              >
                <div className="selected-product-strip">
                  <strong>{selected.name}</strong>
                  <span>
                    {selected.sku} · on hand {selected.quantityOnHand}
                  </span>
                </div>
                <Field id="receipt-quantity" label="Quantity received">
                  <input
                    id="receipt-quantity"
                    className="text-input"
                    type="number"
                    min="1"
                    step="1"
                    value={receiptQty}
                    onChange={(event) => setReceiptQty(event.target.value)}
                    required
                  />
                </Field>
                <Field id="receipt-cost" label="Unit acquisition cost (₱)">
                  <input
                    id="receipt-cost"
                    className="text-input"
                    inputMode="decimal"
                    value={receiptCost}
                    onChange={(event) => setReceiptCost(event.target.value)}
                    required
                    pattern="[0-9]+(\.[0-9]{1,2})?"
                  />
                </Field>
                <Field id="receipt-reference" label="Reference / supplier note">
                  <input
                    id="receipt-reference"
                    className="text-input"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    maxLength={200}
                  />
                </Field>
                {selected.tracksLots && (
                  <>
                    <Field id="receipt-lot-code" label="Lot / batch code">
                      <input
                        id="receipt-lot-code"
                        className="text-input"
                        value={receiptLotCode}
                        onChange={(event) =>
                          setReceiptLotCode(event.target.value)
                        }
                        required
                        maxLength={100}
                      />
                    </Field>
                    <Field
                      id="receipt-expiry-date"
                      label="Expiry date (last saleable day)"
                    >
                      <input
                        id="receipt-expiry-date"
                        className="text-input"
                        type="date"
                        value={receiptExpiryDate}
                        onChange={(event) =>
                          setReceiptExpiryDate(event.target.value)
                        }
                        required
                      />
                    </Field>
                    <Field id="receipt-supplier" label="Supplier (optional)">
                      <input
                        id="receipt-supplier"
                        className="text-input"
                        value={supplier}
                        onChange={(event) => setSupplier(event.target.value)}
                        maxLength={160}
                      />
                    </Field>
                  </>
                )}
                {receiptCost !== "" && /^0+(?:\.0{1,2})?$/.test(receiptCost) ? (
                  <Field id="receipt-zero-reason" label="Reason for zero cost">
                    <input
                      id="receipt-zero-reason"
                      className="text-input"
                      value={zeroCostReason}
                      onChange={(event) =>
                        setZeroCostReason(event.target.value)
                      }
                      required
                      minLength={3}
                      maxLength={500}
                    />
                  </Field>
                ) : null}
                <button
                  className="button button-primary create-submit"
                  type="submit"
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Record receipt"}
                  <ArrowDownToLine size={15} />
                </button>
              </form>
            ) : (
              <p className="table-loading">
                Select a product from the stock list.
              </p>
            )}
          </div>
          <div className="create-card inventory-form-card">
            <h2>Adjustment or write-off</h2>
            <p>
              Decreases use current average cost. Increases require a unit cost.
            </p>
            {selected ? (
              <form
                className="form-stack inventory-form"
                onSubmit={(event) => void adjust(event)}
              >
                <div className="selected-product-strip">
                  <strong>{selected.name}</strong>
                  <span>Selected for adjustment</span>
                </div>
                <Field
                  id="adjust-quantity"
                  label="Quantity change (use minus to remove)"
                >
                  <input
                    id="adjust-quantity"
                    className="text-input"
                    type="number"
                    step="1"
                    value={adjustQty}
                    onChange={(event) => setAdjustQty(event.target.value)}
                    required
                  />
                </Field>
                {selected.tracksLots && Number(adjustQty) < 0 && (
                  <Field id="adjust-lot" label="Exact lot being removed">
                    <select
                      id="adjust-lot"
                      className="text-input select-input"
                      value={adjustLotId}
                      onChange={(event) => setAdjustLotId(event.target.value)}
                      required
                    >
                      <option value="">Choose a lot</option>
                      {selectedLots.map((lot) => (
                        <option key={lot.id} value={lot.id}>
                          {lot.lotCode} · expires {lot.expiryDate} ·{" "}
                          {lot.quantity} on hand
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {selected.tracksLots && Number(adjustQty) > 0 && (
                  <>
                    <Field
                      id="adjust-existing-lot"
                      label="Add to existing lot (optional)"
                    >
                      <select
                        id="adjust-existing-lot"
                        className="text-input select-input"
                        value={adjustLotId}
                        onChange={(event) => setAdjustLotId(event.target.value)}
                      >
                        <option value="">Create / find by batch details</option>
                        {selectedLots.map((lot) => (
                          <option key={lot.id} value={lot.id}>
                            {lot.lotCode} · expires {lot.expiryDate}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {!adjustLotId && (
                      <>
                        <Field
                          id="adjust-lot-code"
                          label="New lot / batch code"
                        >
                          <input
                            id="adjust-lot-code"
                            className="text-input"
                            value={adjustLotCode}
                            onChange={(event) =>
                              setAdjustLotCode(event.target.value)
                            }
                            required
                            maxLength={100}
                          />
                        </Field>
                        <Field
                          id="adjust-expiry-date"
                          label="Expiry date (last saleable day)"
                        >
                          <input
                            id="adjust-expiry-date"
                            className="text-input"
                            type="date"
                            value={adjustExpiryDate}
                            onChange={(event) =>
                              setAdjustExpiryDate(event.target.value)
                            }
                            required
                          />
                        </Field>
                      </>
                    )}
                  </>
                )}
                {Number(adjustQty) > 0 && (
                  <Field id="adjust-cost" label="Unit acquisition cost (₱)">
                    <input
                      id="adjust-cost"
                      className="text-input"
                      inputMode="decimal"
                      value={adjustCost}
                      onChange={(event) => setAdjustCost(event.target.value)}
                      required
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                    />
                  </Field>
                )}
                {Number(adjustQty) > 0 &&
                adjustCost !== "" &&
                /^0+(?:\.0{1,2})?$/.test(adjustCost) ? (
                  <Field
                    id="adjust-zero-cost-reason"
                    label="Reason for zero cost"
                  >
                    <input
                      id="adjust-zero-cost-reason"
                      className="text-input"
                      value={adjustZeroCostReason}
                      onChange={(event) =>
                        setAdjustZeroCostReason(event.target.value)
                      }
                      required
                      minLength={3}
                      maxLength={500}
                    />
                  </Field>
                ) : null}
                <Field id="adjust-type" label="Reason type">
                  <select
                    id="adjust-type"
                    className="text-input select-input"
                    value={reasonType}
                    onChange={(event) => setReasonType(event.target.value)}
                  >
                    <option value="COUNT_CORRECTION">Count correction</option>
                    <option value="DAMAGE">Damage write-off</option>
                    <option value="EXPIRY">Expiry write-off</option>
                    <option value="DISPOSAL">Disposal write-off</option>
                  </select>
                </Field>
                <Field id="adjust-reason" label="Reason">
                  <input
                    id="adjust-reason"
                    className="text-input"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                    minLength={3}
                    maxLength={500}
                  />
                </Field>
                <button
                  className="button button-primary create-submit"
                  type="submit"
                  disabled={
                    saving ||
                    (selected.tracksLots &&
                      Number(adjustQty) < 0 &&
                      !adjustLotId)
                  }
                >
                  {saving ? "Saving…" : "Record adjustment"}
                  <CirclePlus size={15} />
                </button>
              </form>
            ) : (
              <p className="table-loading">
                Select a product from the stock list.
              </p>
            )}
          </div>
        </aside>
      </div>
      <section className="activity-card stock-history-card stock-lots-card">
        <div className="card-heading">
          <div>
            <h2>Lots and expiry</h2>
            <p>
              Manila date{" "}
              {lots.length
                ? new Date().toLocaleDateString("en-CA", {
                    timeZone: "Asia/Manila",
                  })
                : ""}
              . Expiry is the last saleable day; expired lots stay recorded
              until disposed.
            </p>
          </div>
          <span className="count-chip">
            {lots.filter((lot) => lot.alert !== null).length} expiry alerts
          </span>
        </div>
        <form
          className="stock-horizon-form"
          onSubmit={(event) => void saveExpiryWarning(event)}
        >
          <Field
            id="expiry-warning-days"
            label="Near-expiry warning horizon (days)"
          >
            <input
              id="expiry-warning-days"
              className="text-input"
              type="number"
              min="0"
              max="365"
              step="1"
              value={warningDaysInput}
              onChange={(event) => setWarningDaysInput(event.target.value)}
              required
            />
          </Field>
          <div className="stock-horizon-actions">
            <span className="field-hint">
              Current horizon: {warningDays} days.
            </span>
            <button className="button button-quiet" type="submit">
              Save horizon
            </button>
          </div>
        </form>
        <div className="inventory-table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                <th>PRODUCT / LOT</th>
                <th>EXPIRY</th>
                <th>PHYSICAL</th>
                <th>SALEABLE</th>
                <th>STATUS</th>
                <th>CONTROL</th>
              </tr>
            </thead>
            <tbody>
              {lots.length ? (
                lots.map((lot) => (
                  <tr key={lot.id}>
                    <td>
                      <strong>{lot.productName}</strong>
                      <small>
                        {lot.sku} · batch {lot.lotCode}
                      </small>
                    </td>
                    <td>{lot.expiryDate}</td>
                    <td>{lot.quantity}</td>
                    <td>{lot.saleableQuantity}</td>
                    <td>
                      <span
                        className={`stock-lot-status ${lotStatusPresentation(lot).className}`}
                      >
                        {lotStatusPresentation(lot).label}
                      </span>
                    </td>
                    <td>
                      <button
                        className="button button-quiet stock-quarantine-action"
                        type="button"
                        disabled={!lotStatusReason.trim()}
                        onClick={() => void toggleQuarantine(lot)}
                      >
                        {lot.quarantined ? "Release" : "Quarantine"}
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="table-loading">
                    No lots recorded for tracked products.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="inventory-two-fields">
          <Field id="lot-status-reason" label="Reason for quarantine change">
            <input
              id="lot-status-reason"
              className="text-input"
              value={lotStatusReason}
              onChange={(event) => setLotStatusReason(event.target.value)}
              minLength={3}
              maxLength={500}
            />
            <small className="field-hint">
              Enter a reason to enable quarantine and release actions.
            </small>
          </Field>
          {selected?.tracksLots && selected.unallocatedQuantity > 0 && (
            <form
              className="form-stack inventory-form lot-reconciliation-form"
              onSubmit={(event) => void reconcileLegacyLot(event)}
            >
              <strong>Assign verified legacy stock</strong>
              <small>
                {selected.unallocatedQuantity} units remain unallocated and
                cannot be sold while lot tracking is enabled. Confirm a physical
                count before assigning them.
              </small>
              <small>
                Assignment changes only lot mapping. It distributes the existing
                SKU value at the current weighted average and does not change
                total quantity, total value, or the SKU costing method.
              </small>
              <Field id="reconcile-lot-code" label="Verified batch code">
                <input
                  id="reconcile-lot-code"
                  className="text-input"
                  value={reconcileLotCode}
                  onChange={(event) => setReconcileLotCode(event.target.value)}
                  required
                  maxLength={100}
                />
              </Field>
              <Field id="reconcile-expiry-date" label="Printed expiry date">
                <input
                  id="reconcile-expiry-date"
                  className="text-input"
                  type="date"
                  value={reconcileExpiryDate}
                  onChange={(event) =>
                    setReconcileExpiryDate(event.target.value)
                  }
                  required
                />
              </Field>
              <Field id="reconcile-quantity" label="Physical quantity assigned">
                <input
                  id="reconcile-quantity"
                  className="text-input"
                  type="number"
                  min="1"
                  max={selected.unallocatedQuantity}
                  step="1"
                  value={reconcileQuantity}
                  onChange={(event) => setReconcileQuantity(event.target.value)}
                  required
                />
              </Field>
              <Field id="reconcile-reason" label="Reconciliation note">
                <input
                  id="reconcile-reason"
                  className="text-input"
                  value={reconcileReason}
                  onChange={(event) => setReconcileReason(event.target.value)}
                  required
                  minLength={3}
                  maxLength={500}
                />
              </Field>
              <label className="inventory-checkbox">
                <input
                  type="checkbox"
                  checked={physicalCountConfirmed}
                  onChange={(event) =>
                    setPhysicalCountConfirmed(event.target.checked)
                  }
                  required
                />
                <span>
                  I physically verified the batch label, expiry, and quantity
                </span>
              </label>
              <button
                className="button button-primary"
                type="submit"
                disabled={saving || !physicalCountConfirmed}
              >
                {saving ? "Recording…" : "Record physical reconciliation"}
              </button>
            </form>
          )}
        </div>
      </section>
      <section className="activity-card stock-history-card stock-events-card">
        <div className="card-heading">
          <div>
            <h2>Stock history</h2>
            <p>
              {selected
                ? `Showing events for ${selected.name}.`
                : "Recent events across inventory."}
            </p>
          </div>
          <span className="count-chip">{events.length} events</span>
        </div>
        <div className="inventory-table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                <th>DATE / PRODUCT</th>
                <th>ACTION</th>
                <th>CHANGE</th>
                <th>UNIT COST</th>
                <th>SPREAD VS CURRENT PRICE</th>
                <th>VALUE CHANGE</th>
                <th>REFERENCE / REASON</th>
                <th>ACTOR</th>
              </tr>
            </thead>
            <tbody>
              {events.length ? (
                events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <strong>
                        {new Date(event.createdAt).toLocaleString()}
                      </strong>
                      <small>
                        {event.sku} · {event.productName}
                      </small>
                    </td>
                    <td>{event.type}</td>
                    <td>
                      {event.quantityDelta > 0 ? "+" : ""}
                      {event.quantityDelta}
                    </td>
                    <td>
                      {event.unitCost === null ? "—" : `₱${event.unitCost}`}
                    </td>
                    <td>
                      {eventAcquisitionSpread(event, products) === null
                        ? "—"
                        : eventAcquisitionSpread(event, products)}
                    </td>
                    <td>
                      {centsFromMoney(event.inventoryValueDelta) > 0n
                        ? "+"
                        : ""}
                      ₱{event.inventoryValueDelta}
                    </td>
                    <td>
                      <span>{event.reference ?? "—"}</span>
                      {event.supplier && (
                        <small>Supplier: {event.supplier}</small>
                      )}
                      {event.reason && <small>{event.reason}</small>}
                    </td>
                    <td>{event.actorEmail ?? "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="table-loading">
                    No stock events recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

type CartLine = {
  product: CatalogProduct;
  quantity: number;
  benefitTreatment: "REGULAR" | "SENIOR_CITIZEN" | "PWD" | "BNPC";
};

type BundleOffer = {
  id: string;
  versionId: string;
  version: number;
  code: string;
  name: string;
  activeFrom: string;
  activeUntil: string | null;
  maxQuantityPerSale: number | null;
  promotionalPrice: string;
  regularTotal: string;
  suggestedPromotionalPrice: string;
  priceRuleVersion: string;
  discountInteractionRule: string;
  quantityAvailable: number;
  components: Array<{
    productId: string;
    sku: string;
    name: string;
    unit: string;
    quantity: number;
    order: number;
    sellingPrice: string;
    taxClass: CatalogProduct["taxClass"];
    isScEligible: boolean;
    isPwdEligible: boolean;
    isBnpcEligible: boolean;
    bnpcCategory: "BASIC_NECESSITY" | "PRIME_COMMODITY" | null;
    tracksLots: boolean;
    quantityAvailable: number;
    assignedLots: CatalogProduct["assignedLots"];
  }>;
};

type BundleCartLine = {
  offer: BundleOffer;
  offerKey: string;
  quantity: number;
  componentBenefits: Record<
    string,
    "REGULAR" | "SENIOR_CITIZEN" | "PWD" | "BNPC"
  >;
};

type CheckoutPreview = {
  policy: {
    approved: boolean;
    version: string;
    cashRoundingMode: "NONE" | "NEAREST_25_CENTAVOS";
  };
  paymentMethod: "CASH" | "QR";
  policyNotice: string | null;
  lines: Array<{
    productId: string;
    name: string;
    quantity: number;
    bundle: null | {
      offerKey: string;
      code: string;
      name: string;
      regularGross: string;
      allocatedPromotionDiscount: string;
      appliedPromotionDiscount: string;
      promotionSelected: boolean;
      statutoryAlternativeAmountDue: string;
      promotionAlternativeAmountDue: string;
      selectedStatutoryTreatment: "REGULAR" | "SENIOR_CITIZEN" | "PWD" | "BNPC";
    };
    assignedLots: Array<{
      lotId: string;
      lotCode: string;
      expiryDate: string;
      quantity: number;
    }>;
    gross: string;
    bnpcEligible: boolean;
    bnpcCategory: "BASIC_NECESSITY" | "PRIME_COMMODITY" | null;
    benefitTreatment: "REGULAR" | "SENIOR_CITIZEN" | "PWD" | "BNPC";
    bnpcDiscount: string;
    taxBasis: string;
    vat: string;
    vatRemoved: string;
    discount: string;
    amountDue: string;
  }>;
  bundles: Array<{
    offerKey: string;
    code: string;
    name: string;
    version: number;
    quantity: number;
    regularTotal: string;
    promotionalPricePerBundle: string;
    promotionalDiscountOffered: string;
    promotionalDiscountApplied: string;
    discountInteractionRule: string;
    components: Array<{
      productId: string;
      productName: string;
      quantity: number;
      regularAmount: string;
      promotionAlternativeAmountDue: string;
      statutoryAlternativeAmountDue: string;
      appliedPromotionDiscount: string;
      selectedStatutoryTreatment: "REGULAR" | "SENIOR_CITIZEN" | "PWD" | "BNPC";
    }>;
  }>;
  totals: {
    subtotal: string;
    vat: string;
    vatRemoved: string;
    seniorDiscount: string;
    pwdDiscount: string;
    bnpcDiscount: string;
    bnpcQualifyingPurchase: string;
    bnpcAllowance: null | {
      purchaseBeforeSale: string;
      discountBeforeSale: string;
      localStoreOnly: boolean;
      weekStartDate: string;
    };
    bundlePromotionalDiscount: string;
    amountBeforeCashRounding: string;
    cashRoundingAdjustment: string;
    amountDue: string;
  };
};

type SaleRecord = {
  id: string;
  transactionId: string;
  paymentMethod: "CASH" | "QR";
  amountDue: string;
  bnpcDiscount: string;
  cashRoundingMode: "NONE" | "NEAREST_25_CENTAVOS";
  cashRoundingAdjustment: string;
  label: string;
};

type TaxPolicySummary = { approved: boolean; version: string };
type BnpcPolicySummary = {
  enabled: boolean;
  discountRateBasisPoints: number;
  version: string;
  weeklyPurchaseLimit: string;
  weeklyDiscountLimit: string;
  effectiveFrom: string;
  sourceTitle: string;
};

type CurrentShift = {
  id: string;
  openedAt: string;
  openingCash: string;
  expectedCash: string;
  expectedQrSales: string;
};
type RegisterShift = CurrentShift & { openedByEmail: string };

export function CheckoutPage() {
  const [query, setQuery] = useState("");
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>(
    {},
  );
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [bundleOffers, setBundleOffers] = useState<BundleOffer[]>([]);
  const [bundleCart, setBundleCart] = useState<BundleCartLine[]>([]);
  const [benefitType, setBenefitType] = useState<
    "REGULAR" | "SENIOR_CITIZEN" | "PWD"
  >("REGULAR");
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "QR">("CASH");
  const [customerName, setCustomerName] = useState("");
  const [customerBirthday, setCustomerBirthday] = useState("");
  const [customerIdType, setCustomerIdType] = useState("");
  const [customerIdNumber, setCustomerIdNumber] = useState("");
  const [customerIdChecked, setCustomerIdChecked] = useState(false);
  const [bnpcPolicy, setBnpcPolicy] = useState<BnpcPolicySummary | null>(null);
  const [bnpcBookletChecked, setBnpcBookletChecked] = useState(false);
  const [bnpcPriorPurchaseConfirmed, setBnpcPriorPurchaseConfirmed] =
    useState(false);
  const [bnpcExternalPurchase, setBnpcExternalPurchase] = useState("0.00");
  const [bnpcExternalDiscount, setBnpcExternalDiscount] = useState("0.00");
  const [bnpcRepresentativePurchase, setBnpcRepresentativePurchase] =
    useState(false);
  const [bnpcRepresentativeDocsChecked, setBnpcRepresentativeDocsChecked] =
    useState(false);
  const [bnpcAuthorizationLetterDate, setBnpcAuthorizationLetterDate] =
    useState("");
  const [bnpcPrescriptionApplicable, setBnpcPrescriptionApplicable] =
    useState(false);
  const [bnpcPrescriptionChecked, setBnpcPrescriptionChecked] = useState(false);
  const [bnpcFourKindsChecked, setBnpcFourKindsChecked] = useState(false);
  const [policy, setPolicy] = useState<TaxPolicySummary | null>(null);
  const [shift, setShift] = useState<CurrentShift | null>(null);
  const [registerShift, setRegisterShift] = useState<RegisterShift | null>(
    null,
  );
  const [registerOpen, setRegisterOpen] = useState(false);
  const [openingCash, setOpeningCash] = useState("0.00");
  const [closingCash, setClosingCash] = useState("0.00");
  const [showShiftCloseModal, setShowShiftCloseModal] = useState(false);
  const [emergencyClosingCash, setEmergencyClosingCash] = useState("");
  const [varianceReason, setVarianceReason] = useState<
    "" | "Cashier Fault" | "Customer Fault" | "No Fault"
  >("");
  const [preview, setPreview] = useState<CheckoutPreview | null>(null);
  const [lotPickConfirmed, setLotPickConfirmed] = useState(false);
  const [requestKey, setRequestKey] = useState("");
  const [saleRecord, setSaleRecord] = useState<SaleRecord | null>(null);
  const [recentSalesRefresh, setRecentSalesRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .get<{ products: CatalogProduct[] }>(
          `/catalog${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`,
        )
        .then((result) => {
          if (active) setProducts(result.products);
        })
        .catch(() => {
          if (active) setError("Unable to search the catalog.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<{ policy: TaxPolicySummary }>("/tax-policy"),
      api.get<{
        shift: CurrentShift | null;
        registerOpen: boolean;
        registerShift: RegisterShift | null;
      }>("/shifts/current"),
      api.get<{ bundles: BundleOffer[] }>("/bundles/active"),
      api.get<{ policy: BnpcPolicySummary }>("/bnpc-policy"),
    ])
      .then(([policyResult, shiftResult, bundleResult, bnpcResult]) => {
        if (!active) return;
        setPolicy(policyResult.policy);
        setShift(shiftResult.shift);
        setRegisterShift(shiftResult.registerShift);
        setRegisterOpen(shiftResult.registerOpen);
        setBundleOffers(bundleResult.bundles);
        setBnpcPolicy(bnpcResult.policy);
        if (shiftResult.shift) setClosingCash(shiftResult.shift.expectedCash);
      })
      .catch(() => {
        if (active) setError("Unable to load checkout settings.");
      })
      .finally(() => {
        if (active) setOperationsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const total = useMemo(
    () =>
      cart.reduce(
        (sum, line) =>
          sum +
          centsFromMoney(line.product.sellingPrice) * BigInt(line.quantity),
        0n,
      ) +
      bundleCart.reduce(
        (sum, line) =>
          sum +
          centsFromMoney(line.offer.promotionalPrice) * BigInt(line.quantity),
        0n,
      ),
    [cart, bundleCart],
  );
  const hasTrackedCart =
    cart.some((line) => line.product.tracksLots) ||
    bundleCart.some((line) =>
      line.offer.components.some((component) => component.tracksLots),
    );
  const hasBnpc =
    cart.some((line) => line.benefitTreatment === "BNPC") ||
    bundleCart.some((line) =>
      Object.values(line.componentBenefits).includes("BNPC"),
    );
  const hasSelectedBenefit =
    hasBnpc ||
    cart.some((line) => line.benefitTreatment !== "REGULAR") ||
    bundleCart.some((line) =>
      Object.values(line.componentBenefits).some(
        (treatment) => treatment !== "REGULAR",
      ),
    );
  const effectiveBenefitType = hasSelectedBenefit ? benefitType : "REGULAR";
  const bnpcChecks = {
    bookletChecked: bnpcBookletChecked,
    priorPurchaseConfirmed: bnpcPriorPurchaseConfirmed,
    externalPurchaseAmount: bnpcExternalPurchase,
    externalDiscountUsedAmount: bnpcExternalDiscount,
    representativePurchase: bnpcRepresentativePurchase,
    representativeDocumentsChecked: bnpcRepresentativeDocsChecked,
    authorizationLetterIssuedDate: bnpcAuthorizationLetterDate || null,
    prescriptionApplicable: bnpcPrescriptionApplicable,
    prescriptionChecked: bnpcPrescriptionChecked,
    fourKindsChecked: bnpcFourKindsChecked,
  };

  function invalidatePreview() {
    setPreview(null);
    setLotPickConfirmed(false);
    setRequestKey("");
    setSaleRecord(null);
    setError("");
    setNotice("");
  }

  function addProduct(product: CatalogProduct) {
    const available = availableProductQuantity(product.id);
    if (available <= 0) return;
    invalidatePreview();
    setQuery("");
    setCart((current) => {
      const line = current.find((entry) => entry.product.id === product.id);
      if (line)
        return current.map((entry) =>
          entry.product.id === product.id
            ? {
                ...entry,
                quantity: Math.min(available, entry.quantity + 1),
              }
            : entry,
        );
      return [
        ...current,
        { product, quantity: 1, benefitTreatment: "REGULAR" },
      ];
    });
  }
  function setQuantity(productId: string, quantity: number) {
    invalidatePreview();
    setQuantityDrafts((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
    setCart((current) =>
      current.flatMap((line) =>
        line.product.id !== productId
          ? [line]
          : quantity < 1
            ? []
            : [
                {
                  ...line,
                  quantity: Math.min(
                    availableProductQuantity(productId),
                    quantity,
                  ),
                },
              ],
      ),
    );
  }

  function editQuantity(productId: string, value: string) {
    invalidatePreview();
    setQuantityDrafts((current) => ({ ...current, [productId]: value }));
    if (!/^\d+$/.test(value)) return;
    const entered = Number(value);
    if (!Number.isSafeInteger(entered) || entered < 1) return;
    const capped = Math.min(entered, availableProductQuantity(productId));
    if (capped < 1) return;
    setCart((current) =>
      current.map((line) =>
        line.product.id === productId ? { ...line, quantity: capped } : line,
      ),
    );
    setQuantityDrafts((current) => ({
      ...current,
      [productId]: String(capped),
    }));
  }

  function finishQuantityEdit(productId: string) {
    setQuantityDrafts((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
  }

  function setBenefitForLine(
    productId: string,
    benefitTreatment: CartLine["benefitTreatment"],
  ) {
    invalidatePreview();
    setCart((current) =>
      current.map((line) =>
        line.product.id === productId ? { ...line, benefitTreatment } : line,
      ),
    );
  }

  function availableBundleQuantity(
    offer: BundleOffer,
    excludeOfferKey?: string,
  ) {
    let available = offer.quantityAvailable;
    for (const component of offer.components) {
      const productInCart =
        cart.find((line) => line.product.id === component.productId)
          ?.quantity ?? 0;
      const otherBundleUsage = bundleCart
        .filter((line) => line.offerKey !== excludeOfferKey)
        .reduce((sum, line) => {
          const otherComponent = line.offer.components.find(
            (entry) => entry.productId === component.productId,
          );
          return (
            sum + (otherComponent ? otherComponent.quantity * line.quantity : 0)
          );
        }, 0);
      available = Math.min(
        available,
        Math.floor(
          (component.quantityAvailable - productInCart - otherBundleUsage) /
            component.quantity,
        ),
      );
    }
    return Math.max(0, available);
  }

  function availableProductQuantity(productId: string) {
    const product =
      products.find((entry) => entry.id === productId) ??
      cart.find((entry) => entry.product.id === productId)?.product;
    if (!product) return 0;
    const bundleUsage = bundleCart.reduce((sum, line) => {
      const component = line.offer.components.find(
        (entry) => entry.productId === productId,
      );
      return sum + (component ? component.quantity * line.quantity : 0);
    }, 0);
    return Math.max(0, product.quantityAvailable - bundleUsage);
  }

  function addBundle(offer: BundleOffer) {
    invalidatePreview();
    setQuery("");
    setBundleCart((current) => {
      const existing = current.find(
        (line) =>
          line.offer.id === offer.id &&
          line.offer.versionId === offer.versionId,
      );
      const available = availableBundleQuantity(offer, existing?.offerKey);
      const nextQuantity = Math.min(
        available,
        offer.maxQuantityPerSale ?? Number.MAX_SAFE_INTEGER,
        (existing?.quantity ?? 0) + 1,
      );
      if (nextQuantity < 1) return current;
      if (existing)
        return current.map((line) =>
          line.offerKey === existing.offerKey
            ? { ...line, quantity: nextQuantity }
            : line,
        );
      return [
        ...current,
        {
          offer,
          offerKey: createBrowserUuid(),
          quantity: 1,
          componentBenefits: Object.fromEntries(
            offer.components.map((component) => [
              component.productId,
              "REGULAR",
            ]),
          ),
        },
      ];
    });
  }

  function setBundleQuantity(offerKey: string, quantity: number) {
    invalidatePreview();
    setBundleCart((current) => {
      const existing = current.find((line) => line.offerKey === offerKey);
      if (!existing) return current;
      if (quantity < 1)
        return current.filter((line) => line.offerKey !== offerKey);
      const available = availableBundleQuantity(existing.offer, offerKey);
      const capped = Math.min(
        quantity,
        available,
        existing.offer.maxQuantityPerSale ?? Number.MAX_SAFE_INTEGER,
      );
      return current.map((line) =>
        line.offerKey === offerKey ? { ...line, quantity: capped } : line,
      );
    });
  }

  function setBundleBenefit(
    offerKey: string,
    productId: string,
    benefitTreatment: NonNullable<BundleCartLine["componentBenefits"][string]>,
  ) {
    invalidatePreview();
    setBundleCart((current) =>
      current.map((line) =>
        line.offerKey === offerKey
          ? {
              ...line,
              componentBenefits: {
                ...line.componentBenefits,
                [productId]: benefitTreatment,
              },
            }
          : line,
      ),
    );
  }

  async function refreshShiftState(): Promise<void> {
    const result = await api.get<{
      shift: CurrentShift | null;
      registerOpen: boolean;
      registerShift: RegisterShift | null;
    }>("/shifts/current");
    setShift(result.shift);
    setRegisterShift(result.registerShift);
    setRegisterOpen(result.registerOpen);
    if (result.shift) setClosingCash(result.shift.expectedCash);
  }

  async function openCurrentShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post<{ shift: CurrentShift }>("/shifts", {
        openingCash,
      });
      setShift(result.shift);
      setRegisterShift(null);
      setRegisterOpen(true);
      setClosingCash(result.shift.expectedCash);
      setNotice("Cashier shift opened.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function closeCurrentShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shift) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.post(`/shifts/${shift.id}/close`, {
        actualCashCount: closingCash,
        ...(varianceReason.trim()
          ? { varianceReason: varianceReason.trim() }
          : {}),
      });
      setShift(null);
      setRegisterShift(null);
      setRegisterOpen(false);
      setShowShiftCloseModal(false);
      setVarianceReason("");
      setPreview(null);
      setRequestKey("");
      setNotice("Cashier shift closed.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function emergencyCloseShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!registerShift) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.post(`/shifts/${registerShift.id}/emergency-close`, {
        actualCashCount: emergencyClosingCash,
        ...(varianceReason ? { varianceReason } : {}),
      });
      setShift(null);
      setRegisterShift(null);
      setRegisterOpen(false);
      setVarianceReason("");
      setEmergencyClosingCash("");
      setNotice("Emergency shift close recorded.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function calculateCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cart.length && !bundleCart.length) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post<CheckoutPreview>("/sales/preview", {
        benefitType: effectiveBenefitType,
        paymentMethod,
        items: cart.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          benefitTreatment: line.benefitTreatment,
        })),
        bundleOffers: bundleCart.map((line) => ({
          offerKey: line.offerKey,
          bundleVersionId: line.offer.versionId,
          quantity: line.quantity,
          components: line.offer.components.map((component) => ({
            productId: component.productId,
            benefitTreatment:
              line.componentBenefits[component.productId] ?? "REGULAR",
          })),
        })),
        ...(hasBnpc ? { customerIdNumber, bnpcChecks } : {}),
      });
      setPreview(result);
      setLotPickConfirmed(false);
      setRequestKey(createBrowserUuid());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function finalizeSale() {
    if (!preview || !policy?.approved || !shift || !requestKey) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post<{ sale: SaleRecord; replayed: boolean }>(
        "/sales",
        {
          benefitType: effectiveBenefitType,
          paymentMethod,
          requestKey,
          items: cart.map((line) => ({
            productId: line.product.id,
            quantity: line.quantity,
            benefitTreatment: line.benefitTreatment,
            ...(line.product.tracksLots
              ? {
                  lotAllocations:
                    preview.lines
                      .find(
                        (previewLine) =>
                          previewLine.productId === line.product.id,
                      )
                      ?.assignedLots.map((lot) => ({
                        lotId: lot.lotId,
                        quantity: lot.quantity,
                      })) ?? [],
                  lotPickConfirmed,
                }
              : {}),
          })),
          bundleOffers: bundleCart.map((line) => ({
            offerKey: line.offerKey,
            bundleVersionId: line.offer.versionId,
            quantity: line.quantity,
            components: line.offer.components.map((component) => {
              const previewLine = preview.lines.find(
                (entry) =>
                  entry.bundle?.offerKey === line.offerKey &&
                  entry.productId === component.productId,
              );
              return {
                productId: component.productId,
                benefitTreatment:
                  line.componentBenefits[component.productId] ?? "REGULAR",
                ...(component.tracksLots
                  ? {
                      lotAllocations:
                        previewLine?.assignedLots.map((lot) => ({
                          lotId: lot.lotId,
                          quantity: lot.quantity,
                        })) ?? [],
                      lotPickConfirmed,
                    }
                  : {}),
              };
            }),
          })),
          ...(hasSelectedBenefit
            ? {
                customerName,
                customerBirthday,
                customerIdType,
                customerIdNumber,
                customerIdChecked,
              }
            : {}),
          ...(hasBnpc ? { bnpcChecks } : {}),
        },
      );
      setSaleRecord(result.sale);
      setRecentSalesRefresh((value) => value + 1);
      setCart([]);
      setBundleCart([]);
      setPreview(null);
      setRequestKey("");
      const [shiftResult, catalogResult, bundleResult] = await Promise.all([
        api.get<{
          shift: CurrentShift | null;
          registerOpen: boolean;
          registerShift: RegisterShift | null;
        }>("/shifts/current"),
        api.get<{ products: CatalogProduct[] }>(
          `/catalog${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`,
        ),
        api.get<{ bundles: BundleOffer[] }>("/bundles/active"),
      ]);
      setShift(shiftResult.shift);
      setRegisterShift(shiftResult.registerShift);
      setRegisterOpen(shiftResult.registerOpen);
      if (shiftResult.shift) setClosingCash(shiftResult.shift.expectedCash);
      setProducts(catalogResult.products);
      setBundleOffers(bundleResult.bundles);
      setNotice(result.replayed ? "Saved sale recovered." : "Sale saved.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-section inventory-page checkout-page">
      <PageHeading
        eyebrow="CASHIER WORKSPACE"
        title="Checkout"
        description="Find an active catalog product, review its price and availability, then add it to the cart."
      />
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner banner-success" role="status">
          {notice}
        </div>
      )}
      <div className="checkout-grid">
        <section className="settings-main-card catalog-search-card">
          <div className="card-heading inventory-card-heading">
            <div>
              <h2>Product search</h2>
              <p>Search by name, SKU, or barcode.</p>
            </div>
            <span className="activity-icon">
              <Search size={17} />
            </span>
          </div>
          <div className="inventory-search-row checkout-search">
            <Search size={16} />
            <input
              autoFocus
              className="text-input"
              aria-label="Search catalog"
              placeholder="Type product name, SKU, or barcode"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="catalog-result-list">
            {loading ? (
              <div className="table-loading">Searching catalog…</div>
            ) : products.length ? (
              products.map((product) => (
                <div className="catalog-result" key={product.id}>
                  <div className="catalog-product-copy">
                    <strong>{product.name}</strong>
                    <small>
                      {product.sku} · {product.unit}
                      {` · ${productTypeLabel(product.productType)}`}
                      {product.barcode ? ` · ${product.barcode}` : ""}
                    </small>
                    <span>
                      ₱{product.sellingPrice} · {product.quantityAvailable}{" "}
                      available
                      {product.tracksLots &&
                        product.assignedLots.length > 0 && (
                          <> · {product.assignedLots.length} saleable lot(s)</>
                        )}
                    </span>
                  </div>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={availableProductQuantity(product.id) <= 0}
                    onClick={() => addProduct(product)}
                  >
                    {availableProductQuantity(product.id)
                      ? "Add to cart"
                      : "Out of stock"}
                  </button>
                </div>
              ))
            ) : (
              <div className="table-loading">
                {query
                  ? "No active matching products."
                  : "The catalog is empty. Ask the owner to add products."}
              </div>
            )}
          </div>
          {bundleOffers.length > 0 && (
            <div className="bundle-offer-list">
              <h3>Bundle offers</h3>
              {bundleOffers.map((offer) => (
                <article className="catalog-result" key={offer.versionId}>
                  <div className="catalog-product-copy">
                    <strong>
                      {offer.name} · {offer.code}
                    </strong>
                    <small>
                      {offer.components
                        .map(
                          (component) =>
                            `${component.quantity} × ${component.name}`,
                        )
                        .join(" + ")}
                    </small>
                    <span>
                      Regular components ₱{offer.regularTotal} · bundle offer ₱
                      {offer.promotionalPrice} ·{" "}
                      {availableBundleQuantity(offer)} available
                    </span>
                  </div>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={availableBundleQuantity(offer) <= 0}
                    onClick={() => addBundle(offer)}
                  >
                    {availableBundleQuantity(offer) > 0
                      ? "Add bundle"
                      : "Unavailable"}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
        <aside className="settings-main-card cart-card">
          <div className="card-heading inventory-card-heading">
            <div>
              <h2>Current cart</h2>
              <p>Items and quantities are held in this browser until saved.</p>
            </div>
            <span className="activity-icon">
              <ShoppingCart size={17} />
            </span>
          </div>
          {cart.length || bundleCart.length ? (
            <>
              <div className="cart-lines">
                {cart.map((line) => (
                  <div className="cart-line" key={line.product.id}>
                    <div>
                      <strong>{line.product.name}</strong>
                      <small>
                        ₱{line.product.sellingPrice} × {line.quantity}
                      </small>
                    </div>
                    <div className="cart-line-actions">
                      <button
                        className="icon-button"
                        aria-label={`Remove one ${line.product.name}`}
                        onClick={() =>
                          setQuantity(line.product.id, line.quantity - 1)
                        }
                      >
                        −
                      </button>
                      <input
                        className="text-input cart-quantity-input"
                        aria-label={`Quantity for ${line.product.name}`}
                        type="number"
                        min={1}
                        max={availableProductQuantity(line.product.id)}
                        step={1}
                        value={quantityDrafts[line.product.id] ?? line.quantity}
                        onChange={(event) =>
                          editQuantity(line.product.id, event.target.value)
                        }
                        onBlur={() => finishQuantityEdit(line.product.id)}
                      />
                      <button
                        className="icon-button"
                        aria-label={`Add one ${line.product.name}`}
                        disabled={
                          line.quantity >=
                          availableProductQuantity(line.product.id)
                        }
                        onClick={() =>
                          setQuantity(line.product.id, line.quantity + 1)
                        }
                      >
                        +
                      </button>
                      <button
                        className="icon-button cart-remove"
                        aria-label={`Remove ${line.product.name}`}
                        onClick={() => setQuantity(line.product.id, 0)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </div>
                ))}
                {bundleCart.map((line) => (
                  <div
                    className="cart-line bundle-cart-line"
                    key={line.offerKey}
                  >
                    <div>
                      <strong>
                        {line.offer.name} · {line.offer.code}
                      </strong>
                      <small>
                        ₱{line.offer.regularTotal} regular · ₱
                        {line.offer.promotionalPrice} offer × {line.quantity}
                      </small>
                      <small>
                        {line.offer.components
                          .map(
                            (component) =>
                              `${component.quantity * line.quantity} × ${component.name}`,
                          )
                          .join(" + ")}
                      </small>
                    </div>
                    <div className="cart-line-actions">
                      <button
                        className="icon-button"
                        aria-label={`Remove one ${line.offer.name}`}
                        onClick={() =>
                          setBundleQuantity(line.offerKey, line.quantity - 1)
                        }
                      >
                        −
                      </button>
                      <span>{line.quantity}</span>
                      <button
                        className="icon-button"
                        aria-label={`Add one ${line.offer.name}`}
                        disabled={
                          line.quantity >=
                            availableBundleQuantity(
                              line.offer,
                              line.offerKey,
                            ) ||
                          (line.offer.maxQuantityPerSale !== null &&
                            line.quantity >= line.offer.maxQuantityPerSale)
                        }
                        onClick={() =>
                          setBundleQuantity(line.offerKey, line.quantity + 1)
                        }
                      >
                        +
                      </button>
                      <button
                        className="icon-button cart-remove"
                        aria-label={`Remove ${line.offer.name}`}
                        onClick={() => setBundleQuantity(line.offerKey, 0)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="cart-total">
                <span>Products and advertised bundle prices</span>
                <strong>{formatCents(total)}</strong>
              </div>
            </>
          ) : (
            <div className="cart-empty">
              <span className="empty-icon">
                <ShoppingCart size={22} />
              </span>
              <strong>Your cart is empty</strong>
              <small>Search the catalog or add an active bundle offer.</small>
            </div>
          )}
          <div className="checkout-policy-status" role="status">
            {operationsLoading || !policy
              ? "Loading tax policy…"
              : policy.approved
                ? `Approved tax profile: ${policy.version}`
                : "Provisional tax calculations only. Finalization stays locked until the owner records accountant-approved tax and cost-basis settings."}
          </div>
          {!operationsLoading && !shift && (
            <div className="shift-modal-backdrop">
              <section
                className="checkout-shift-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="open-shift-modal-title"
              >
                <div className="checkout-shift-modal-heading">
                  <span className="eyebrow">REGISTER REQUIRED</span>
                  <h2 id="open-shift-modal-title">Open a cashier shift</h2>
                  <p>Open the register before checkout can be completed.</p>
                </div>
                {error && (
                  <div className="banner banner-error" role="alert">
                    {error}
                  </div>
                )}
                <form
                  className="checkout-shift-form checkout-shift-modal-form"
                  onSubmit={(event) => void openCurrentShift(event)}
                >
                  {registerOpen && (
                    <p className="register-in-use-note" role="status">
                      {registerShift
                        ? `The register is still open under ${registerShift.openedByEmail}. Record a physical count and use emergency close below to release it.`
                        : "The single cash register is already open. Close the active shift before opening another."}
                    </p>
                  )}
                  <p>
                    Enter the physical cash placed in the drawer. QR
                    declarations are not counted as cash.
                  </p>
                  <Field id="shift-opening-cash" label="Opening cash (₱)">
                    <input
                      id="shift-opening-cash"
                      className="text-input"
                      inputMode="decimal"
                      autoFocus
                      value={openingCash}
                      onChange={(event) => setOpeningCash(event.target.value)}
                      disabled={registerOpen}
                      required
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                    />
                  </Field>
                  <button
                    className="button button-primary"
                    type="submit"
                    disabled={saving || registerOpen}
                  >
                    {saving ? "Opening…" : "Open shift"}
                  </button>
                </form>
                {registerShift && (
                  <div className="checkout-emergency-close">
                    <strong>
                      Emergency close: shift opened by{" "}
                      {registerShift.openedByEmail}
                    </strong>
                    <span>
                      Expected physical cash: ₱{registerShift.expectedCash}
                    </span>
                    <span>
                      Expected QR sales: ₱{registerShift.expectedQrSales}
                    </span>
                    {error && (
                      <div className="banner banner-error" role="alert">
                        {error}
                      </div>
                    )}
                    <form
                      className="form-stack inventory-form"
                      onSubmit={(event) => void emergencyCloseShift(event)}
                    >
                      <Field
                        id="emergency-shift-cash-count"
                        label="Actual physical cash count (₱)"
                      >
                        <input
                          id="emergency-shift-cash-count"
                          className="text-input"
                          inputMode="decimal"
                          value={emergencyClosingCash}
                          onChange={(event) =>
                            setEmergencyClosingCash(event.target.value)
                          }
                          required
                          pattern="[0-9]+(\.[0-9]{1,2})?"
                        />
                      </Field>
                      <Field
                        id="emergency-shift-variance-reason"
                        label="Variance reason if count differs"
                      >
                        <select
                          id="emergency-shift-variance-reason"
                          className="text-input select-input"
                          value={varianceReason}
                          onChange={(event) =>
                            setVarianceReason(
                              event.target.value as typeof varianceReason,
                            )
                          }
                        >
                          <option value="">Choose a reason</option>
                          <option value="Cashier Fault">Cashier Fault</option>
                          <option value="Customer Fault">Customer Fault</option>
                          <option value="No Fault">No Fault</option>
                        </select>
                      </Field>
                      <button
                        className="button button-quiet"
                        type="submit"
                        disabled={saving}
                      >
                        Emergency close shift
                      </button>
                    </form>
                  </div>
                )}
              </section>
            </div>
          )}
          {shift && (
            <div className="checkout-shift-open">
              <div className="checkout-shift-status">
                <div>
                  <strong>Shift open</strong>
                  <span>Expected physical cash: ₱{shift.expectedCash}</span>
                  <span>Expected QR sales: ₱{shift.expectedQrSales}</span>
                </div>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => setShowShiftCloseModal(true)}
                >
                  Close shift
                </button>
              </div>
            </div>
          )}
          {showShiftCloseModal && shift && (
            <div className="shift-modal-backdrop">
              <section
                className="checkout-shift-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="close-shift-modal-title"
              >
                <div className="checkout-shift-modal-heading">
                  <span className="eyebrow">CASH DRAWER COUNT</span>
                  <h2 id="close-shift-modal-title">Close cashier shift</h2>
                  <p>Expected physical cash: ₱{shift.expectedCash}</p>
                </div>
                {error && (
                  <div className="banner banner-error" role="alert">
                    {error}
                  </div>
                )}
                <form
                  className="form-stack inventory-form checkout-shift-close-form"
                  onSubmit={(event) => void closeCurrentShift(event)}
                >
                  <Field id="shift-closing-cash" label="Actual cash count (₱)">
                    <input
                      id="shift-closing-cash"
                      className="text-input"
                      inputMode="decimal"
                      autoFocus
                      value={closingCash}
                      onChange={(event) => setClosingCash(event.target.value)}
                      required
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                    />
                  </Field>
                  <Field
                    id="shift-variance-reason"
                    label="Variance reason if count differs"
                  >
                    <select
                      id="shift-variance-reason"
                      className="text-input select-input"
                      value={varianceReason}
                      onChange={(event) =>
                        setVarianceReason(
                          event.target.value as typeof varianceReason,
                        )
                      }
                    >
                      <option value="">Choose a reason</option>
                      <option value="Cashier Fault">Cashier Fault</option>
                      <option value="Customer Fault">Customer Fault</option>
                      <option value="No Fault">No Fault</option>
                    </select>
                  </Field>
                  <div className="checkout-shift-modal-actions">
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => setShowShiftCloseModal(false)}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                    <button
                      className="button button-primary"
                      type="submit"
                      disabled={saving}
                    >
                      {saving ? "Closing…" : "Close shift"}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}
          {(cart.length > 0 || bundleCart.length > 0) && (
            <form
              className="checkout-options"
              onSubmit={(event) => void calculateCheckout(event)}
            >
              <Field id="sale-benefit-type" label="Sale benefit">
                <select
                  id="sale-benefit-type"
                  className="text-input select-input"
                  value={benefitType}
                  onChange={(event) => {
                    const next = event.target.value as typeof benefitType;
                    setBenefitType(next);
                    setCart((current) =>
                      current.map((line) => ({
                        ...line,
                        benefitTreatment:
                          (next !== "REGULAR" &&
                            line.benefitTreatment === "BNPC") ||
                          (next === "SENIOR_CITIZEN" &&
                            line.benefitTreatment === "SENIOR_CITIZEN" &&
                            line.product.isScEligible) ||
                          (next === "PWD" &&
                            line.benefitTreatment === "PWD" &&
                            line.product.isPwdEligible)
                            ? line.benefitTreatment
                            : "REGULAR",
                      })),
                    );
                    setBundleCart((current) =>
                      current.map((bundleLine) => ({
                        ...bundleLine,
                        componentBenefits: Object.fromEntries(
                          bundleLine.offer.components.map((component) => [
                            component.productId,
                            (() => {
                              const treatment =
                                bundleLine.componentBenefits[
                                  component.productId
                                ] ?? "REGULAR";
                              return (next !== "REGULAR" &&
                                treatment === "BNPC") ||
                                (next === "SENIOR_CITIZEN" &&
                                  treatment === "SENIOR_CITIZEN" &&
                                  component.isScEligible) ||
                                (next === "PWD" &&
                                  treatment === "PWD" &&
                                  component.isPwdEligible)
                                ? treatment
                                : "REGULAR";
                            })(),
                          ]),
                        ),
                      })),
                    );
                    invalidatePreview();
                  }}
                >
                  <option value="REGULAR">Regular sale</option>
                  <option value="SENIOR_CITIZEN">Senior citizen</option>
                  <option value="PWD">PWD</option>
                </select>
              </Field>
              {benefitType !== "REGULAR" &&
                cart.some((line) =>
                  benefitType === "SENIOR_CITIZEN"
                    ? line.product.isScEligible
                    : line.product.isPwdEligible,
                ) && (
                  <div className="checkout-benefit-lines">
                    <strong>
                      Choose lines for the standard{" "}
                      {benefitType === "SENIOR_CITIZEN" ? "senior" : "PWD"}{" "}
                      benefit (20% discount + VAT exemption)
                    </strong>
                    {cart
                      .filter((line) =>
                        benefitType === "SENIOR_CITIZEN"
                          ? line.product.isScEligible
                          : line.product.isPwdEligible,
                      )
                      .map((line) => (
                        <label
                          className="inventory-checkbox"
                          key={line.product.id}
                        >
                          <input
                            type="checkbox"
                            checked={line.benefitTreatment === benefitType}
                            onChange={(event) =>
                              setBenefitForLine(
                                line.product.id,
                                event.target.checked ? benefitType : "REGULAR",
                              )
                            }
                          />
                          <span>
                            {line.product.name} · 20% + VAT exemption
                            {(
                              benefitType === "SENIOR_CITIZEN"
                                ? line.product.isScEligible
                                : line.product.isPwdEligible
                            )
                              ? " · eligible"
                              : " · not eligible"}
                          </span>
                        </label>
                      ))}
                  </div>
                )}
              {benefitType !== "REGULAR" &&
                bundleCart.some((bundleLine) =>
                  bundleLine.offer.components.some((component) =>
                    benefitType === "SENIOR_CITIZEN"
                      ? component.isScEligible
                      : component.isPwdEligible,
                  ),
                ) && (
                  <div className="checkout-benefit-lines">
                    <strong>
                      Choose bundle components for the standard{" "}
                      {benefitType === "SENIOR_CITIZEN" ? "senior" : "PWD"}{" "}
                      benefit (20% discount + VAT exemption)
                    </strong>
                    {bundleCart.flatMap((bundleLine) =>
                      bundleLine.offer.components
                        .filter((component) =>
                          benefitType === "SENIOR_CITIZEN"
                            ? component.isScEligible
                            : component.isPwdEligible,
                        )
                        .map((component) => {
                          const eligible =
                            benefitType === "SENIOR_CITIZEN"
                              ? component.isScEligible
                              : component.isPwdEligible;
                          return (
                            <label
                              className="inventory-checkbox"
                              key={`${bundleLine.offerKey}-${component.productId}`}
                            >
                              <input
                                type="checkbox"
                                checked={
                                  bundleLine.componentBenefits[
                                    component.productId
                                  ] === benefitType
                                }
                                disabled={!eligible}
                                onChange={(event) =>
                                  setBundleBenefit(
                                    bundleLine.offerKey,
                                    component.productId,
                                    event.target.checked
                                      ? benefitType
                                      : "REGULAR",
                                  )
                                }
                              />
                              <span>
                                {bundleLine.offer.name} · {component.name} · 20%
                                + VAT exemption
                                {eligible ? " · eligible" : " · not eligible"}
                              </span>
                            </label>
                          );
                        }),
                    )}
                  </div>
                )}
              {bnpcPolicy?.enabled &&
                benefitType !== "REGULAR" &&
                (cart.some((line) => line.product.isBnpcEligible) ||
                  bundleCart.some((bundleLine) =>
                    bundleLine.offer.components.some(
                      (component) => component.isBnpcEligible,
                    ),
                  )) && (
                  <div className="checkout-benefit-lines">
                    <strong>
                      Separate BNPC benefit: 5% discount; VAT remains
                    </strong>
                    <small className="field-hint">
                      BNPC product eligibility works for both senior and PWD
                      holders. It does not use the standard 20% discount or VAT
                      exemption.
                    </small>
                    {cart
                      .filter((line) => line.product.isBnpcEligible)
                      .map((line) => (
                        <label
                          className="inventory-checkbox"
                          key={line.product.id}
                        >
                          <input
                            type="checkbox"
                            checked={line.benefitTreatment === "BNPC"}
                            disabled={!line.product.isBnpcEligible}
                            onChange={(event) =>
                              setBenefitForLine(
                                line.product.id,
                                event.target.checked ? "BNPC" : "REGULAR",
                              )
                            }
                          />
                          <span>
                            {line.product.name} · BNPC 5%{" "}
                            {line.product.isBnpcEligible
                              ? "eligible"
                              : "not eligible"}
                          </span>
                        </label>
                      ))}
                    {bundleCart.flatMap((bundleLine) =>
                      bundleLine.offer.components
                        .filter((component) => component.isBnpcEligible)
                        .map((component) => (
                          <label
                            className="inventory-checkbox"
                            key={`${bundleLine.offerKey}-${component.productId}-bnpc`}
                          >
                            <input
                              type="checkbox"
                              checked={
                                bundleLine.componentBenefits[
                                  component.productId
                                ] === "BNPC"
                              }
                              disabled={!component.isBnpcEligible}
                              onChange={(event) =>
                                setBundleBenefit(
                                  bundleLine.offerKey,
                                  component.productId,
                                  event.target.checked ? "BNPC" : "REGULAR",
                                )
                              }
                            />
                            <span>
                              {bundleLine.offer.name} · {component.name} · BNPC
                              5%{" "}
                              {component.isBnpcEligible
                                ? "eligible"
                                : "not eligible"}
                            </span>
                          </label>
                        )),
                    )}
                  </div>
                )}
              {hasSelectedBenefit && benefitType !== "REGULAR" && (
                <div className="checkout-customer-fields">
                  <Field id="benefit-customer-name" label="Customer name">
                    <input
                      id="benefit-customer-name"
                      className="text-input"
                      value={customerName}
                      onChange={(event) => {
                        setCustomerName(event.target.value);
                        setRequestKey("");
                      }}
                      required
                      minLength={2}
                      maxLength={160}
                    />
                  </Field>
                  <Field id="benefit-customer-birthday" label="Birthday">
                    <input
                      id="benefit-customer-birthday"
                      className="text-input"
                      type="date"
                      value={customerBirthday}
                      onChange={(event) => {
                        setCustomerBirthday(event.target.value);
                        setRequestKey("");
                      }}
                      required
                    />
                  </Field>
                  <Field id="benefit-id-type" label="ID type">
                    <input
                      id="benefit-id-type"
                      className="text-input"
                      value={customerIdType}
                      onChange={(event) => {
                        setCustomerIdType(event.target.value);
                        setRequestKey("");
                      }}
                      required
                      minLength={2}
                      maxLength={60}
                    />
                  </Field>
                  <Field id="benefit-id-number" label="ID number">
                    <input
                      id="benefit-id-number"
                      className="text-input"
                      value={customerIdNumber}
                      onChange={(event) => {
                        setCustomerIdNumber(event.target.value);
                        setRequestKey("");
                      }}
                      required
                      minLength={2}
                      maxLength={80}
                    />
                  </Field>
                  <label className="inventory-checkbox">
                    <input
                      type="checkbox"
                      checked={customerIdChecked}
                      onChange={(event) => {
                        setCustomerIdChecked(event.target.checked);
                        setRequestKey("");
                      }}
                    />
                    <span>I checked the physical ID</span>
                  </label>
                </div>
              )}
              {bnpcPolicy && !bnpcPolicy.enabled && (
                <small className="field-hint">
                  {bnpcPolicy.discountRateBasisPoints !== 500
                    ? `BNPC is disabled because the saved rate is ${bnpcPolicy.discountRateBasisPoints / 100}%. Ask an owner to save a new policy version at the fixed 5% rate.`
                    : "BNPC is disabled pending the current policy review, store eligibility decision, and owner/accountant approval."}
                </small>
              )}
              {hasBnpc && benefitType !== "REGULAR" && (
                <div className="checkout-customer-fields">
                  <strong>BNPC booklet and prior usage</strong>
                  <p className="field-hint">
                    The allowance shown is local to this register. Medtryx
                    cannot see purchases at other stores or online; staff must
                    verify booklet amounts covering all channels.
                  </p>
                  <Field
                    id="bnpc-external-purchase"
                    label="Prior covered purchases elsewhere this Manila week (PHP)"
                  >
                    <input
                      id="bnpc-external-purchase"
                      className="text-input"
                      inputMode="decimal"
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                      value={bnpcExternalPurchase}
                      onChange={(event) => {
                        setBnpcExternalPurchase(event.target.value);
                        setRequestKey("");
                      }}
                    />
                  </Field>
                  <Field
                    id="bnpc-external-discount"
                    label="Prior BNPC discounts used elsewhere this Manila week (PHP)"
                  >
                    <input
                      id="bnpc-external-discount"
                      className="text-input"
                      inputMode="decimal"
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                      value={bnpcExternalDiscount}
                      onChange={(event) => {
                        setBnpcExternalDiscount(event.target.value);
                        setRequestKey("");
                      }}
                    />
                  </Field>
                  <label className="inventory-checkbox">
                    <input
                      type="checkbox"
                      required
                      checked={bnpcBookletChecked}
                      onChange={(event) => {
                        setBnpcBookletChecked(event.target.checked);
                        setRequestKey("");
                      }}
                    />
                    <span>I checked the current booklet.</span>
                  </label>
                  <label className="inventory-checkbox">
                    <input
                      type="checkbox"
                      required
                      checked={bnpcPriorPurchaseConfirmed}
                      onChange={(event) => {
                        setBnpcPriorPurchaseConfirmed(event.target.checked);
                        setRequestKey("");
                      }}
                    />
                    <span>
                      I confirmed prior purchase and discount amounts against
                      the booklet and customer information.
                    </span>
                  </label>
                  <label className="inventory-checkbox">
                    <input
                      type="checkbox"
                      checked={bnpcRepresentativePurchase}
                      onChange={(event) => {
                        const isRepresentative = event.target.checked;
                        setBnpcRepresentativePurchase(isRepresentative);
                        if (!isRepresentative) {
                          setBnpcPrescriptionApplicable(false);
                          setBnpcPrescriptionChecked(false);
                        }
                        setRequestKey("");
                      }}
                    />
                    <span>This purchase is through a representative.</span>
                  </label>
                  {bnpcRepresentativePurchase && (
                    <>
                      <Field
                        id="bnpc-authorization-date"
                        label="Authorization letter issue date"
                      >
                        <input
                          id="bnpc-authorization-date"
                          className="text-input"
                          type="date"
                          required
                          value={bnpcAuthorizationLetterDate}
                          onChange={(event) => {
                            setBnpcAuthorizationLetterDate(event.target.value);
                            setRequestKey("");
                          }}
                        />
                      </Field>
                      <label className="inventory-checkbox">
                        <input
                          type="checkbox"
                          required
                          checked={bnpcRepresentativeDocsChecked}
                          onChange={(event) => {
                            setBnpcRepresentativeDocsChecked(
                              event.target.checked,
                            );
                            setRequestKey("");
                          }}
                        />
                        <span>
                          I checked the required representative and holder IDs,
                          booklet, and authorization documents.
                        </span>
                      </label>
                      <label className="inventory-checkbox">
                        <input
                          type="checkbox"
                          checked={bnpcPrescriptionApplicable}
                          onChange={(event) => {
                            setBnpcPrescriptionApplicable(event.target.checked);
                            if (!event.target.checked) {
                              setBnpcPrescriptionChecked(false);
                            }
                            setRequestKey("");
                          }}
                        />
                        <span>
                          A medical prescription applies to this representative
                          purchase, if required.
                        </span>
                      </label>
                      {bnpcPrescriptionApplicable && (
                        <label className="inventory-checkbox">
                          <input
                            type="checkbox"
                            required
                            checked={bnpcPrescriptionChecked}
                            onChange={(event) => {
                              setBnpcPrescriptionChecked(event.target.checked);
                              setRequestKey("");
                            }}
                          />
                          <span>I checked the applicable prescription.</span>
                        </label>
                      )}
                    </>
                  )}
                  <label className="inventory-checkbox">
                    <input
                      type="checkbox"
                      checked={bnpcFourKindsChecked}
                      onChange={(event) => {
                        setBnpcFourKindsChecked(event.target.checked);
                        setRequestKey("");
                      }}
                    />
                    <span>
                      I verified the four-kind condition from the booklet if
                      this purchase reaches the full weekly purchase cap.
                    </span>
                  </label>
                </div>
              )}
              <Field id="sale-payment-method" label="Payment declaration">
                <select
                  id="sale-payment-method"
                  className="text-input select-input"
                  value={paymentMethod}
                  onChange={(event) => {
                    setPaymentMethod(
                      event.target.value as typeof paymentMethod,
                    );
                    setRequestKey("");
                    setPreview(null);
                  }}
                >
                  <option value="CASH">Cash</option>
                  <option value="QR">QR (staff declaration only)</option>
                </select>
              </Field>
              <button
                className="button button-primary"
                type="submit"
                disabled={saving}
              >
                {saving ? "Calculating…" : "Calculate line taxes and discounts"}
              </button>
            </form>
          )}
          {preview && (
            <div className="checkout-preview">
              <h3>Server calculation</h3>
              {preview.policyNotice && (
                <p className="checkout-policy-warning">
                  {preview.policyNotice}
                </p>
              )}
              {preview.bundles.map((bundle) => (
                <div className="bundle-preview-summary" key={bundle.offerKey}>
                  <strong>
                    {bundle.name} · {bundle.code} · v{bundle.version}
                  </strong>
                  <span>
                    Regular components ₱{bundle.regularTotal} · advertised ₱
                    {bundle.promotionalPricePerBundle} × {bundle.quantity} ·
                    promotion actually applied ₱
                    {bundle.promotionalDiscountApplied}
                  </span>
                  <small>
                    When a component receives a better SC/PWD treatment, that
                    statutory result replaces its allocated bundle reduction.
                    The final amount can differ from the advertised price.
                  </small>
                </div>
              ))}
              <div className="checkout-preview-lines">
                {preview.lines.map((line) => (
                  <div
                    key={`${line.bundle?.offerKey ?? "product"}-${line.productId}`}
                  >
                    {line.bundle && (
                      <small>
                        Regular ₱{line.bundle.regularGross}; allocated promotion
                        ₱{line.bundle.allocatedPromotionDiscount}; promotion
                        outcome ₱{line.bundle.promotionAlternativeAmountDue};
                        statutory outcome ₱
                        {line.bundle.statutoryAlternativeAmountDue}; selected{" "}
                        {line.bundle.promotionSelected
                          ? "promotion"
                          : line.bundle.selectedStatutoryTreatment}
                      </small>
                    )}
                    <strong>
                      {line.name} × {line.quantity}
                    </strong>
                    <small>
                      Tax basis ₱{line.taxBasis} · VAT ₱{line.vat}
                      {centsFromMoney(line.vatRemoved) > 0n
                        ? ` · VAT removed ₱${line.vatRemoved}`
                        : ""}{" "}
                      · discount ₱{line.discount}
                    </small>
                    {centsFromMoney(line.bnpcDiscount) > 0n && (
                      <small>BNPC discount ₱{line.bnpcDiscount}</small>
                    )}
                    {line.assignedLots.length > 0 && (
                      <small>
                        FEFO pick:{" "}
                        {line.assignedLots
                          .map(
                            (lot) =>
                              `${lot.lotCode} · exp ${lot.expiryDate} · ${lot.quantity}`,
                          )
                          .join("; ")}
                      </small>
                    )}
                    <span>Line due ₱{line.amountDue}</span>
                  </div>
                ))}
              </div>
              <div className="checkout-preview-total">
                <span>
                  {preview.paymentMethod === "CASH" &&
                  preview.policy.cashRoundingMode === "NEAREST_25_CENTAVOS"
                    ? "Rounded cash total"
                    : "Amount due"}
                </span>
                <strong>₱{preview.totals.amountDue}</strong>
              </div>
              {hasTrackedCart && (
                <label className="inventory-checkbox">
                  <input
                    type="checkbox"
                    checked={lotPickConfirmed}
                    onChange={(event) =>
                      setLotPickConfirmed(event.target.checked)
                    }
                  />
                  <span>
                    I picked and physically confirmed the FEFO lot(s) shown
                    above
                  </span>
                </label>
              )}
              {preview.paymentMethod === "CASH" &&
                preview.policy.cashRoundingMode === "NEAREST_25_CENTAVOS" && (
                  <small className="field-hint checkout-rounding-note">
                    Line total before cash rounding: ₱
                    {preview.totals.amountBeforeCashRounding} · cash rounding
                    adjustment:{" "}
                    {formatCents(
                      centsFromMoney(preview.totals.cashRoundingAdjustment),
                    )}
                    . Tax calculations are unchanged.
                  </small>
                )}
              <button
                className="button button-primary"
                type="button"
                disabled={
                  saving ||
                  !policy?.approved ||
                  !shift ||
                  !requestKey ||
                  (hasTrackedCart && !lotPickConfirmed)
                }
                onClick={() => void finalizeSale()}
              >
                {saving ? "Saving…" : "Confirm sale"}
              </button>
              {!policy?.approved && (
                <small className="field-hint">
                  Finalization is locked while the policy is provisional.
                </small>
              )}
              {!shift && (
                <small className="field-hint">
                  Open a cashier shift before confirming a sale.
                </small>
              )}
            </div>
          )}
          {saleRecord && (
            <div className="sale-saved-card" role="status">
              <strong>{saleRecord.label}</strong>
              <span>{saleRecord.transactionId}</span>
              <span>
                ₱{saleRecord.amountDue} ·{" "}
                {saleRecord.paymentMethod === "QR" ? "QR declared" : "Cash"}
              </span>
              {saleRecord.cashRoundingMode === "NEAREST_25_CENTAVOS" &&
                saleRecord.paymentMethod === "CASH" &&
                saleRecord.cashRoundingAdjustment !== "0.00" && (
                  <span>
                    Cash rounding adjustment
                    {formatCents(
                      centsFromMoney(saleRecord.cashRoundingAdjustment),
                    )}
                  </span>
                )}
            </div>
          )}
        </aside>
      </div>
      <RecentTransactions
        refundShift={shift ?? registerShift}
        refreshKey={recentSalesRefresh}
        onUpdated={refreshShiftState}
      />
    </section>
  );
}
