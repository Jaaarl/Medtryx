import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  CirclePlus,
  Package,
  Search,
  ShoppingCart,
  X,
} from "lucide-react";
import { api, ApiError } from "./api";

type Product = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  unit: string;
  sellingPrice: string;
  taxClass: "VATABLE" | "VAT_EXEMPT" | "ZERO_RATED";
  scPwdEligible: boolean;
  quantityOnHand: number;
  reorderLevel: number | null;
  active: boolean;
  latestAcquisitionCost: string | null;
  weightedAverageUnitCost: string;
  inventoryValue: string;
  unitPriceSpread: string;
  estimatedUnitGrossProfit: string;
  grossProfitEstimateApproved: boolean;
  grossProfitEstimateNote: string;
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
  | "scPwdEligible"
> & { quantityAvailable: number };

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
  reason: string | null;
  actorEmail: string | null;
  createdAt: string;
};

const EMPTY_FORM = {
  sku: "",
  name: "",
  barcode: "",
  unit: "piece",
  sellingPrice: "",
  taxClass: "VATABLE" as Product["taxClass"],
  scPwdEligible: false,
  openingQuantity: "0",
  openingUnitCost: "",
  openingZeroCostReason: "",
  reorderLevel: "",
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
    unit_locked_after_stock_history:
      "A product unit cannot change after stock history exists.",
    insufficient_stock: "The adjustment would reduce stock below zero.",
    inventory_value_overflow:
      "The resulting stock value is outside the supported range.",
  };
  return (
    messages[error.code] ?? "The request was rejected. Refresh and try again."
  );
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
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? "−" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}₱${(absolute / 100n).toLocaleString("en-PH")}.${String(absolute % 100n).padStart(2, "0")}`;
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

export function ProductsPage() {
  const { products, loading, error, setError, refresh } = useProducts();
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
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
      sku: product.sku,
      name: product.name,
      barcode: product.barcode ?? "",
      unit: product.unit,
      sellingPrice: product.sellingPrice,
      taxClass: product.taxClass,
      scPwdEligible: product.scPwdEligible,
      reorderLevel:
        product.reorderLevel === null ? "" : String(product.reorderLevel),
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
      barcode: form.barcode || null,
      unit: form.unit,
      sellingPrice: form.sellingPrice,
      taxClass: form.taxClass,
      scPwdEligible: form.scPwdEligible,
      reorderLevel: form.reorderLevel === "" ? null : Number(form.reorderLevel),
    };
    try {
      if (editing) {
        await api.patch(`/products/${editing.id}`, common);
        setNotice("Product changes saved.");
      } else {
        const body = {
          ...common,
          ...(form.sku.trim() ? { sku: form.sku.trim() } : {}),
          openingQuantity: Number(form.openingQuantity),
          ...(Number(form.openingQuantity) > 0
            ? { openingUnitCost: form.openingUnitCost }
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
          <div className="inventory-table-wrap">
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
                          {product.barcode
                            ? ` · ${product.barcode}`
                            : ""} · {product.unit}
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
                        : "No products yet. Add the first SKU using the form."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="inventory-estimate-note">
            <AlertTriangle size={14} />
            <span>
              Gross-profit estimates use a provisional 12% VAT assumption and
              are not approved accounting figures. Supplier-cost basis and tax
              rules need owner/accountant approval.
            </span>
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
            {!editing && (
              <Field id="product-sku" label="SKU (leave blank to generate)">
                <input
                  id="product-sku"
                  className="text-input"
                  value={form.sku}
                  onChange={(event) =>
                    setForm({ ...form, sku: event.target.value })
                  }
                  maxLength={48}
                />
              </Field>
            )}
            {editing && (
              <div className="product-edit-sku">
                SKU <strong>{editing.sku}</strong>
              </div>
            )}
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
            <div className="inventory-two-fields">
              <Field id="product-barcode" label="Barcode (optional)">
                <input
                  id="product-barcode"
                  className="text-input"
                  value={form.barcode}
                  onChange={(event) =>
                    setForm({ ...form, barcode: event.target.value })
                  }
                  maxLength={80}
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
            </div>
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
            <div className="inventory-two-fields">
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
                  <option value="ZERO_RATED" disabled>
                    Zero rated (approval required)
                  </option>
                </select>
              </Field>
              <Field id="product-reorder" label="Reorder at">
                <input
                  id="product-reorder"
                  className="text-input"
                  type="number"
                  min="0"
                  step="1"
                  value={form.reorderLevel}
                  onChange={(event) =>
                    setForm({ ...form, reorderLevel: event.target.value })
                  }
                  placeholder="Optional"
                />
              </Field>
            </div>
            <label className="inventory-checkbox">
              <input
                type="checkbox"
                checked={form.scPwdEligible}
                onChange={(event) =>
                  setForm({ ...form, scPwdEligible: event.target.checked })
                }
              />
              <span>Eligible for SC/PWD benefit rules</span>
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
  const [adjustQty, setAdjustQty] = useState("");
  const [reasonType, setReasonType] = useState("COUNT_CORRECTION");
  const [reason, setReason] = useState("");
  const [adjustCost, setAdjustCost] = useState("");
  const [adjustZeroCostReason, setAdjustZeroCostReason] = useState("");
  const selected = products.find((product) => product.id === selectedId);
  const filteredProducts = lowOnly
    ? products.filter(
        (product) =>
          product.reorderLevel !== null &&
          product.quantityOnHand <= product.reorderLevel,
      )
    : products;

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
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<{ products: Product[] }>("/products"),
      api.get<{ events: StockEvent[] }>("/stock/events"),
    ])
      .then(([productData, eventData]) => {
        if (!active) return;
        setProducts(productData.products);
        setEvents(eventData.events);
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
        ...(centsFromMoney(receiptCost) === 0n
          ? { zeroCostReason: zeroCostReason.trim() }
          : {}),
      });
      await Promise.all([refreshProducts(), refreshEvents(selected.id)]);
      setNotice(
        `Received ${receiptQty} ${selected.unit} for ${selected.name}.`,
      );
      setReceiptQty("1");
      setReceiptCost("");
      setReference("");
      setZeroCostReason("");
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
        ...(quantityDelta > 0 && centsFromMoney(adjustCost) === 0n
          ? { zeroCostReason: adjustZeroCostReason.trim() }
          : {}),
      });
      await Promise.all([refreshProducts(), refreshEvents(selected.id)]);
      setNotice(`Stock adjustment recorded for ${selected.name}.`);
      setAdjustQty("");
      setReason("");
      setAdjustCost("");
      setAdjustZeroCostReason("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
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
                  disabled={saving}
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
      <section className="activity-card stock-history-card">
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

type CartLine = { product: CatalogProduct; quantity: number };

export function CheckoutPage() {
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
  const total = useMemo(
    () =>
      cart.reduce(
        (sum, line) =>
          sum +
          centsFromMoney(line.product.sellingPrice) * BigInt(line.quantity),
        0n,
      ),
    [cart],
  );
  function addProduct(product: CatalogProduct) {
    if (product.quantityAvailable <= 0) return;
    setCart((current) => {
      const line = current.find((entry) => entry.product.id === product.id);
      if (line)
        return current.map((entry) =>
          entry.product.id === product.id
            ? {
                ...entry,
                quantity: Math.min(
                  product.quantityAvailable,
                  entry.quantity + 1,
                ),
              }
            : entry,
        );
      return [...current, { product, quantity: 1 }];
    });
  }
  function setQuantity(productId: string, quantity: number) {
    setCart((current) =>
      current.flatMap((line) =>
        line.product.id !== productId
          ? [line]
          : quantity < 1
            ? []
            : [
                {
                  ...line,
                  quantity: Math.min(line.product.quantityAvailable, quantity),
                },
              ],
      ),
    );
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
                      {product.barcode ? ` · ${product.barcode}` : ""}
                    </small>
                    <span>
                      ₱{product.sellingPrice} · {product.quantityAvailable}{" "}
                      available
                    </span>
                  </div>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={product.quantityAvailable <= 0}
                    onClick={() => addProduct(product)}
                  >
                    {product.quantityAvailable ? "Add to cart" : "Out of stock"}
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
        </section>
        <aside className="settings-main-card cart-card">
          <div className="card-heading inventory-card-heading">
            <div>
              <h2>Current cart</h2>
              <p>
                Items and quantities are held in this browser until checkout.
              </p>
            </div>
            <span className="activity-icon">
              <ShoppingCart size={17} />
            </span>
          </div>
          {cart.length ? (
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
                      <span>{line.quantity}</span>
                      <button
                        className="icon-button"
                        aria-label={`Add one ${line.product.name}`}
                        disabled={
                          line.quantity >= line.product.quantityAvailable
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
              </div>
              <div className="cart-total">
                <span>Cart total</span>
                <strong>{formatCents(total)}</strong>
              </div>
            </>
          ) : (
            <div className="cart-empty">
              <span className="empty-icon">
                <ShoppingCart size={22} />
              </span>
              <strong>Your cart is empty</strong>
              <small>Search the catalog and add an active product.</small>
            </div>
          )}
          <div className="checkout-next-note">
            Sale calculation and finalization will be enabled with the checkout
            and tax bundle.
          </div>
        </aside>
      </div>
    </section>
  );
}
