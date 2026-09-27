import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  Boxes,
  ClipboardList,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageSearch,
  ShieldCheck,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import type { User } from "@medtryx/shared";
import { api, ApiError } from "./api";
import { useAuth } from "./auth-context";

const navigation = [
  { to: "/checkout", label: "Checkout", icon: WalletCards, ownerOnly: false },
  { to: "/account", label: "My account", icon: KeyRound, ownerOnly: false },
  { to: "/products", label: "Products", icon: PackageSearch, ownerOnly: true },
  { to: "/stock", label: "Stock", icon: Boxes, ownerOnly: true },
  {
    to: "/sales",
    label: "Sales history",
    icon: ClipboardList,
    ownerOnly: true,
  },
  { to: "/reports", label: "Reports", icon: LayoutDashboard, ownerOnly: true },
  { to: "/settings", label: "Settings", icon: ShieldCheck, ownerOnly: true },
];

function Guard({ ownerOnly = false }: { ownerOnly?: boolean }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready)
    return <div className="loading-screen">Loading your secure workspace…</div>;
  if (!user)
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (ownerOnly && user.role !== "owner")
    return <Navigate to="/checkout" replace />;
  return <Outlet />;
}

function Layout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  if (!user) return null;

  async function handleSignOut() {
    await signOut().catch(() => undefined);
    navigate("/login", { replace: true });
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <Link
          className="brand"
          to="/checkout"
          onClick={() => setMenuOpen(false)}
        >
          <span className="brand-mark">M</span>
          <span>
            <strong>medtryx</strong>
            <small>PHARMACY OPERATIONS</small>
          </span>
        </Link>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          {navigation
            .filter((item) => !item.ownerOnly || user.role === "owner")
            .map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className={`nav-link ${location.pathname.startsWith(to) ? "nav-link-active" : ""}`}
                onClick={() => setMenuOpen(false)}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{label}</span>
                {to === "/checkout" && <span className="nav-shortcut">F1</span>}
              </Link>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="network-status">
            <span className="status-dot" />
            <span>Local network ready</span>
          </div>
          <div className="profile-row">
            <div className="avatar">{user.email.slice(0, 1).toUpperCase()}</div>
            <div className="profile-copy">
              <strong>{user.email}</strong>
              <span>{user.role === "owner" ? "Store owner" : "Cashier"}</span>
            </div>
            <button
              className="icon-button signout-button"
              onClick={() => void handleSignOut()}
              aria-label="Sign out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      {menuOpen && (
        <button
          className="mobile-scrim"
          onClick={() => setMenuOpen(false)}
          aria-label="Close menu"
        />
      )}
      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button mobile-menu-button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="breadcrumb">
            <span>Medtryx</span>
            <ArrowRight size={13} />
            <strong>{pageTitle(location.pathname)}</strong>
          </div>
          <div className="topbar-meta">
            <span className="today-label">PHILIPPINE STANDARD TIME</span>
            <span className="live-indicator">
              <span />
              System online
            </span>
          </div>
        </header>
        <div className="page-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function pageTitle(path: string): string {
  return navigation.find((item) => item.to === path)?.label ?? "Settings";
}

function LoginPage() {
  const { user, ready, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const passwordChanged =
    new URLSearchParams(location.search).get("passwordChanged") === "1" ||
    (location.state as { passwordChanged?: boolean } | null)?.passwordChanged;

  if (!ready)
    return <div className="loading-screen">Preparing secure sign in…</div>;
  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? "/checkout"} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await signIn(email, password);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 429
          ? "Too many attempts. Please try again later."
          : "Email or password is incorrect.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <section className="login-story">
        <div className="brand brand-light">
          <span className="brand-mark">M</span>
          <span>
            <strong>medtryx</strong>
            <small>PHARMACY OPERATIONS</small>
          </span>
        </div>
        <div className="story-content">
          <div className="eyebrow">
            <span /> STORE OPERATIONS PLATFORM
          </div>
          <h1>
            Good care starts
            <br />
            with a <em>clear view.</em>
          </h1>
          <p>
            Sales, stock, and daily operations in one calm workspace built for
            your pharmacy team.
          </p>
          <div className="story-points">
            <div>
              <ShieldCheck size={17} />
              <span>Private to your pharmacy network</span>
            </div>
            <div>
              <Activity size={17} />
              <span>Every action has a clear record</span>
            </div>
          </div>
        </div>
        <div className="story-footer">A better view of every day.</div>
      </section>
      <section className="login-panel">
        <div className="login-mobile-brand brand">
          <span className="brand-mark">M</span>
          <span>
            <strong>medtryx</strong>
            <small>PHARMACY OPERATIONS</small>
          </span>
        </div>
        <div className="login-form-wrap">
          <div className="eyebrow login-eyebrow">WELCOME BACK</div>
          <h2>Sign in to Medtryx</h2>
          <p className="muted">
            Use your individual staff account to continue.
          </p>
          {passwordChanged && (
            <div className="banner banner-success login-notice" role="status">
              Password changed. Sign in with your new password.
            </div>
          )}
          <form
            className="form-stack login-form"
            onSubmit={(event) => void handleSubmit(event)}
          >
            <label className="field-label" htmlFor="login-email">
              Email address
            </label>
            <input
              id="login-email"
              className="text-input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus
            />
            <div className="password-label-row">
              <label className="field-label" htmlFor="login-password">
                Password
              </label>
              <span>Staff account</span>
            </div>
            <input
              id="login-password"
              className="text-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button
              className="button button-primary login-submit"
              type="submit"
              disabled={submitting}
            >
              {submitting ? "Signing in…" : "Sign in"}
              <ArrowRight size={17} />
            </button>
          </form>
          <div className="privacy-note">
            <ShieldCheck size={16} />
            <span>Secure session · Your account activity is recorded</span>
          </div>
        </div>
        <div className="login-footnote">
          Medtryx records internal store activity. It does not issue official
          invoices.
        </div>
      </section>
    </div>
  );
}

