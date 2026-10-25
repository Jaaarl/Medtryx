import type { ExpenseEntry } from "@medtryx/shared";

export const expenseLabels = {
  LUNCH: "Lunch",
  DELIVERY: "Delivery fee",
  OTHER: "Other",
  STOCK_PURCHASE: "Stock purchase / COD",
};

export function ExpenseHistory({
  expenses,
  className = "",
  description,
  onCancel,
  cancellingId,
}: {
  expenses: ExpenseEntry[];
  className?: string;
  description?: string;
  onCancel?: (expense: ExpenseEntry) => void;
  cancellingId?: string;
}) {
  return (
    <section
      className={`settings-main-card report-low-stock expense-history ${className}`}
    >
      <div className="card-heading">
        <div>
          <h2>Payments and expenses</h2>
          <p>
            {description ??
              "Stock purchases / COD and fees already included in unit cost are payments, excluded from operating expenses. Payment totals show money paid, not profit deductions."}
          </p>
        </div>
        <span className="count-chip">{expenses.length} entries</span>
      </div>
      {expenses.length ? (
        <div className="inventory-table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                <th>CATEGORY / DETAILS</th>
                <th>PAYMENT</th>
                <th>OPERATING EXPENSE</th>
                <th>PAID BY</th>
                <th>RECORDED</th>
                <th>RECORDED BY</th>
                {onCancel && <th>ACTION</th>}
              </tr>
            </thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.id}>
                  <td>
                    <strong>{expenseLabels[expense.category]}</strong>
                    {expense.cancelled && (
                      <small className="expense-cancelled-label">
                        Cancelled by {expense.cancelledByEmail ?? "staff"}
                      </small>
                    )}
                    {expense.description && (
                      <small>{expense.description}</small>
                    )}
                    {expense.category === "STOCK_PURCHASE" && (
                      <>
                        <small>
                          Products ₱{expense.productAmount} + delivery ₱
                          {expense.deliveryFee}
                        </small>
                        {expense.supplier && (
                          <small>Supplier: {expense.supplier}</small>
                        )}
                        {expense.invoiceReference && (
                          <small>
                            Invoice / receipt: {expense.invoiceReference}
                          </small>
                        )}
                        <small>
                          Stock purchase payment · excluded from operating
                          expenses
                        </small>
                      </>
                    )}
                    {expense.includedInUnitCost && (
                      <small>Already in inventory unit cost</small>
                    )}
                  </td>
                  <td data-label="Payment">₱{expense.amount}</td>
                  <td data-label="Operating expense">
                    ₱{expense.operatingExpense}
                  </td>
                  <td data-label="Paid by">
                    {expense.paymentSource === "OWNER" ? "Owner" : "Cashier"}
                    {expense.cashierEmail && (
                      <small>{expense.cashierEmail}</small>
                    )}
                  </td>
                  <td data-label="Recorded">
                    {new Date(expense.createdAt).toLocaleString("en-PH", {
                      timeZone: "Asia/Manila",
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </td>
                  <td data-label="Recorded by">{expense.recordedByEmail}</td>
                  {onCancel && (
                    <td data-label="Action">
                      {expense.canCancel ? (
                        <button
                          className="button button-secondary expense-cancel-button"
                          type="button"
                          disabled={cancellingId === expense.id}
                          onClick={() => onCancel(expense)}
                        >
                          {cancellingId === expense.id
                            ? "Cancelling…"
                            : "Cancel payment"}
                        </button>
                      ) : expense.cancelled ? (
                        <span className="expense-cancelled-label">Cancelled</span>
                      ) : null}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="report-empty">
          No payments or expenses recorded for this period.
        </p>
      )}
    </section>
  );
}
