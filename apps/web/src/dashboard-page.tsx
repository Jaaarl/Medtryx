import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "./api";
import { MonthlyIncentiveProgress } from "./monthly-incentive-progress";

type DashboardProduct = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  reorderLevel: number | null;
  active: boolean;
};

function StockAlertCard({
  title,
  description,
  emptyMessage,
  products,
  loading,
  failed,
}: {
  title: string;
  description: string;
  emptyMessage: string;
  products: DashboardProduct[];
  loading: boolean;
  failed: boolean;
}) {
  return (
    <section className="settings-main-card dashboard-stock-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">INVENTORY ALERT</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="count-chip">
          {loading || failed ? "—" : `${products.length} products`}
        </span>
      </div>

      {loading ? (
        <p className="dashboard-stock-state" role="status">
          Loading stock…
        </p>
      ) : failed ? (
        <p className="dashboard-stock-state" role="status">
          Unable to load stock. Refresh the page to try again.
        </p>
      ) : products.length ? (
        <>
          <ul className="dashboard-stock-list">
            {products.slice(0, 6).map((product) => (
              <li key={product.id}>
                <Link
                  className="dashboard-stock-item"
                  to={`/stock?productId=${encodeURIComponent(product.id)}`}
                >
                  <span className="dashboard-stock-product">
                    <strong>{product.name}</strong>
                    <small>{product.sku}</small>
                  </span>
                  <span className="dashboard-stock-quantity">
                    <strong>
                      {product.quantityOnHand} {product.unit}
                    </strong>
                    {product.reorderLevel !== null && (
                      <small>Reorder at {product.reorderLevel}</small>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {products.length > 6 && (
            <p className="dashboard-stock-more">
              Showing 6 of {products.length} products. Visit Stock to see the
              full list.
            </p>
          )}
        </>
      ) : (
        <p className="dashboard-stock-state">{emptyMessage}</p>
      )}

      <div className="dashboard-stock-footer">
        <Link to="/stock">Manage stock</Link>
      </div>
    </section>
  );
}

export function DashboardPage() {
  const [products, setProducts] = useState<DashboardProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .get<{ products: DashboardProduct[] }>("/stock")
      .then(({ products: result }) => {
        if (active) setProducts(result.filter((product) => product.active));
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const noStock = products.filter((product) => product.quantityOnHand === 0);
  const lowStock = products.filter(
    (product) =>
      product.quantityOnHand > 0 &&
      product.reorderLevel !== null &&
      product.quantityOnHand <= product.reorderLevel,
  );

  return (
    <section className="page-section dashboard-home">
      <div className="page-heading">
        <div>
          <div className="eyebrow">STORE OVERVIEW</div>
          <h1>Dashboard</h1>
          <p>Stock alerts and monthly sales goals at a glance.</p>
        </div>
      </div>

      <div className="dashboard-stock-grid">
        <StockAlertCard
          title="No stock"
          description="Active products with none left on hand."
          emptyMessage="All active products have stock on hand."
          products={noStock}
          loading={loading}
          failed={failed}
        />
        <StockAlertCard
          title="Low stock"
          description="Products at or below their reorder level."
          emptyMessage="No active products are at or below their reorder level."
          products={lowStock}
          loading={loading}
          failed={failed}
        />
      </div>

      <section
        className="dashboard-goals-section"
        aria-label="Monthly goals chart"
      >
        <div className="dashboard-section-heading">
          <div>
            <span className="eyebrow">SALES TARGETS</span>
            <h2>Monthly goals chart</h2>
          </div>
          <Link to="/monthly-goals">View monthly goals</Link>
        </div>
        <MonthlyIncentiveProgress
          placement="monthly-goals"
          refreshKey={0}
          showDisabledState
          alwaysShowIncentiveAmounts
        />
      </section>
    </section>
  );
}
