import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";

type ProductMovement = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  unitsSold: number;
  unitsReturned: number;
  netUnitsMoved: number;
  averageUnitsMovedPerDay: number;
  transactionCount: number;
  lastSoldAt: string | null;
  movement: "FAST" | "SLOW";
};

type ProductMovementReport = {
  startDate: string;
  endDate: string;
  periodDays: number;
  activeProductCount: number;
  fastMovingCount: number;
  slowMovingCount: number;
  productsWithSalesCount: number;
  products: ProductMovement[];
};

type MovementFilter = "ALL" | "FAST" | "SLOW";
type MovementSortKey =
  | "product"
  | "movement"
  | "unitsSold"
  | "unitsReturned"
  | "netUnitsMoved"
  | "averageUnitsMovedPerDay"
  | "transactionCount"
  | "quantityOnHand"
  | "lastSoldAt";
type SortDirection = "asc" | "desc";

type MovementSort = {
  key: MovementSortKey;
  direction: SortDirection;
};

export function filterProductMovements(
  products: ProductMovement[],
  movementFilter: MovementFilter,
  searchQuery: string,
): ProductMovement[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  return products.filter((product) => {
    const matchesMovement =
      movementFilter === "ALL" || product.movement === movementFilter;
    const matchesSearch = `${product.name} ${product.sku}`
      .toLowerCase()
      .includes(normalizedQuery);
    return matchesMovement && matchesSearch;
  });
}

export function sortProductMovements(
  products: ProductMovement[],
  { key, direction }: MovementSort,
): ProductMovement[] {
  const multiplier = direction === "asc" ? 1 : -1;
  const valueFor = (product: ProductMovement): string | number | null => {
    switch (key) {
      case "product":
        return product.name;
      case "movement":
        return product.movement;
      case "unitsSold":
        return product.unitsSold;
      case "unitsReturned":
        return product.unitsReturned;
      case "netUnitsMoved":
        return product.netUnitsMoved;
      case "averageUnitsMovedPerDay":
        return product.averageUnitsMovedPerDay;
      case "transactionCount":
        return product.transactionCount;
      case "quantityOnHand":
        return product.quantityOnHand;
      case "lastSoldAt":
        return product.lastSoldAt ? Date.parse(product.lastSoldAt) : null;
    }
  };

  return [...products].sort((left, right) => {
    const leftValue = valueFor(left);
    const rightValue = valueFor(right);
    if (leftValue === null) return rightValue === null ? 0 : 1;
    if (rightValue === null) return -1;
    const comparison =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), undefined, {
            numeric: true,
            sensitivity: "base",
          });
    return comparison * multiplier;
  });
}

function SortableHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}) {
  return (
    <th
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        className="inventory-sort-button"
        type="button"
        aria-label={`Sort by ${label}`}
        onClick={onClick}
      >
        <span>{label}</span>
        <span className="inventory-sort-indicator" aria-hidden="true">
          {active ? (direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function todayInManila(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function offsetDate(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function formatLastSold(value: string | null): string {
  if (!value) return "Never sold";
  return new Date(value).toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
  });
}

function formatRate(value: number): string {
  return `${value.toFixed(2)} / day`;
}

export function ProductMovementPage() {
  const today = todayInManila();
  const [startDate, setStartDate] = useState(() => offsetDate(today, -29));
  const [endDate, setEndDate] = useState(today);
  const [filter, setFilter] = useState<MovementFilter>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<MovementSort>({
    key: "product",
    direction: "asc",
  });
  const [report, setReport] = useState<ProductMovementReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ startDate, endDate });
    void api
      .get<ProductMovementReport>(`/reports/product-movement?${query}`)
      .then((nextReport) => {
        if (active) setReport(nextReport);
      })
      .catch(() => {
        if (active) {
          setReport(null);
          setError(
            "Unable to load product movement. Check the date range and try again.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [startDate, endDate, refreshKey]);

  function selectPeriod(days: number) {
    const today = todayInManila();
    const nextStartDate = offsetDate(today, 1 - days);
    if (nextStartDate === startDate && today === endDate) return;
    setLoading(true);
    setError("");
    setStartDate(nextStartDate);
    setEndDate(today);
  }

  function updateStartDate(value: string) {
    setLoading(true);
    setError("");
    setStartDate(value);
  }

  function updateEndDate(value: string) {
    setLoading(true);
    setError("");
    setEndDate(value);
  }

  const filteredProducts = report
    ? filterProductMovements(report.products, filter, searchQuery)
    : [];
  const products = sortProductMovements(filteredProducts, sort);

  function selectSort(key: MovementSortKey) {
    setSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return (
    <section className="page-section product-movement-page">
      <div className="page-heading movement-heading">
        <div>
          <div className="eyebrow">OWNER REPORTING</div>
          <h1>Product movement</h1>
          <p>
            See which products are selling quickly and which have little or no
            movement.
          </p>
        </div>
        <div className="movement-period-actions">
          <label className="report-date-field">
            <span className="field-label">Start date</span>
            <input
              aria-label="Start date"
              className="text-input"
              type="date"
              value={startDate}
              onChange={(event) => updateStartDate(event.target.value)}
            />
          </label>
          <label className="report-date-field">
            <span className="field-label">End date</span>
            <input
              aria-label="End date"
              className="text-input"
              type="date"
              value={endDate}
              onChange={(event) => updateEndDate(event.target.value)}
            />
          </label>
          {[7, 30, 90].map((days) => (
            <button
              className="button button-secondary movement-period-button"
              key={days}
              type="button"
              onClick={() => selectPeriod(days)}
            >
              {days} days
            </button>
          ))}
          <button
            className="button button-secondary movement-refresh"
            type="button"
            onClick={() => {
              setLoading(true);
              setError("");
              setRefreshKey((key) => key + 1);
            }}
            disabled={loading}
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
      {loading && (
        <div className="table-loading">Loading product movement…</div>
      )}
      {report && !loading && (
        <>
          <div className="movement-summary-strip">
            <div>
              <span>ACTIVE PRODUCTS</span>
              <strong>{report.activeProductCount}</strong>
            </div>
            <div>
              <span>FAST MOVING</span>
              <strong>{report.fastMovingCount}</strong>
            </div>
            <div>
              <span>SLOW MOVING</span>
              <strong>{report.slowMovingCount}</strong>
            </div>
            <div>
              <span>PRODUCTS WITH SALES</span>
              <strong>{report.productsWithSalesCount}</strong>
            </div>
          </div>

          <section className="settings-main-card movement-list-card">
            <div className="card-heading movement-list-heading">
              <div>
                <h2>Movement by product</h2>
                <p>
                  {report.startDate} to {report.endDate} · {report.periodDays}{" "}
                  days · Manila time
                </p>
              </div>
              <div className="movement-list-controls">
                <label className="movement-filter-field movement-search-field">
                  <span className="field-label">Search</span>
                  <input
                    aria-label="Search products by name or SKU"
                    className="text-input"
                    type="search"
                    placeholder="Product name or SKU"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </label>
                <label className="movement-filter-field">
                  <span className="field-label">Show</span>
                  <select
                    aria-label="Filter products by movement"
                    className="text-input select-input"
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as MovementFilter)
                    }
                  >
                    <option value="ALL">All products</option>
                    <option value="FAST">Fast moving</option>
                    <option value="SLOW">Slow moving</option>
                  </select>
                </label>
              </div>
            </div>
            {products.length ? (
              <div className="inventory-table-wrap">
                <table className="inventory-table movement-table">
                  <thead>
                    <tr>
                      <SortableHeader
                        label="Product"
                        active={sort.key === "product"}
                        direction={sort.direction}
                        onClick={() => selectSort("product")}
                      />
                      <SortableHeader
                        label="Movement"
                        active={sort.key === "movement"}
                        direction={sort.direction}
                        onClick={() => selectSort("movement")}
                      />
                      <SortableHeader
                        label="Sold"
                        active={sort.key === "unitsSold"}
                        direction={sort.direction}
                        onClick={() => selectSort("unitsSold")}
                      />
                      <SortableHeader
                        label="Returned"
                        active={sort.key === "unitsReturned"}
                        direction={sort.direction}
                        onClick={() => selectSort("unitsReturned")}
                      />
                      <SortableHeader
                        label="Net moved"
                        active={sort.key === "netUnitsMoved"}
                        direction={sort.direction}
                        onClick={() => selectSort("netUnitsMoved")}
                      />
                      <SortableHeader
                        label="Daily average"
                        active={sort.key === "averageUnitsMovedPerDay"}
                        direction={sort.direction}
                        onClick={() => selectSort("averageUnitsMovedPerDay")}
                      />
                      <SortableHeader
                        label="Transactions"
                        active={sort.key === "transactionCount"}
                        direction={sort.direction}
                        onClick={() => selectSort("transactionCount")}
                      />
                      <SortableHeader
                        label="In stock"
                        active={sort.key === "quantityOnHand"}
                        direction={sort.direction}
                        onClick={() => selectSort("quantityOnHand")}
                      />
                      <SortableHeader
                        label="Last sold"
                        active={sort.key === "lastSoldAt"}
                        direction={sort.direction}
                        onClick={() => selectSort("lastSoldAt")}
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((product) => (
                      <tr key={product.id}>
                        <td>
                          <strong>{product.name}</strong>
                          <small>{product.sku}</small>
                        </td>
                        <td>
                          <span
                            className={`movement-status movement-status-${product.movement.toLowerCase()}`}
                          >
                            {product.movement === "FAST" ? "Fast" : "Slow"}
                          </span>
                        </td>
                        <td>
                          {product.unitsSold} {product.unit}
                        </td>
                        <td>
                          {product.unitsReturned} {product.unit}
                        </td>
                        <td>
                          {product.netUnitsMoved} {product.unit}
                        </td>
                        <td>{formatRate(product.averageUnitsMovedPerDay)}</td>
                        <td>{product.transactionCount}</td>
                        <td>
                          {product.quantityOnHand} {product.unit}
                        </td>
                        <td>{formatLastSold(product.lastSoldAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="report-empty">
                {report.activeProductCount === 0
                  ? "There are no active products to report."
                  : searchQuery.trim()
                    ? filter === "ALL"
                      ? "No products match your search."
                      : "No products match your search and movement filter."
                    : "No products match this movement filter."}
              </p>
            )}
          </section>

          <p className="movement-method-note">
            Fast moving means positive net units moved per day are at or above
            the average for products with the same selling unit. Slow moving
            means below that average or no net movement. Returns are subtracted
            from sales in the period; current stock and last sold date are shown
            as of now.
          </p>
        </>
      )}
    </section>
  );
}
