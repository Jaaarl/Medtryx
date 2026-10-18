import { currencySymbol, formatCurrency } from "./currency";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  ExpenseCategory,
  ExpenseEntry,
  ExpensePaymentSource,
  ExpenseTotals,
} from "@medtryx/shared";
import { Link } from "react-router";
import { CreditCard, Plus, RefreshCw } from "lucide-react";
import { api, ApiError } from "./api";
import { useAuth } from "./auth-context";
import { createBrowserUuid } from "./browser-uuid";
import { ExpenseHistory } from "./expense-history";

type ExpenseResponse = {
  expenses: ExpenseEntry[];
  totals: ExpenseTotals;
  registerShift: {
    id: string;
    cashierEmail: string;
    expectedCash: string;
    canCharge: boolean;
  } | null;
};

function todayInManila() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function expenseError(error: unknown): string {
  const messages: Record<string, string> = {
    open_shift_required:
      "Open a cashier shift before paying an expense from the drawer.",
    expense_requires_own_shift:
      "The active register belongs to another cashier. Ask the owner to record this payment.",
    cash_amount_overflow:
      "This payment would exceed the supported register balance.",
    expense_shift_changed:
      "The open cashier shift changed. Refresh and review who will pay before recording this expense.",
    invalid_expense:
      "Enter a positive amount with up to two decimal places. Stock purchases need a positive product amount; Other expenses need a description.",
    expense_request_key_reused:
      "This payment was already recorded with different details. Refresh before adding another expense.",
  };
  return error instanceof ApiError
    ? (messages[error.code] ?? "Unable to record the expense. Try again.")
    : "Unable to record the expense. Try again.";
}

function paymentTotal(productAmount: string, deliveryFee: string): string {
  const cents = (value: string) => {
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  };
  const product = cents(productAmount);
  const fee = cents(deliveryFee || "0");
  if (product === null || fee === null) return "";
  const total = product + fee;
  return `${Math.floor(total / 100)}.${String(total % 100).padStart(2, "0")}`;
}

