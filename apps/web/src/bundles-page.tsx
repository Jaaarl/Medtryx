import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api } from "./api";

type ComponentLine = { productId: string; quantity: number };
type ProductChoice = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  sellingPrice: string;
};
type BundleView = {
  id: string;
  versionId: string;
  version: number;
  code: string;
  name: string;
  active: boolean;
  activeFrom: string;
  activeUntil: string | null;
  maxQuantityPerSale: number | null;
  reductionType: "PERCENT" | "AMOUNT";
  reductionValue: number;
  suggestedPromotionalPrice: string;
  promotionalPrice: string;
  components: Array<{
    productId: string;
    quantity: number;
    sku: string;
    name: string;
    unit: string;
    regularUnitPrice: string;
  }>;
};

function todayInManila(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function centsFromMoney(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return (
    BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0")
  );
}

function moneyFromCents(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

function percentageBasisPoints(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) return 0;
  return Math.round(parsed * 100);
}

export function BundlesPage() {
  const [products, setProducts] = useState<ProductChoice[]>([]);
  const [bundles, setBundles] = useState<BundleView[]>([]);
  const [editingId, setEditingId] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [activeFrom, setActiveFrom] = useState(todayInManila);
  const [activeUntil, setActiveUntil] = useState("");
  const [maxQuantity, setMaxQuantity] = useState("");
  const [reductionType, setReductionType] = useState<"PERCENT" | "AMOUNT">(
    "PERCENT",
  );
  const [reductionValue, setReductionValue] = useState("10");
  const [promotionalPrice, setPromotionalPrice] = useState("");
  const [priceOverridden, setPriceOverridden] = useState(false);
  const [components, setComponents] = useState<ComponentLine[]>([
    { productId: "", quantity: 1 },
    { productId: "", quantity: 1 },
  ]);
  const [confirmPrice, setConfirmPrice] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function reload() {
    const [catalog, result] = await Promise.all([
      api.get<{ products: ProductChoice[] }>("/catalog"),
      api.get<{ bundles: BundleView[] }>("/bundles/manage"),
    ]);
    setProducts(catalog.products);
    setBundles(result.bundles);
  }

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<{ products: ProductChoice[] }>("/catalog"),
      api.get<{ bundles: BundleView[] }>("/bundles/manage"),
    ])
      .then(([catalog, result]) => {
        if (!active) return;
        setProducts(catalog.products);
        setBundles(result.bundles);
      })
      .catch(() => {
        if (active) setError("Unable to load bundle settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const pricing = useMemo(() => {
    const selected = components.map((component) => ({
      component,
      product: products.find((product) => product.id === component.productId),
    }));
    if (selected.some((entry) => !entry.product)) return null;
    const total = selected.reduce(
      (sum, entry) =>
        sum +
        centsFromMoney(entry.product!.sellingPrice) *
          BigInt(entry.component.quantity),
      0n,
    );
    const reduction =
      reductionType === "PERCENT"
        ? (total * BigInt(percentageBasisPoints(reductionValue)) + 5_000n) /
          10_000n
        : centsFromMoney(reductionValue || "0");
    const suggested = total - reduction;
    return { total, suggested };
  }, [components, products, reductionType, reductionValue]);
  const calculatedPromotionalPrice =
    pricing && pricing.suggested > 0n
      ? moneyFromCents(pricing.suggested)
      : "";
  const finalPromotionalPrice = priceOverridden
    ? promotionalPrice.trim()
    : calculatedPromotionalPrice;

  function clearForm() {
    setEditingId("");
    setCode("");
    setName("");
    setActiveFrom(todayInManila());
    setActiveUntil("");
    setMaxQuantity("");
    setReductionType("PERCENT");
    setReductionValue("10");
    setPromotionalPrice("");
    setPriceOverridden(false);
    setComponents([
      { productId: "", quantity: 1 },
      { productId: "", quantity: 1 },
    ]);
    setConfirmPrice(false);
  }

  function editBundle(bundle: BundleView) {
    setEditingId(bundle.id);
    setCode(bundle.code);
    setName(bundle.name);
    setActiveFrom(bundle.activeFrom);
    setActiveUntil(bundle.activeUntil ?? "");
    setMaxQuantity(bundle.maxQuantityPerSale?.toString() ?? "");
    setReductionType(bundle.reductionType);
    setReductionValue(
      bundle.reductionType === "PERCENT"
        ? (bundle.reductionValue / 100).toFixed(2).replace(/\.00$/, "")
        : moneyFromCents(BigInt(bundle.reductionValue)),
    );
    setPromotionalPrice(bundle.promotionalPrice);
    setPriceOverridden(
      bundle.promotionalPrice !== bundle.suggestedPromotionalPrice,
    );
    setComponents(
      bundle.components.map(({ productId, quantity }) => ({
        productId,
        quantity,
      })),
    );
    setConfirmPrice(false);
  }

  function setComponent(index: number, update: Partial<ComponentLine>) {
    setConfirmPrice(false);
    setComponents((current) =>
      current.map((component, entryIndex) =>
        entryIndex === index ? { ...component, ...update } : component,
      ),
    );
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (components.length < 2 || !confirmPrice || !finalPromotionalPrice) {
      setError(
        "Choose at least two products and explicitly approve a final promotional price.",
      );
      return;
    }
    const reduction =
      reductionType === "PERCENT"
        ? percentageBasisPoints(reductionValue)
        : Number(centsFromMoney(reductionValue || "0"));
    if (reduction <= 0) {
      setError("Enter a valid percentage or amount reduction.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        code: code.trim(),
        name: name.trim(),
        activeFrom,
        activeUntil: activeUntil || null,
        maxQuantityPerSale: maxQuantity ? Number(maxQuantity) : null,
        reductionType,
        reductionValue: reduction,
        promotionalPrice: finalPromotionalPrice,
        confirmFinalPrice: true,
        components,
      };
      const result = editingId
        ? await api.patch<{
            pricing: {
              regularTotal: string;
              suggestedPromotionalPrice: string;
              approvedPromotionalPrice: string;
            };
          }>(`/bundles/${editingId}`, payload)
        : await api.post<{
            pricing: {
              regularTotal: string;
              suggestedPromotionalPrice: string;
              approvedPromotionalPrice: string;
            };
          }>("/bundles", payload);
      await reload();
      setNotice(
        `Version saved. Current component total ${result.pricing.regularTotal}; suggestion ${result.pricing.suggestedPromotionalPrice}; approved offer ${result.pricing.approvedPromotionalPrice}.`,
      );
      clearForm();
    } catch {
      setError(
        "Bundle could not be saved. Check the code, dates, current prices, and component products.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function setActive(bundle: BundleView, active: boolean) {
    setError("");
    setNotice("");
    try {
      await api.post(`/bundles/${bundle.id}/active`, { active });
      await reload();
      setNotice(
        active ? "Bundle offer activated." : "Bundle offer deactivated.",
      );
    } catch {
      setError("Bundle status could not be changed.");
    }
  }

  if (loading)
    return (
      <section className="page-section inventory-page">
        <div className="table-loading">Loading bundle settings…</div>
      </section>
    );

  return (
    <section className="page-section inventory-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">OWNER WORKSPACE</span>
          <h1>Virtual sales bundles</h1>
          <p>
            Offers expand to their component products at checkout. Bundle offers
            have no independent stock.
          </p>
        </div>
      </header>
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
      <div className="settings-main-card">
        <div className="card-heading inventory-card-heading">
          <div>
            <h2>
              {editingId
                ? "Create an approved version"
                : "Create a bundle offer"}
            </h2>
            <p>
              The saved promotional price is owner-approved. Edits create a new
              immutable version.
            </p>
          </div>
        </div>
        <form
          className="form-stack inventory-form"
          onSubmit={(event) => void save(event)}
        >
          {editingId && (
            <p role="status">
              Editing a new version of {code}. Earlier versions stay in sale
              history.
            </p>
          )}
          <div className="bundle-form-grid">
            <label className="inventory-field">
              <span>Bundle code</span>
              <input
                className="text-input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                maxLength={48}
              />
            </label>
            <label className="inventory-field">
              <span>Bundle name</span>
              <input
                className="text-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={160}
              />
            </label>
            <label className="inventory-field">
              <span>Active from (Manila date)</span>
              <input
                className="text-input"
                type="date"
                value={activeFrom}
                onChange={(event) => setActiveFrom(event.target.value)}
                required
              />
            </label>
            <label className="inventory-field">
              <span>Active until (optional)</span>
              <input
                className="text-input"
                type="date"
                value={activeUntil}
                onChange={(event) => setActiveUntil(event.target.value)}
              />
            </label>
            <label className="inventory-field">
              <span>Maximum quantity per sale</span>
              <input
                className="text-input"
                type="number"
                min="1"
                max="1000"
                value={maxQuantity}
                onChange={(event) => setMaxQuantity(event.target.value)}
                placeholder="No per-sale limit"
              />
            </label>
            <label className="inventory-field">
              <span>Suggested reduction rule</span>
              <select
                className="text-input select-input"
                value={reductionType}
                onChange={(event) => {
                  setReductionType(event.target.value as "PERCENT" | "AMOUNT");
                  setConfirmPrice(false);
                }}
              >
                <option value="PERCENT">Percentage</option>
                <option value="AMOUNT">Fixed amount</option>
              </select>
            </label>
            <label className="inventory-field">
              <span>
                {reductionType === "PERCENT"
                  ? "Percentage reduction"
                  : "Amount reduction (PHP)"}
              </span>
              <input
                className="text-input"
                inputMode="decimal"
                value={reductionValue}
                onChange={(event) => {
                  setReductionValue(event.target.value);
                  setConfirmPrice(false);
                }}
                required
              />
            </label>
            <div className="bundle-promotional-price">
              <label className="inventory-field">
                <span>Approved promotional price (PHP)</span>
                <input
                  className="text-input"
                  inputMode="decimal"
                  value={finalPromotionalPrice}
                  onChange={(event) => {
                    setPromotionalPrice(event.target.value);
                    setPriceOverridden(true);
                    setConfirmPrice(false);
                  }}
                  required
                />
                <small className="field-hint">
                  {priceOverridden
                    ? "Custom price. Use the calculated price to restore automatic pricing."
                    : "Calculated automatically from the component prices and reduction rule. Edit to set a custom price."}
                </small>
              </label>
              {priceOverridden && (
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => {
                    setPriceOverridden(false);
                    setPromotionalPrice(calculatedPromotionalPrice);
                    setConfirmPrice(false);
                  }}
                >
                  Use calculated price
                </button>
              )}
            </div>
          </div>
          <div className="settings-main-card">
            <div className="card-heading">
              <div>
                <h3>Component products</h3>
                <p>
                  Current regular prices total{" "}
                  {pricing ? `₱${moneyFromCents(pricing.total)}` : "—"}.
                  Suggested offer price:{" "}
                  {pricing && pricing.suggested > 0n
                    ? `₱${moneyFromCents(pricing.suggested)}`
                    : "—"}
                  .
                </p>
              </div>
            </div>
            {components.map((component, index) => (
              <div
                className="inventory-search-row"
                key={`${component.productId}-${index}`}
              >
                <select
                  className="text-input select-input"
                  aria-label={`Bundle component ${index + 1}`}
                  value={component.productId}
                  onChange={(event) =>
                    setComponent(index, { productId: event.target.value })
                  }
                  required
                >
                  <option value="">Choose product</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.sku} · {product.name} · ₱{product.sellingPrice}
                    </option>
                  ))}
                </select>
                <input
                  className="text-input"
                  aria-label={`Quantity for component ${index + 1}`}
                  type="number"
                  min="1"
                  max="10000"
                  value={component.quantity}
                  onChange={(event) =>
                    setComponent(index, {
                      quantity: Number(event.target.value),
                    })
                  }
                  required
                />
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => {
                    setConfirmPrice(false);
                    setComponents((current) =>
                      current.filter((_, entryIndex) => entryIndex !== index),
                    );
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              className="button button-quiet"
              type="button"
              disabled={components.length >= 20}
              onClick={() => {
                setConfirmPrice(false);
                setComponents((current) => [
                  ...current,
                  { productId: "", quantity: 1 },
                ]);
              }}
            >
              Add component
            </button>
          </div>
          <label className="inventory-checkbox">
            <input
              type="checkbox"
              checked={confirmPrice}
              onChange={(event) => setConfirmPrice(event.target.checked)}
            />
            <span>
              I approve this exact final promotional price. Statutory SC/PWD
              treatment is compared per component and never stacked with the
              bundle promotion.
            </span>
          </label>
          <div className="button-row">
            <button
              className="button button-primary"
              type="submit"
              disabled={saving || components.length < 2 || !confirmPrice}
            >
              {saving
                ? "Saving…"
                : editingId
                  ? "Approve new version"
                  : "Create and approve offer"}
            </button>
            {editingId && (
              <button
                className="button button-quiet"
                type="button"
                onClick={clearForm}
              >
                Cancel editing
              </button>
            )}
          </div>
        </form>
      </div>
      <div className="settings-main-card">
        <div className="card-heading inventory-card-heading">
          <div>
            <h2>Saved offers</h2>
            <p>
              Configuration changes create a version; deactivation prevents
              checkout use.
            </p>
          </div>
        </div>
        {bundles.length ? (
          <div className="catalog-result-list">
            {bundles.map((bundle) => (
              <article className="catalog-result" key={bundle.id}>
                <div className="catalog-product-copy">
                  <strong>
                    {bundle.code} · {bundle.name} · v{bundle.version}
                  </strong>
                  <small>
                    {bundle.components
                      .map(
                        (component) =>
                          `${component.quantity} × ${component.name}`,
                      )
                      .join(" + ")}
                  </small>
                  <span>
                    {bundle.active ? "Active" : "Inactive"} ·{" "}
                    {bundle.activeFrom}
                    {bundle.activeUntil
                      ? ` to ${bundle.activeUntil}`
                      : " onward"}{" "}
                    · Offer ₱{bundle.promotionalPrice} · Suggested ₱
                    {bundle.suggestedPromotionalPrice}
                    {bundle.maxQuantityPerSale
                      ? ` · max ${bundle.maxQuantityPerSale} per sale`
                      : ""}
                  </span>
                </div>
                <div className="button-row">
                  <button
                    className="button button-quiet"
                    type="button"
                    onClick={() => editBundle(bundle)}
                  >
                    Edit version
                  </button>
                  <button
                    className="button button-quiet"
                    type="button"
                    onClick={() => void setActive(bundle, !bundle.active)}
                  >
                    {bundle.active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="table-loading">No bundle offers saved.</div>
        )}
      </div>
    </section>
  );
}
