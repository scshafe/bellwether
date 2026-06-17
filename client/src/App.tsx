import type { FormEvent, ReactElement } from "react";

import { createSession, setPassword, setUsername, signOut } from "./store/authSlice";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { fetchPortalPositions, positionsSelectors, type PortalAccount, type PortalPosition } from "./store/positionsSlice";
import { setActiveTab, type WorkspaceTab } from "./store/workspaceSlice";

const tabs: Array<{ id: WorkspaceTab; label: string; status: string }> = [
  { id: "positions", label: "Positions + P&L", status: "live" },
  { id: "decisions", label: "Decision Log", status: "P4c" },
  { id: "control", label: "Agent Control", status: "P4d" }
];

export function App(): ReactElement {
  const dispatch = useAppDispatch();
  const auth = useAppSelector((state) => state.auth);
  const activeTab = useAppSelector((state) => state.workspace.activeTab);

  const submitSession = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void dispatch(createSession())
      .unwrap()
      .then(() => dispatch(fetchPortalPositions()));
  };

  return (
    <main className="app-shell">
      <section className="masthead">
        <div>
          <p className="eyebrow">Bellwether Portal</p>
          <h1>Agent Trading Platform</h1>
        </div>
        <div className="session-card">
          {auth.user ? (
            <>
              <span className="label">Session</span>
              <strong>{auth.user.displayName}</strong>
              <code>{auth.user.role}</code>
              <button type="button" className="ghost" onClick={() => dispatch(signOut())}>
                Sign out
              </button>
            </>
          ) : (
            <span className="muted">Authenticate to read portal data.</span>
          )}
        </div>
      </section>

      {!auth.token ? (
        <LoginPanel onSubmit={submitSession} />
      ) : (
        <section className="workspace">
          <nav className="tabs" aria-label="Portal workspace">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={tab.id === activeTab ? "tab active" : "tab"}
                onClick={() => dispatch(setActiveTab(tab.id))}
                aria-pressed={tab.id === activeTab}
              >
                <span>{tab.label}</span>
                <code>{tab.status}</code>
              </button>
            ))}
          </nav>

          {activeTab === "positions" ? <PositionsWorkspace /> : <DeferredWorkspace tab={activeTab} />}
        </section>
      )}
    </main>
  );
}

function LoginPanel({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }): ReactElement {
  const dispatch = useAppDispatch();
  const { username, password, status, error } = useAppSelector((state) => state.auth);

  return (
    <form className="login-panel" onSubmit={onSubmit}>
      <div>
        <p className="eyebrow">Portal Session</p>
        <h2>POST /auth/session</h2>
        <p className="muted">Use the admin, manager, or viewer seeded in the running server environment.</p>
      </div>
      <label>
        Username
        <input value={username} onChange={(event) => dispatch(setUsername(event.target.value))} autoComplete="username" />
      </label>
      <label>
        Password
        <input
          value={password}
          onChange={(event) => dispatch(setPassword(event.target.value))}
          type="password"
          autoComplete="current-password"
        />
      </label>
      <button type="submit" disabled={status === "loading"}>
        {status === "loading" ? "Opening..." : "Open Portal"}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}

function PositionsWorkspace(): ReactElement {
  const dispatch = useAppDispatch();
  const account = useAppSelector((state) => state.positions.account);
  const status = useAppSelector((state) => state.positions.status);
  const error = useAppSelector((state) => state.positions.error);
  const refreshedAt = useAppSelector((state) => state.positions.refreshedAt);
  const positions = useAppSelector(positionsSelectors.selectAll);

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">GET /portal/positions</p>
          <h2>Positions + Daily P&amp;L</h2>
        </div>
        <button type="button" onClick={() => dispatch(fetchPortalPositions())} disabled={status === "loading"}>
          {status === "loading" ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {refreshedAt ? <p className="muted">Last refresh {new Date(refreshedAt).toLocaleString()}</p> : null}

      {account ? <AccountGrid account={account} /> : <p className="empty">No account snapshot loaded yet. Use Refresh.</p>}
      <PositionsTable positions={positions} />
    </section>
  );
}

function AccountGrid({ account }: { account: PortalAccount }): ReactElement {
  return (
    <section className="metric-grid" aria-label="Account metrics">
      <Metric label="Equity" value={formatMoney(account.equity)} raw={account.equity} />
      <Metric label="Cash" value={formatMoney(account.cash)} raw={account.cash} />
      <Metric label="Buying Power" value={formatMoney(account.buyingPower)} raw={account.buyingPower} />
      <Metric label="Portfolio" value={formatMoney(account.portfolioValue)} raw={account.portfolioValue} />
      <Metric label="Daily P&L" value={formatMoney(account.dailyPnl)} raw={account.dailyPnl} tone={Number(account.dailyPnl) >= 0 ? "gain" : "loss"} />
      <Metric label="Account ID" value={account.id} raw={account.status} compact />
    </section>
  );
}

function Metric({ label, value, raw, tone, compact = false }: { label: string; value: string; raw: string; tone?: "gain" | "loss"; compact?: boolean }): ReactElement {
  return (
    <article className={tone ? `metric ${tone}` : "metric"}>
      <span>{label}</span>
      <strong className={compact ? "compact" : undefined}>{value}</strong>
      <code>{raw}</code>
    </article>
  );
}

function PositionsTable({ positions }: { positions: PortalPosition[] }): ReactElement {
  if (positions.length === 0) {
    return <p className="empty">No open positions returned by the broker.</p>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Qty</th>
            <th>Market Value</th>
            <th>Avg Entry</th>
            <th>Unrealized P&L</th>
            <th>Unrealized %</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.symbol}>
              <td><code>{position.symbol}</code></td>
              <td>{position.qty}</td>
              <td>{formatMoney(position.marketValue)}</td>
              <td>{formatMoney(position.avgEntryPrice)}</td>
              <td className={Number(position.unrealizedPl) >= 0 ? "gain-text" : "loss-text"}>{formatMoney(position.unrealizedPl)}</td>
              <td>{formatPercent(position.unrealizedPlpc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeferredWorkspace({ tab }: { tab: Exclude<WorkspaceTab, "positions"> }): ReactElement {
  const label = tab === "decisions" ? "P4c decision-log view" : "P4d start/stop control";

  return (
    <section className="panel placeholder-panel">
      <p className="eyebrow">Not Rendered Until Selected</p>
      <h2>{label}</h2>
      <p className="muted">This tab is a structural slot for the next Portal-MVP slice. No hidden subtree is mounted for inactive workspaces.</p>
    </section>
  );
}

function formatMoney(raw: string): string {
  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return raw;
  }

  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
}

function formatPercent(raw: string | undefined): string {
  if (!raw) {
    return "-";
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return raw;
  }

  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 }).format(value);
}
