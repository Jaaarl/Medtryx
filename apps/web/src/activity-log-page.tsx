import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router";
import {
  ChevronLeft,
  ChevronRight,
  Filter,
  History,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  activityCategories,
  type ActivityEvent,
  type ActivityFilterOptions,
  type ActivityLogResponse,
} from "@medtryx/shared";
import { api, ApiError } from "./api";
import "./activity-log-page.css";

type Filters = {
  q: string;
  startDate: string;
  endDate: string;
  category: string;
  action: string[];
  actorId: string;
  pageSize: string;
};

const fieldLabels: Record<string, string> = {
  old: "Before",
  new: "After",
  sku: "SKU",
  name: "Product name",
  unit: "Stock unit",
  removedQuantity: "Stock removed",
  removedInventoryValueCentavos: "Inventory value removed",
  amountDueCentavos: "Amount paid",
  quantityDelta: "Stock quantity change",
  inventoryValueDeltaCentavos: "Inventory value change",
  unitCostCents: "Unit cost",
  unitCostCentavos: "Unit cost",
  category: "Payment category",
  includedInUnitCost: "Already included in unit cost",
  paymentSource: "Paid from",
  productAmountCentavos: "Product payment",
  deliveryFeeCentavos: "Delivery fee",
  cashMovementId: "Cash movement reference",
  refundSource: "Cash refund charged to",
  cashShiftWasClosed: "Refund shift was already closed",
  refundCashierUserId: "Refund shift cashier reference",
  stockAdjustmentIds: "Inventory corrections",
  isScEligible: "Senior citizen eligible",
  isPwdEligible: "PWD eligible",
  bnpcEligible: "BNPC eligible",
  isBnpcEligible: "BNPC eligible",
  scPwdEligible: "Senior / PWD eligible",
  tracksLots: "Track lots and expiry",
};

function fieldLabel(key: string): string {
  return (
    fieldLabels[key] ??
    key
      .replace(/Centavos$|Cents$/u, "")
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replaceAll("_", " ")
      .replace(/^./u, (letter) => letter.toUpperCase())
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : value;
}

function money(centavos: number): string {
  return (centavos / 100).toLocaleString("en-PH", {
    style: "currency",
    currency: "PHP",
  });
}

function valueLabel(value: unknown, key: string): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (/Centavos$|Cents$/u.test(key)) return money(value);
    if (/BasisPoints$/u.test(key)) return `${value / 100}%`;
    return value.toLocaleString("en-PH");
  }
  if (typeof value !== "string") return String(value);
  if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) return formatTime(value);
  if (
    [
      "role",
      "category",
      "paymentSource",
      "refundSource",
      "paymentMethod",
      "refundMethod",
      "benefitType",
      "reasonType",
      "stockTreatment",
      "decision",
    ].includes(key)
  ) {
    const labels: Record<string, string> = {
      STOCK_PURCHASE: "Stock purchase / COD",
      CURRENT: "Current open shift",
      ORIGINAL: "Original sale’s shift",
      OWNER: "Owner funds",
      CASHIER: "Cash register",
      QR: "QR",
      PWD: "PWD",
      LUNCH: "Lunch",
      DELIVERY: "Delivery fee",
    };
    return (
      labels[value] ??
      value
        .replaceAll("_", " ")
        .toLowerCase()
        .replace(/^./u, (letter) => letter.toUpperCase())
    );
  }
  return value;
}

