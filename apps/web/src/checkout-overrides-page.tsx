import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowDownToLine, Check, Search } from "lucide-react";
import { api } from "./api";

type OverrideRecord = {
  id: string;
  saleId: string;
  transactionId: string;
  businessDate: string;
  createdAt: string;
  cashierUserId: string;
  cashierEmail: string;
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  recordedQuantity: number;
  physicalQuantity: number;
  correctionQuantity: number;
  saleQuantity: number;
  reasonCategory: string;
  reason: string;
  costSourceType: string;
  costSourceEventId: string | null;
  costSourceSequence: number | null;
  estimatedCost: boolean;
  unitCostCentavos: number;
  inventoryValueDeltaCentavos: number;
  stockEventId: string;
  policyVersion: number;
  reviewStatus: "REVIEWED" | "UNREVIEWED";
  reviewerEmail: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  lots: Array<{
    lotCode: string;
    expiryDate: string;
    recordedQuantity: number;
    physicalQuantity: number;
    correctionQuantity: number;
    saleQuantity: number;
  }>;
};

type ProductOption = { id: string; sku: string; name: string };

function pesoFromCentavos(value: number): string {
  return `₱${(value / 100).toFixed(2)}`;
}

function manilaDateTime(value: string): string {
  return new Date(value).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function CheckoutOverridesPage() {
  const [records, setRecords] = useState<OverrideRecord[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [productId, setProductId] = useState("");
  const [cashierUserId, setCashierUserId] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const cashiers = useMemo(
    () =>
      [
        ...new Map(
          records.map((record) => [record.cashierUserId, record.cashierEmail]),
        ),
      ]
        .map(([id, email]) => ({ id, email }))
        .sort((left, right) => left.email.localeCompare(right.email)),
    [records],
  );

  function filterQuery() {
    const query = new URLSearchParams();
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (productId) query.set("productId", productId);
    if (cashierUserId) query.set("cashierUserId", cashierUserId);
    return query;
  }

  async function loadOverrides(query = filterQuery()) {
    setLoading(true);
    setError("");
    try {
      const result = await api.get<{ records: OverrideRecord[] }>(
        `/checkout-stock-overrides${query.size ? `?${query}` : ""}`,
      );
      setRecords(result.records);
    } catch {
      setError("Unable to load checkout count override history.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<{ products: ProductOption[] }>("/products"),
      api.get<{ records: OverrideRecord[] }>("/checkout-stock-overrides"),
    ])
      .then(([productResult, historyResult]) => {
        if (!active) return;
        setProducts(productResult.products);
        setRecords(historyResult.records);
      })
      .catch(() => {
        if (active) setError("Unable to load checkout count override history.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function review(record: OverrideRecord) {
    const status =
      record.reviewStatus === "REVIEWED" ? "UNREVIEWED" : "REVIEWED";
    const note = notes[record.id]?.trim();
    setSavingId(record.id);
    setError("");
    setNotice("");
    try {
      await api.post(`/checkout-stock-overrides/${record.id}/review`, {
        status,
        ...(note ? { note } : {}),
      });
      setNotice(
        status === "REVIEWED"
          ? "Override marked as reviewed."
          : "Override returned to unreviewed.",
      );
      await loadOverrides();
    } catch {
      setError("Unable to update the review status.");
    } finally {
      setSavingId("");
    }
  }

  const exportHref = `/api/checkout-stock-overrides.csv${filterQuery().size ? `?${filterQuery()}` : ""}`;

  return (
    <section className="page-section inventory-page checkout-overrides-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">OWNER INVENTORY</span>
          <h1>Checkout count overrides</h1>
          <p>
            Review the physical count evidence, inventory correction, and sale
            saved together.
          </p>
        </div>
        <Link className="button button-secondary" to="/stock">
          Back to stock
        </Link>
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
      <section className="settings-main-card checkout-override-filters">
        <div className="checkout-override-filter-fields">
          <label className="inventory-field">
            <span>From business date</span>
            <input
              className="text-input"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="inventory-field">
            <span>To business date</span>
            <input
              className="text-input"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label className="inventory-field">
            <span>Product</span>
            <select
              className="text-input select-input"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="">All products</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.sku} · {product.name}
                </option>
              ))}
            </select>
          </label>
          <label className="inventory-field">
            <span>Cashier</span>
            <select
              className="text-input select-input"
              value={cashierUserId}
              onChange={(event) => setCashierUserId(event.target.value)}
            >
              <option value="">All cashiers</option>
              {cashiers.map((cashier) => (
                <option key={cashier.id} value={cashier.id}>
                  {cashier.email}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="checkout-override-filter-actions">
          <button
            className="button button-primary"
            type="button"
            onClick={() => void loadOverrides()}
            disabled={loading}
          >
            <Search size={15} /> Apply filters
          </button>
          <a className="button button-secondary" href={exportHref}>
            <ArrowDownToLine size={15} /> Export CSV
          </a>
        </div>
      </section>
      <section className="settings-main-card checkout-override-history">
        <div className="card-heading">
          <div>
            <h2>Saved corrections</h2>
            <p>{records.length} override records</p>
          </div>
        </div>
        {loading ? (
          <div className="table-loading">Loading override history…</div>
        ) : records.length ? (
          <div className="checkout-override-list">
            {records.map((record) => (
              <article className="checkout-override-record" key={record.id}>
                <header>
                  <div>
                    <strong>{record.productName}</strong>
                    <small>
                      {record.sku} · {record.unit} · {record.cashierEmail} ·{" "}
                      {manilaDateTime(record.createdAt)}
                    </small>
                  </div>
                  <span
                    className={`checkout-override-review-status ${record.reviewStatus === "REVIEWED" ? "is-reviewed" : "is-unreviewed"}`}
                  >
                    {record.reviewStatus === "REVIEWED"
                      ? "Reviewed"
                      : "Unreviewed"}
                  </span>
                </header>
                <div className="checkout-override-record-links">
                  <Link
                    to={`/sales?transactionId=${encodeURIComponent(record.transactionId)}`}
                  >
                    Sale {record.transactionId} · {record.businessDate}
                  </Link>
                  <Link
                    to={`/stock?productId=${encodeURIComponent(record.productId)}`}
                  >
                    Stock event {record.stockEventId.slice(0, 8)}
                  </Link>
                </div>
                <div className="checkout-override-count-grid">
                  <span>
                    Recorded<strong>{record.recordedQuantity}</strong>
                  </span>
                  <span>
                    Verified<strong>{record.physicalQuantity}</strong>
                  </span>
                  <span>
                    Correction<strong>+{record.correctionQuantity}</strong>
                  </span>
                  <span>
                    Sold<strong>{record.saleQuantity}</strong>
                  </span>
                </div>
                {record.lots.length > 0 && (
                  <div className="checkout-override-lots">
                    {record.lots.map((lot) => (
                      <small key={`${lot.lotCode}-${lot.expiryDate}`}>
                        {lot.lotCode} · exp {lot.expiryDate}:{" "}
                        {lot.recordedQuantity} → {lot.physicalQuantity}; +
                        {lot.correctionQuantity}; sold {lot.saleQuantity}
                      </small>
                    ))}
                  </div>
                )}
                <p className="checkout-override-reason">
                  <strong>{record.reasonCategory.replaceAll("_", " ")}</strong>{" "}
                  · {record.reason}
                </p>
                <div className="checkout-override-cost">
                  <span>
                    Cost basis:{" "}
                    {record.costSourceType === "WEIGHTED_AVERAGE"
                      ? "Current weighted average"
                      : `${record.costSourceType} event ${record.costSourceEventId ?? ""}`}
                    {record.estimatedCost ? " · estimated" : ""}
                  </span>
                  <span>
                    {pesoFromCentavos(record.unitCostCentavos)} each ·{" "}
                    {pesoFromCentavos(record.inventoryValueDeltaCentavos)} added
                  </span>
                </div>
                {record.reviewStatus === "REVIEWED" && (
                  <small className="checkout-override-reviewer">
                    Reviewed by {record.reviewerEmail ?? "owner"} ·{" "}
                    {record.reviewedAt ? manilaDateTime(record.reviewedAt) : ""}
                    {record.reviewNote ? ` · ${record.reviewNote}` : ""}
                  </small>
                )}
                <div className="checkout-override-review-actions">
                  <input
                    className="text-input"
                    aria-label={`Review note for ${record.productName}`}
                    maxLength={500}
                    placeholder="Optional review note"
                    value={notes[record.id] ?? record.reviewNote ?? ""}
                    onChange={(event) =>
                      setNotes((current) => ({
                        ...current,
                        [record.id]: event.target.value,
                      }))
                    }
                  />
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => void review(record)}
                    disabled={savingId === record.id}
                  >
                    <Check size={15} />{" "}
                    {savingId === record.id
                      ? "Saving…"
                      : record.reviewStatus === "REVIEWED"
                        ? "Mark unreviewed"
                        : "Mark reviewed"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="table-loading">
            No checkout count overrides match these filters.
          </div>
        )}
      </section>
    </section>
  );
}