export function ExpensesPage() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayInManila);
  const [data, setData] = useState<ExpenseResponse | null>(null);
  const [category, setCategory] = useState<ExpenseCategory>("LUNCH");
  const [amount, setAmount] = useState("");
  const [deliveryFee, setDeliveryFee] = useState("");
  const [supplier, setSupplier] = useState("");
  const [invoiceReference, setInvoiceReference] = useState("");
  const [description, setDescription] = useState("");
  const [paymentSource, setPaymentSource] =
    useState<ExpensePaymentSource>("CASHIER");
  const [includedInUnitCost, setIncludedInUnitCost] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const requestKey = useRef("");
  const submitting = useRef(false);
  const stockPurchase = category === "STOCK_PURCHASE";
  const choosesPayer = category === "DELIVERY" || stockPurchase;
  const totalPayment = stockPurchase
    ? paymentTotal(amount, deliveryFee)
    : amount;

  useEffect(() => {
    let active = true;
    void api
      .get<ExpenseResponse>(
        `/expenses?startDate=${encodeURIComponent(date)}&endDate=${encodeURIComponent(date)}`,
      )
      .then((result) => {
        if (active) {
          setData(result);
          setError("");
        }
      })
      .catch(() => {
        if (active) {
          setData(null);
          setError("Unable to load expenses. Try refreshing.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [date, refreshKey]);

  function draftChanged() {
    requestKey.current = "";
    setNotice("");
  }

  async function recordExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    requestKey.current ||= createBrowserUuid();
    try {
      const result = await api.post<{
        expense: ExpenseEntry;
        expectedCash: string | null;
      }>("/expenses", {
        requestKey: requestKey.current,
        category,
        amount: totalPayment,
        description,
        paymentSource: choosesPayer ? paymentSource : "CASHIER",
        includedInUnitCost: category === "DELIVERY" && includedInUnitCost,
        ...(stockPurchase
          ? {
              productAmount: amount,
              deliveryFee: deliveryFee || "0",
              supplier,
              invoiceReference,
            }
          : {}),
        ...(!choosesPayer || paymentSource === "CASHIER"
          ? { shiftId: data?.registerShift?.id }
          : {}),
      });
      setNotice(
        `${stockPurchase ? "Stock purchase payment recorded; excluded from operating expenses." : result.expense.includedInUnitCost ? "Delivery payment recorded; already included in unit cost." : "Expense recorded."}${result.expectedCash !== null ? ` Expected cashier cash: ${formatCurrency(result.expectedCash)}.` : " Paid by owner."}`,
      );
      requestKey.current = "";
      setAmount("");
      setDeliveryFee("");
      setSupplier("");
      setInvoiceReference("");
      setDescription("");
      setIncludedInUnitCost(false);
      setLoading(true);
      setDate(todayInManila());
      setRefreshKey((key) => key + 1);
    } catch (caught) {
      setError(expenseError(caught));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  const cashierPaid = !choosesPayer || paymentSource === "CASHIER";
  const canSubmit =
    !saving &&
    !loading &&
    (!cashierPaid || Boolean(data?.registerShift?.canCharge));

  return (
    <section className="page-section inventory-page expenses-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">STORE PAYMENTS</div>
          <h1>Payments &amp; Expenses</h1>
          <p>
            Track stock purchases, daily expenses, and payments from the owner
            or cashier.
          </p>
        </div>
        <div className="daily-sales-actions">
          <label className="report-date-field">
            <span className="field-label">History date</span>
            <input
              className="text-input"
              type="date"
              value={date}
              aria-label="Expense history date"
              onChange={(event) => {
                setLoading(true);
                setDate(event.target.value);
              }}
            />
          </label>
          <button
            className="button button-secondary"
            type="button"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setRefreshKey((key) => key + 1);
            }}
          >
            <RefreshCw size={16} /> Refresh
          </button>
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
      {data && !loading && (
        <div className="report-summary-strip expense-summary-strip">
          <div>
            <span>OPERATING EXPENSES</span>
            <strong>{formatCurrency(data.totals.operatingExpenses)}</strong>
          </div>
          <div>
            <span>PAID FROM CASHIER</span>
            <strong>{formatCurrency(data.totals.cashierPaid)}</strong>
          </div>
          <div>
            <span>PAID BY OWNER</span>
            <strong>{formatCurrency(data.totals.ownerPaid)}</strong>
          </div>
          <div>
            <span>STOCK PURCHASE / COD PAYMENTS</span>
            <strong>{formatCurrency(data.totals.stockPurchasePayments)}</strong>
          </div>
          <div>
            <span>STOCK PRODUCTS / DELIVERY FEES</span>
            <strong>
              {formatCurrency(data.totals.stockProductPayments)} /{" "}
              {formatCurrency(data.totals.stockDeliveryFees)}
            </strong>
          </div>
          <div>
            <span>SEPARATE FEES ALREADY IN UNIT COST</span>
            <strong>{formatCurrency(data.totals.includedInUnitCost)}</strong>
          </div>
        </div>
      )}
      <div className="expense-layout">
        <section className="create-card expense-form-card">
          <div className="expense-section-heading">
            <span className="expense-form-heading-icon" aria-hidden="true">
              <CreditCard size={19} />
            </span>
            <div>
              <h2>Record payment or expense</h2>
              <p>New payments are recorded for today’s Manila business date.</p>
            </div>
          </div>
          <form
            className="expense-payment-form"
            onSubmit={(event) => void recordExpense(event)}
          >
            <div className="expense-form-layout">
              <fieldset className="expense-form-fields" disabled={saving}>
                <section className="expense-form-section">
                  <div className="expense-form-section-heading">
                    <h3>Payment details</h3>
                    <p>Choose a category and enter the payment amount.</p>
                  </div>
                  <div className="expense-payment-details-grid">
                    <label
                      className={`inventory-field${stockPurchase ? " expense-field-wide" : ""}`}
                    >
                      <span>Category</span>
                      <select
                        className="text-input"
                        value={category}
                        onChange={(event) => {
                          draftChanged();
                          setCategory(event.target.value as ExpenseCategory);
                          setPaymentSource("CASHIER");
                          setIncludedInUnitCost(false);
                        }}
                      >
                        <option value="LUNCH">Lunch</option>
                        <option value="STOCK_PURCHASE">
                          Stock purchase / COD
                        </option>
                        <option value="DELIVERY">Delivery fee only</option>
                        <option value="OTHER">Other</option>
                      </select>
                    </label>
                    {!stockPurchase && (
                      <label className="inventory-field">
                        <span>
                          {category === "DELIVERY"
                            ? `Delivery fee (${currencySymbol()})`
                            : `Amount (${currencySymbol()})`}
                        </span>
                        <input
                          className="text-input"
                          inputMode="decimal"
                          value={amount}
                          onChange={(event) => {
                            draftChanged();
                            setAmount(event.target.value);
                          }}
                          pattern="[0-9]{1,7}(\.[0-9]{1,2})?"
                          required
                        />
                      </label>
                    )}
                  </div>
                  {stockPurchase && (
                    <div className="expense-stock-amounts">
                      <label className="inventory-field">
                        <span>Product amount ({currencySymbol()})</span>
                        <input
                          className="text-input"
                          inputMode="decimal"
                          value={amount}
                          onChange={(event) => {
                            draftChanged();
                            setAmount(event.target.value);
                          }}
                          pattern="[0-9]{1,7}(\.[0-9]{1,2})?"
                          required
                        />
                      </label>
                      <div className="inventory-field">
                        <label htmlFor="expense-delivery-fee">
                          Separate delivery fee ({currencySymbol()}, optional)
                        </label>
                        <input
                          id="expense-delivery-fee"
                          aria-describedby="expense-delivery-fee-hint"
                          className="text-input"
                          inputMode="decimal"
                          value={deliveryFee}
                          placeholder="0.00"
                          pattern="[0-9]{1,7}(\.[0-9]{1,2})?"
                          onChange={(event) => {
                            draftChanged();
                            setDeliveryFee(event.target.value);
                          }}
                        />
                        <small
                          id="expense-delivery-fee-hint"
                          className="field-hint"
                        >
                          Leave at zero if delivery is included in the product
                          amount.
                        </small>
                      </div>
                    </div>
                  )}
                </section>
                {choosesPayer && (
                  <section className="expense-form-section">
                    <div className="expense-form-section-heading">
                      <h3>Payment source</h3>
                      <p>Choose who is paying for this transaction.</p>
                    </div>
                    <label className="inventory-field">
                      <span>
                        {stockPurchase
                          ? "Who paid the stock purchase?"
                          : "Who pays the delivery fee?"}
                      </span>
                      <select
                        className="text-input"
                        value={paymentSource}
                        onChange={(event) => {
                          draftChanged();
                          setPaymentSource(
                            event.target.value as ExpensePaymentSource,
                          );
                        }}
                      >
                        <option value="CASHIER">
                          Charge to the open cashier
                        </option>
                        <option value="OWNER">Already paid by the owner</option>
                      </select>
                    </label>
                    {category === "DELIVERY" && (
                      <div className="expense-delivery-options">
                        <label className="inventory-checkbox">
                          <input
                            type="checkbox"
                            checked={includedInUnitCost}
                            onChange={(event) => {
                              draftChanged();
                              setIncludedInUnitCost(event.target.checked);
                            }}
                          />
                          <span>
                            This delivery fee is already included in product
                            unit cost
                          </span>
                        </label>
                        <p className="field-hint">
                          Enter the delivery fee only. Use Stock purchase / COD
                          for the full product invoice.
                        </p>
                      </div>
                    )}
                  </section>
                )}
                <section className="expense-form-section">
                  <div className="expense-form-section-heading">
                    <h3>Additional details</h3>
                    <p>
                      Add a description and, for stock purchases, supplier or
                      receipt references.
                    </p>
                  </div>
                  {stockPurchase && (
                    <div className="expense-reference-grid">
                      <label className="inventory-field">
                        <span>Supplier (optional)</span>
                        <input
                          className="text-input"
                          value={supplier}
                          maxLength={200}
                          onChange={(event) => {
                            draftChanged();
                            setSupplier(event.target.value);
                          }}
                        />
                      </label>
                      <label className="inventory-field">
                        <span>Invoice / receipt reference (optional)</span>
                        <input
                          className="text-input"
                          value={invoiceReference}
                          maxLength={200}
                          onChange={(event) => {
                            draftChanged();
                            setInvoiceReference(event.target.value);
                          }}
                        />
                      </label>
                    </div>
                  )}
                  <label className="inventory-field">
                    <span>
                      {category === "OTHER"
                        ? "Description"
                        : "Description (optional)"}
                    </span>
                    <textarea
                      className="text-input expense-description"
                      rows={3}
                      value={description}
                      maxLength={500}
                      minLength={category === "OTHER" ? 3 : undefined}
                      required={category === "OTHER"}
                      onChange={(event) => {
                        draftChanged();
                        setDescription(event.target.value);
                      }}
                    />
                  </label>
                </section>
              </fieldset>
              <aside
                className="expense-payment-review"
                aria-label="Payment summary"
              >
                <h3>Review payment</h3>
                {stockPurchase && (
                  <dl className="expense-payment-breakdown">
                    <div>
                      <dt>Products</dt>
                      <dd>
                        {formatCurrency(paymentTotal(amount, "0") || "0.00")}
                      </dd>
                    </div>
                    <div>
                      <dt>Delivery fee</dt>
                      <dd>
                        {formatCurrency(
                          paymentTotal(deliveryFee || "0", "0") || "0.00",
                        )}
                      </dd>
                    </div>
                  </dl>
                )}
                <strong className="expense-payment-total">
                  <span>Total payment:</span>{" "}
                  <span>{formatCurrency(totalPayment || "0.00")}</span>
                </strong>
                <p className="expense-review-note">
                  {stockPurchase
                    ? "Stock purchase payments are excluded from operating expenses."
                    : category === "DELIVERY" && includedInUnitCost
                      ? "This fee is already in unit cost and is excluded from operating expenses."
                      : "This payment is included in operating expenses."}
                </p>
                <div className="expense-drawer-note">
                  {cashierPaid ? (
                    data?.registerShift ? (
                      <>
                        <div className="expense-drawer-row">
                          <span>Charged to</span>
                          <strong>{data.registerShift.cashierEmail}</strong>
                        </div>
                        <div className="expense-drawer-row">
                          <span>Expected drawer cash:</span>
                          <strong>
                            {formatCurrency(data.registerShift.expectedCash)}
                          </strong>
                        </div>
                        <span>
                          Payments can be recorded even if this balance goes
                          below zero.
                        </span>
                        {!data.registerShift.canCharge && (
                          <span>
                            This register belongs to another cashier. The owner
                            can record its expenses.
                          </span>
                        )}
                      </>
                    ) : (
                      <span>
                        <Link to="/checkout">Open a cashier shift</Link> to pay
                        from the drawer.
                      </span>
                    )
                  ) : (
                    <span>
                      Already paid by the owner. This payment will not be taken
                      from the cashier’s drawer.
                    </span>
                  )}
                </div>
                <button
                  className="button button-primary create-submit"
                  type="submit"
                  disabled={!canSubmit}
                >
                  <Plus size={16} />{" "}
                  {saving
                    ? "Recording…"
                    : stockPurchase
                      ? "Record stock payment"
                      : "Record expense"}
                </button>
                {stockPurchase && (
                  <details className="expense-cost-guidance">
                    <summary>Receiving this stock</summary>
                    <p>
                      Receive the products separately in Receive Stock. Include
                      delivery in their unit cost so it reaches cost of goods
                      sold when sold. Recording this payment does not add stock
                      or change unit costs.
                    </p>
                  </details>
                )}
              </aside>
            </div>
          </form>
        </section>
        <div className="expense-records">
          {loading ? (
            <div className="table-loading">Loading expenses…</div>
          ) : (
            data && (
              <ExpenseHistory
                expenses={data.expenses}
                className="expense-page-history"
                description={`${user?.role === "owner" ? "All store payments" : "Payments charged to your shifts and owner-paid payments you recorded"} for ${date}.`}
              />
            )
          )}
        </div>
      </div>
    </section>
  );
}