function DetailValue({ value, field }: { value: unknown; field: string }) {
  const [expanded, setExpanded] = useState(false);
  if (value && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index + 1), item] as const)
      : Object.entries(value);
    if (!entries.length) return <span>None</span>;
    return (
      <details
        className="activity-nested-details"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          {Array.isArray(value)
            ? `${entries.length} item${entries.length === 1 ? "" : "s"}`
            : "View fields"}
        </summary>
        {expanded && (
          <dl>
            {entries.map(([key, item]) => (
              <div key={key}>
                <dt>{fieldLabel(key)}</dt>
                <dd>
                  <DetailValue
                    value={item}
                    field={Array.isArray(value) ? field : key}
                  />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </details>
    );
  }
  return <span>{valueLabel(value, field)}</span>;
}

function summaryFor(event: ActivityEvent): string {
  const detail = event.details;
  const parts: string[] = [];
  if (typeof detail.removedQuantity === "number")
    parts.push(
      `${detail.removedQuantity.toLocaleString("en-PH")} stock removed`,
    );
  else if (typeof detail.quantityDelta === "number")
    parts.push(
      `${detail.quantityDelta > 0 ? "+" : ""}${detail.quantityDelta.toLocaleString("en-PH")} stock`,
    );
  else if (typeof detail.quantity === "number")
    parts.push(`${detail.quantity.toLocaleString("en-PH")} units`);
  else if (typeof detail.openingQuantity === "number")
    parts.push(
      `${detail.openingQuantity.toLocaleString("en-PH")} opening stock`,
    );
  if (typeof detail.category === "string")
    parts.push(valueLabel(detail.category, "category"));
  for (const key of [
    "amountDueCentavos",
    "amountCentavos",
    "refundCentavos",
    "removedInventoryValueCentavos",
  ]) {
    if (typeof detail[key] === "number") {
      parts.push(money(detail[key]));
      break;
    }
  }
  if (typeof detail.paymentSource === "string")
    parts.push(valueLabel(detail.paymentSource, "paymentSource"));
  else if (typeof detail.paymentMethod === "string")
    parts.push(valueLabel(detail.paymentMethod, "paymentMethod"));
  if (typeof detail.reason === "string" && detail.reason !== event.subject)
    parts.push(detail.reason);
  return parts.join(" · ");
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const [expanded, setExpanded] = useState(false);
  const category = activityCategories.find(
    (item) => item.value === event.category,
  );
  const summary = summaryFor(event);
  return (
    <article className="activity-log-entry">
      <div
        className={`activity-log-marker activity-log-marker-${event.category}`}
        aria-hidden="true"
      >
        <History size={17} />
      </div>
      <div className="activity-log-entry-content">
        <div className="activity-log-entry-top">
          <h3>{event.actionLabel}</h3>
          <span className="activity-log-category">
            {category?.label ?? "Other activity"}
          </span>
        </div>
        <p className="activity-log-subject">{event.subject}</p>
        {summary && <p className="activity-log-summary">{summary}</p>}
        <div className="activity-log-meta">
          <span className="activity-log-actor">
            {event.actorUsername ?? event.actorEmail ?? "System / deleted user"}
          </span>
          {event.actorRole && (
            <span>{event.actorRole === "owner" ? "Owner" : "Cashier"}</span>
          )}
          <time dateTime={event.createdAt} title={event.createdAt}>
            {formatTime(event.createdAt)}
          </time>
        </div>
        <details
          className="activity-event-details"
          onToggle={(toggle) => setExpanded(toggle.currentTarget.open)}
        >
          <summary>View activity details</summary>
          {expanded && (
            <div className="activity-event-detail-body">
              {event.actorEmail && event.actorUsername && (
                <p>
                  <strong>Recorded by:</strong> {event.actorEmail}
                </p>
              )}
              <dl className="activity-event-fields">
                {Object.entries(event.details).map(([field, value]) => (
                  <div key={field}>
                    <dt>{fieldLabel(field)}</dt>
                    <dd>
                      <DetailValue field={field} value={value} />
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="activity-event-references">
                <span>Record reference: {event.entityId}</span>
                <span>Activity reference: {event.id}</span>
              </div>
            </div>
          )}
        </details>
      </div>
    </article>
  );
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dayOffset(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function filtersFrom(query: string): Filters {
  const params = new URLSearchParams(query);
  return {
    q: params.get("q") ?? "",
    startDate: params.get("startDate") ?? "",
    endDate: params.get("endDate") ?? "",
    category: params.get("category") ?? "",
    action: [
      ...new Set(
        params
          .getAll("action")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
    actorId: params.get("actorId") ?? "",
    pageSize: params.get("pageSize") ?? "25",
  };
}

function ActivityLogContent({
  query,
  options,
  optionsError,
  onQueryChange,
  reloadOptions,
}: {
  query: string;
  options: ActivityFilterOptions | null;
  optionsError: boolean;
  onQueryChange: (params: URLSearchParams) => void;
  reloadOptions: () => void;
}) {
  const [draft, setDraft] = useState(() => filtersFrom(query));
  const [result, setResult] = useState<ActivityLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let current = true;
    const params = new URLSearchParams(query);
    if (!params.has("pageSize")) params.set("pageSize", "25");
    void api
      .get<ActivityLogResponse>(`/audit?${params}`)
      .then((data) => {
        if (current) {
          setResult(data);
          setError("");
        }
      })
      .catch((caught: unknown) => {
        if (current) {
          setResult(null);
          setError(
            caught instanceof ApiError &&
              (caught.code === "invalid_request" ||
                caught.code === "invalid_date_range")
              ? "Check the filters. The start date must be on or before the end date."
              : "Unable to load activity. Try refreshing the log.",
          );
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [query, refreshKey]);

  function refresh() {
    setLoading(true);
    setError("");
    setRefreshKey((key) => key + 1);
    reloadOptions();
  }

  function apply(next: Filters = draft) {
    if (next.startDate && next.endDate && next.startDate > next.endDate) {
      setError("The start date must be on or before the end date.");
      return;
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) {
      if (Array.isArray(value)) {
        for (const action of value) params.append(key, action);
      } else if (value.trim()) params.set(key, value.trim());
    }
    onQueryChange(params);
    if (params.toString() === query) refresh();
  }

  function selectPeriod(days: number | null) {
    const end = days === null ? "" : today();
    const next = {
      ...draft,
      startDate: days === null ? "" : dayOffset(end, 1 - days),
      endDate: end,
    };
    setDraft(next);
    apply(next);
  }

  function resetFilters() {
    const next = filtersFrom("");
    setDraft(next);
    onQueryChange(new URLSearchParams());
    if (!query) refresh();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    apply();
  }
  const update = (key: Exclude<keyof Filters, "action">, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const availableActions =
    options?.actions.filter(
      (action) => !draft.category || action.category === draft.category,
    ) ?? [];
  const pagination = result?.pagination;
  const first =
    pagination && pagination.total
      ? (pagination.page - 1) * pagination.pageSize + 1
      : 0;
  const last = pagination
    ? Math.min(pagination.page * pagination.pageSize, pagination.total)
    : 0;

  return (
    <section className="page-section activity-log-page">
      <div className="page-heading activity-log-heading">
        <div>
          <div className="eyebrow">OWNER OVERSIGHT</div>
          <h1>Activity log</h1>
          <p>
            Review recorded actions across your store. All dates and times are
            in Manila time.
          </p>
        </div>
        <span className="secure-badge">
          <ShieldCheck size={15} /> OWNER ACCESS
        </span>
      </div>
      <section
        className="settings-main-card activity-log-filter-card"
        aria-labelledby="activity-filters-heading"
      >
        <div className="activity-log-filter-heading">
          <h2 id="activity-filters-heading">
            <Filter size={17} /> Filter activity
          </h2>
          <div className="activity-period-buttons">
            {(
              [
                { label: "Today", days: 1 },
                { label: "7 days", days: 7 },
                { label: "30 days", days: 30 },
                { label: "All time", days: null },
              ] as const
            ).map(({ label, days }) => (
              <button
                key={label}
                type="button"
                className="button button-quiet"
                onClick={() => selectPeriod(days)}
                disabled={loading}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {optionsError && (
          <div className="banner banner-error" role="alert">
            Unable to load action and user choices.{" "}
            <button
              type="button"
              className="text-action"
              onClick={reloadOptions}
            >
              Retry
            </button>
          </div>
        )}
        <form onSubmit={submit}>
          <div className="activity-log-filters">
            <label className="activity-log-search">
              <span className="field-label">Search activity</span>
              <span className="activity-search-input">
                <Search size={16} aria-hidden="true" />
                <input
                  className="text-input"
                  type="search"
                  value={draft.q}
                  onChange={(event) => update("q", event.target.value)}
                  maxLength={160}
                  placeholder="Product, SKU, transaction, user, or reason"
                />
              </span>
            </label>
            <label>
              <span className="field-label">From date</span>
              <input
                className="text-input"
                type="date"
                value={draft.startDate}
                onChange={(event) => update("startDate", event.target.value)}
              />
            </label>
            <label>
              <span className="field-label">To date</span>
              <input
                className="text-input"
                type="date"
                value={draft.endDate}
                min={draft.startDate || undefined}
                onChange={(event) => update("endDate", event.target.value)}
              />
            </label>
            <label>
              <span className="field-label">Area</span>
              <select
                className="text-input"
                value={draft.category}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    category: event.target.value,
                    action: [],
                  }))
                }
              >
                <option value="">All areas</option>
                {activityCategories.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Recorded by</span>
              <select
                className="text-input"
                value={draft.actorId}
                onChange={(event) => update("actorId", event.target.value)}
                disabled={!options}
              >
                <option value="">All users</option>
                {options?.actors.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.username
                      ? `${actor.username} · ${actor.email}`
                      : actor.email}
                    {actor.active ? "" : " (inactive)"}
                  </option>
                ))}
                {options?.hasSystemEvents && (
                  <option value="system">System / deleted user</option>
                )}
              </select>
            </label>
            <label>
              <span className="field-label">Entries per page</span>
              <select
                className="text-input"
                value={draft.pageSize}
                onChange={(event) => update("pageSize", event.target.value)}
              >
                {[25, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset
            className="activity-action-filter"
            aria-describedby="activity-actions-help"
          >
            <legend>Actions</legend>
            <p id="activity-actions-help">
              Choose one or more actions. Leave everything unchecked to include
              all actions.
            </p>
            <div className="activity-action-tools">
              <span role="status">
                {draft.action.length
                  ? `${draft.action.length} selected`
                  : "All actions"}
              </span>
              <div>
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={!options || availableActions.length === 0}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      action: availableActions.map((action) => action.value),
                    }))
                  }
                >
                  Select all
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={draft.action.length === 0}
                  onClick={() =>
                    setDraft((current) => ({ ...current, action: [] }))
                  }
                >
                  Clear selection
                </button>
              </div>
            </div>
            {!options ? (
              <p className="activity-action-empty">Loading action choices…</p>
            ) : availableActions.length === 0 ? (
              <p className="activity-action-empty">
                No recorded actions in this area yet.
              </p>
            ) : (
              <div className="activity-action-options">
                {availableActions.map((action) => (
                  <label className="activity-action-option" key={action.value}>
                    <input
                      type="checkbox"
                      checked={draft.action.includes(action.value)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setDraft((current) => ({
                          ...current,
                          action: checked
                            ? [...current.action, action.value]
                            : current.action.filter(
                                (value) => value !== action.value,
                              ),
                        }));
                      }}
                    />
                    <span>{action.label}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="activity-log-filter-actions">
            <button
              className="button button-primary"
              type="submit"
              disabled={loading}
            >
              <Filter size={15} /> Apply filters
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={resetFilters}
              disabled={loading}
            >
              Clear filters
            </button>
          </div>
        </form>
      </section>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      <section
        className="settings-main-card activity-log-results"
        aria-labelledby="activity-results-heading"
        aria-busy={loading}
      >
        <div className="activity-log-results-heading">
          <div>
            <h2 id="activity-results-heading">Recorded activity</h2>
            <p aria-live="polite">
              {loading
                ? "Loading activity…"
                : pagination
                  ? `${pagination.total.toLocaleString("en-PH")} matching ${pagination.total === 1 ? "activity" : "activities"} · Newest first`
                  : "Activity could not be loaded"}
            </p>
          </div>
          <button
            className="button button-secondary"
            type="button"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
        {loading ? (
          <div className="activity-log-empty" role="status">
            Loading recorded activity…
          </div>
        ) : result?.events.length ? (
          <div className="activity-log-list">
            {result.events.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <div className="activity-log-empty">
            <History size={28} />
            <h3>{error ? "Activity unavailable" : "No activity found"}</h3>
            <p>
              {error
                ? "Refresh to try again."
                : "Try a different date range, user, action, or search."}
            </p>
          </div>
        )}
        {pagination && !loading && (
          <nav
            className="activity-log-pagination"
            aria-label="Activity log pagination"
          >
            <span>
              Showing {first.toLocaleString("en-PH")}–
              {last.toLocaleString("en-PH")} of{" "}
              {pagination.total.toLocaleString("en-PH")}
            </span>
            <div>
              <button
                className="button button-secondary"
                type="button"
                aria-label="Previous page"
                disabled={pagination.page <= 1}
                onClick={() => {
                  const params = new URLSearchParams(query);
                  params.set("page", String(pagination.page - 1));
                  onQueryChange(params);
                }}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                Page {pagination.page.toLocaleString("en-PH")} of{" "}
                {pagination.totalPages.toLocaleString("en-PH")}
              </span>
              <button
                className="button button-secondary"
                type="button"
                aria-label="Next page"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => {
                  const params = new URLSearchParams(query);
                  params.set("page", String(pagination.page + 1));
                  onQueryChange(params);
                }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </nav>
        )}
      </section>
    </section>
  );
}

export function ActivityLogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [options, setOptions] = useState<ActivityFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState(false);
  const [optionsKey, setOptionsKey] = useState(0);
  useEffect(() => {
    let current = true;
    void api
      .get<ActivityFilterOptions>("/audit/options")
      .then((data) => {
        if (current) {
          setOptions(data);
          setOptionsError(false);
        }
      })
      .catch(() => {
        if (current) setOptionsError(true);
      });
    return () => {
      current = false;
    };
  }, [optionsKey]);
  const query = searchParams.toString();
  return (
    <ActivityLogContent
      key={query}
      query={query}
      options={options}
      optionsError={optionsError}
      onQueryChange={(params) => setSearchParams(params)}
      reloadOptions={() => setOptionsKey((key) => key + 1)}
    />
  );
}
