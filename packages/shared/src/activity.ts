export const activityCategories = [
  {
    value: "sales",
    label: "Sales & journal",
    prefixes: ["sale.", "journal.", "checkout.stock_count_override_"],
  },
  { value: "products", label: "Products", prefixes: ["product."] },
  {
    value: "inventory",
    label: "Stock & receiving",
    prefixes: ["stock.", "inventory.", "checkout.inventory_"],
  },
  { value: "payments", label: "Payments & expenses", prefixes: ["expense."] },
  { value: "register", label: "Cash register", prefixes: ["shift."] },
  {
    value: "accounts",
    label: "Accounts & sign-ins",
    prefixes: ["auth.", "user."],
  },
  { value: "bundles", label: "Bundles", prefixes: ["sales_bundle."] },
  {
    value: "settings",
    label: "Settings",
    prefixes: ["settings.", "store.", "bnpc.", "bnpc_policy."],
  },
  { value: "backups", label: "Backups", prefixes: ["backup."] },
  { value: "reports", label: "Reports", prefixes: ["report."] },
  { value: "other", label: "Other activity", prefixes: [] },
] as const;

export type ActivityCategory = (typeof activityCategories)[number]["value"];

const activityLabels: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "user.created": "Account created",
  "user.owner_bootstrapped": "Owner account created",
  "user.password_changed": "Password changed",
  "user.activated": "Account activated",
  "user.deactivated": "Account deactivated",
  "product.created": "Product created",
  "product.updated": "Product updated",
  "product.deactivated": "Product deactivated",
  "product.deleted": "Product permanently deleted",
  "product.soft_deleted": "Product deleted from catalog",
  "stock.received": "Stock received",
  "stock.receipt_imported": "Stock receipt imported",
  "stock.adjusted": "Stock adjusted",
  "stock.written_off": "Stock written off",
  "stock.acquisition_cost_corrected": "Acquisition cost corrected",
  "stock.legacy_lots_reconciled": "Stock allocated to lots",
  "stock.lot_details_updated": "Lot details updated",
  "stock.lot_expiry_updated": "Lot expiry updated",
  "stock.lot_quarantined": "Lot quarantined",
  "stock.lot_released_from_quarantine": "Lot released from quarantine",
  "inventory.expiry_warning_updated": "Expiry warning settings updated",
  "sale.finalized": "Sale completed",
  "sale.cancelled": "Sale cancelled",
  "sale.reversed": "Sale returned or reversed",
  "sale.payment_method_switched": "Sale payment method changed",
  "sale.customer_details_prefilled": "Customer details reused",
  "sale.customer_details_viewed": "Customer details viewed",
  "journal.entry_edited": "Sales journal edited",
  "expense.recorded": "Payment or expense recorded",
  "shift.opened": "Cash register opened",
  "shift.closed": "Cash register closed",
  "shift.cash_in": "Cash added to register",
  "shift.cash_out": "Cash removed from register",
  "shift.variance_approved": "Register variance approved",
  "shift.variance_rejected": "Register variance rejected",
  "sales_bundle.created": "Bundle created",
  "sales_bundle.version_created": "Bundle updated",
  "sales_bundle.activated": "Bundle activated",
  "sales_bundle.deactivated": "Bundle deactivated",
  "settings.tax_policy.approved": "Tax policy approved",
  "store.profile_updated": "Store profile updated",
  "settings.bnpc_policy.enabled": "BNPC policy enabled",
  "settings.bnpc_policy.version_created": "BNPC policy version created",
  "checkout.inventory_override_setting_updated":
    "Stock override settings updated",
  "checkout.inventory_override_reviewed": "Stock override reviewed",
  "checkout.stock_count_override_applied": "Sale stock override applied",
  "backup.created": "Backup created",
  "backup.restored": "Backup restored",
  "report.beneficiary_list_viewed": "Beneficiary report viewed",
};

export function activityActionLabel(action: string): string {
  return (
    activityLabels[action] ?? action.replaceAll(".", " · ").replaceAll("_", " ")
  );
}

export function activityCategoryFor(action: string): ActivityCategory {
  return (
    activityCategories.find((category) =>
      category.prefixes.some((prefix) => action.startsWith(prefix)),
    )?.value ?? "other"
  );
}

export type ActivityEvent = {
  id: string;
  action: string;
  actionLabel: string;
  category: ActivityCategory;
  entityType: string;
  entityId: string;
  subject: string;
  details: Record<string, unknown>;
  createdAt: string;
  actorId: string | null;
  actorEmail: string | null;
  actorUsername: string | null;
  actorRole: "owner" | "cashier" | null;
};

export type ActivityLogResponse = {
  events: ActivityEvent[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

export type ActivityFilterOptions = {
  actions: Array<{ value: string; label: string; category: ActivityCategory }>;
  actors: Array<{
    id: string;
    email: string;
    username: string | null;
    role: "owner" | "cashier";
    active: boolean;
  }>;
  hasSystemEvents: boolean;
};