function PlaceholderPage({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: typeof Boxes;
}) {
  return (
    <section className="page-section">
      <div className="page-heading">
        <div>
          <div className="eyebrow">STORE WORKSPACE</div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      <div className="empty-state-card">
        <div className="empty-icon">
          <Icon size={23} strokeWidth={1.7} />
        </div>
        <span className="status-pill status-planned">FOUNDATION READY</span>
        <h2>This workspace is ready for its feature bundle</h2>
        <p>
          Sign-in, secure sessions, roles, and audit history are active. This
          screen will be completed as its roadmap bundle is built.
        </p>
      </div>
    </section>
  );
}

type AuditEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  details: unknown;
  createdAt: string;
  actorEmail: string | null;
};

function AccountPage() {
  const { user, changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      window.location.replace("/login?passwordChanged=1");
    } catch (caught) {
      setError(
        caught instanceof ApiError &&
          caught.code === "current_password_incorrect"
          ? "Your current password is incorrect."
          : "Unable to change the password. Use at least 12 characters.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-section account-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PERSONAL SECURITY</div>
          <h1>My account</h1>
          <p>Update your sign-in credentials for this staff account.</p>
        </div>
      </div>
      <div className="account-grid">
        <div className="settings-main-card account-identity">
          <div className="avatar avatar-large">
            {user?.email.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <span className="eyebrow">SIGNED IN AS</span>
            <h2>{user?.email}</h2>
            <span className={`role-chip role-${user?.role}`}>{user?.role}</span>
          </div>
        </div>
        <div className="create-card password-card">
          <div className="create-card-icon">
            <KeyRound size={18} />
          </div>
          <h2>Change password</h2>
          <p>
            For your protection, this signs out all active sessions for this
            account.
          </p>
          <form className="form-stack" onSubmit={(event) => void submit(event)}>
            <label className="field-label" htmlFor="current-password">
              Current password
            </label>
            <input
              id="current-password"
              className="text-input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
            <label className="field-label" htmlFor="new-password">
              New password
            </label>
            <input
              id="new-password"
              className="text-input"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
            <label className="field-label" htmlFor="confirm-password">
              Confirm new password
            </label>
            <input
              id="confirm-password"
              className="text-input"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button
              className="button button-primary create-submit"
              type="submit"
              disabled={saving}
            >
              {saving ? "Updating…" : "Update password"}
              <ArrowRight size={16} />
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

function SettingsPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"cashier" | "owner">("cashier");
  const [saving, setSaving] = useState(false);

  async function loadSettings() {
    const [userData, auditData] = await Promise.all([
      api.get<{ users: User[] }>("/users"),
      api.get<{ events: AuditEvent[] }>("/audit?limit=12"),
    ]);
    setUsers(userData.users);
    setEvents(auditData.events);
  }

  useEffect(() => {
    let active = true;
    // Fetching persisted account data is the intended synchronization effect here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSettings()
      .catch(() => {
        if (active) setError("Unable to load staff settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      await api.post("/users", { email, password, role });
      setEmail("");
      setPassword("");
      setNotice("Staff account created.");
      await loadSettings();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "email_already_exists"
          ? "That email already has an account."
          : "Unable to create the account. Check the details and try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleUser(user: User) {
    setError("");
    setNotice("");
    try {
      await api.post(`/users/${user.id}/active`, { active: !user.isActive });
      setNotice(
        user.isActive
          ? "Staff account deactivated."
          : "Staff account reactivated.",
      );
      await loadSettings();
    } catch {
      setError(
        "Unable to update that account. The last active owner cannot be deactivated.",
      );
    }
  }

  return (
    <section className="page-section">
      <div className="page-heading">
        <div>
          <div className="eyebrow">OWNER CONTROLS</div>
          <h1>Settings</h1>
          <p>Manage staff access and review protected account activity.</p>
        </div>
        <span className="secure-badge">
          <ShieldCheck size={15} /> OWNER ACCESS
        </span>
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
      <div className="settings-grid">
        <div className="settings-main-card">
          <div className="card-heading">
            <div>
              <h2>Staff accounts</h2>
              <p>Each person signs in with an individual account.</p>
            </div>
            <span className="count-chip">
              <Users size={14} />
              {users.length} accounts
            </span>
          </div>
          {loading ? (
            <div className="table-loading">Loading staff accounts…</div>
          ) : (
            <div className="staff-list">
              <div className="staff-table-head">
                <span>STAFF MEMBER</span>
                <span>ROLE</span>
                <span>STATUS</span>
                <span>ACTION</span>
              </div>
              {users.map((user) => (
                <div className="staff-row" key={user.id}>
                  <div className="staff-person">
                    <span className="avatar avatar-small">
                      {user.email.slice(0, 1).toUpperCase()}
                    </span>
                    <span>
                      <strong>{user.email}</strong>
                      <small>
                        Added {new Date(user.createdAt).toLocaleDateString()}
                      </small>
                    </span>
                  </div>
                  <span className={`role-chip role-${user.role}`}>
                    {user.role}
                  </span>
                  <span
                    className={`account-status ${user.isActive ? "account-active" : "account-inactive"}`}
                  >
                    <span />
                    {user.isActive ? "Active" : "Inactive"}
                  </span>
                  <button
                    className="text-action"
                    onClick={() => void toggleUser(user)}
                  >
                    {user.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              ))}
              {!users.length && (
                <div className="table-loading">No accounts yet.</div>
              )}
            </div>
          )}
        </div>
        <div className="create-card">
          <div className="create-card-icon">
            <Users size={19} />
          </div>
          <h2>Add a staff member</h2>
          <p>Create individual access for an owner or cashier.</p>
          <form
            className="form-stack"
            onSubmit={(event) => void createUser(event)}
          >
            <label className="field-label" htmlFor="staff-email">
              Email address
            </label>
            <input
              id="staff-email"
              className="text-input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={254}
            />
            <label className="field-label" htmlFor="staff-password">
              Temporary password
            </label>
            <input
              id="staff-password"
              className="text-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
            />
            <small className="field-hint">
              Use at least 12 characters. The staff member can change it after
              signing in.
            </small>
            <label className="field-label" htmlFor="staff-role">
              Role
            </label>
            <select
              id="staff-role"
              className="text-input select-input"
              value={role}
              onChange={(event) =>
                setRole(event.target.value as "cashier" | "owner")
              }
            >
              <option value="cashier">Cashier · sales access</option>
              <option value="owner">Owner · full access</option>
            </select>
            <button
              className="button button-primary create-submit"
              type="submit"
              disabled={saving}
            >
              {saving ? "Creating…" : "Create account"}
              <ArrowRight size={16} />
            </button>
          </form>
        </div>
      </div>
      <div className="activity-card">
        <div className="card-heading">
          <div>
            <h2>Recent account activity</h2>
            <p>Protected actions are recorded for the owner.</p>
          </div>
          <span className="activity-icon">
            <Activity size={17} />
          </span>
        </div>
        {loading ? (
          <div className="table-loading">Loading activity…</div>
        ) : events.length ? (
          <div className="activity-list">
            {events.map((event) => (
              <div className="activity-row" key={event.id}>
                <span className="activity-marker">
                  <ArrowDownLeft size={14} />
                </span>
                <span>
                  <strong>{event.action.replaceAll(".", " · ")}</strong>
                  <small>
                    {event.actorEmail ?? "System"} · {event.entityType} ·{" "}
                    {new Date(event.createdAt).toLocaleString()}
                  </small>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="table-loading">No account activity recorded yet.</div>
        )}
      </div>
    </section>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Guard />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/checkout" replace />} />
          <Route
            path="checkout"
            element={
              <PlaceholderPage
                title="Checkout"
                description="Start a sale by selecting active products from your store catalog."
                icon={WalletCards}
              />
            }
          />
          <Route path="account" element={<AccountPage />} />
          <Route element={<Guard ownerOnly />}>
            <Route
              path="products"
              element={
                <PlaceholderPage
                  title="Products"
                  description="Manage the pharmacy catalog and selling prices."
                  icon={PackageSearch}
                />
              }
            />
            <Route
              path="stock"
              element={
                <PlaceholderPage
                  title="Stock"
                  description="Receive stock, record adjustments, and review inventory value."
                  icon={Boxes}
                />
              }
            />
            <Route
              path="sales"
              element={
                <PlaceholderPage
                  title="Sales history"
                  description="Review internal sale records and transaction details."
                  icon={ClipboardList}
                />
              }
            />
            <Route
              path="reports"
              element={
                <PlaceholderPage
                  title="Reports"
                  description="Review daily sales, cash declarations, stock, and estimated gross profit."
                  icon={LayoutDashboard}
                />
              }
            />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/checkout" replace />} />
    </Routes>
  );
}
