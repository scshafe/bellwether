import type { FormEvent, ReactElement, ReactNode } from "react";

import { createSession, setPassword, setUsername, signOut } from "./store/authSlice";
import { decisionsSelectors, fetchPortalDecisions, type PortalBrokerOrder, type PortalDecision, type PortalProposedOrder, type PortalQualitativeEvidence } from "./store/decisionsSlice";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { fetchPortalPositions, positionsSelectors, type PortalAccount, type PortalPosition } from "./store/positionsSlice";
import { fetchRuntimeStatus, startAgentRuntime, stopAgentRuntime, type RuntimeStateSnapshot } from "./store/runtimeSlice";
import { setActiveTab, type WorkspaceTab } from "./store/workspaceSlice";

const tabs: Array<{ id: WorkspaceTab; label: string; status: string }> = [
  { id: "positions", label: "Positions + P&L", status: "live" },
  { id: "decisions", label: "Decision Log", status: "live" },
  { id: "control", label: "Agent Control", status: "P4d" }
];

export function App(): ReactElement {
  const dispatch = useAppDispatch();
  const auth = useAppSelector((state) => state.auth);
  const activeTab = useAppSelector((state) => state.workspace.activeTab);
  const canManageRuntime = auth.user ? isRuntimeManager(auth.user.role) : false;
  const visibleTabs = canManageRuntime ? tabs : tabs.filter((tab) => tab.id !== "control");

  const submitSession = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void dispatch(createSession())
      .unwrap()
      .then(() => {
        void dispatch(fetchPortalPositions());
        void dispatch(fetchPortalDecisions());
        void dispatch(fetchRuntimeStatus());
      });
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
            {visibleTabs.map((tab) => (
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

          {activeTab === "decisions" ? <DecisionsWorkspace /> : null}
          {activeTab === "control" && canManageRuntime ? <ControlWorkspace /> : null}
          {activeTab === "positions" || (activeTab === "control" && !canManageRuntime) ? <PositionsWorkspace /> : null}
        </section>
      )}
    </main>
  );
}

function DecisionsWorkspace(): ReactElement {
  const dispatch = useAppDispatch();
  const status = useAppSelector((state) => state.decisions.status);
  const error = useAppSelector((state) => state.decisions.error);
  const refreshedAt = useAppSelector((state) => state.decisions.refreshedAt);
  const decisions = useAppSelector(decisionsSelectors.selectAll);

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">GET /portal/decisions</p>
          <h2>Glass-Box Decision Log</h2>
        </div>
        <button type="button" onClick={() => dispatch(fetchPortalDecisions())} disabled={status === "loading"}>
          {status === "loading" ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {refreshedAt ? <p className="muted">Last refresh {new Date(refreshedAt).toLocaleString()}</p> : null}

      {decisions.length === 0 ? <DecisionEmptyState status={status} /> : <DecisionList decisions={decisions} />}
    </section>
  );
}

function DecisionEmptyState({ status }: { status: "idle" | "loading" | "succeeded" | "failed" }): ReactElement {
  if (status === "loading") {
    return <p className="empty">Loading the decision log...</p>;
  }

  return (
    <section className="empty decision-empty">
      <p className="eyebrow">No Decisions Yet</p>
      <h3>The glass-box log is empty.</h3>
      <p>
        No live cycle writes decisions until P4d starts the agent runtime. Refresh will show persisted entries as soon as the backend returns them.
      </p>
    </section>
  );
}

function DecisionList({ decisions }: { decisions: PortalDecision[] }): ReactElement {
  return (
    <div className="decision-list">
      {decisions.map((decision) => (
        <DecisionCard key={decision.id} decision={decision} />
      ))}
    </div>
  );
}

function DecisionCard({ decision }: { decision: PortalDecision }): ReactElement {
  return (
    <article className="decision-card">
      <header className="decision-card-header">
        <div>
          <p className="eyebrow">{decision.quantSignal.symbol} Decision</p>
          <h3>{decision.execution.decision}</h3>
        </div>
        <div className="id-stack">
          <code>{decision.id}</code>
          <span>{formatDateTime(decision.createdAt)}</span>
        </div>
      </header>

      <div className="decision-meta">
        <Meta label="Cycle" value={decision.cycleId} />
        <Meta label="Strategy" value={decision.strategyId} />
        <Meta label="Signal As Of" value={formatDateTime(decision.quantSignal.asOf)} />
      </div>

      <div className="glass-grid">
        <GlassBox title="Quant Signal" eyebrow="score / signals / sizing">
          <Metric label="Score" value={formatNumber(decision.quantSignal.score)} raw={String(decision.quantSignal.score)} />
          <KeyValueList title="Signals" values={decision.quantSignal.signals} />
          <KeyValueList title="Sizing" values={decision.quantSignal.sizing} />
        </GlassBox>

        <GlassBox title="Analyst Thesis" eyebrow="strategy analyst">
          <p>{decision.strategyAnalyst.thesis}</p>
          <OrderSummary order={decision.strategyAnalyst.proposedOrder} title="Proposed Order" />
        </GlassBox>

        <GlassBox title="Risk Verdict" eyebrow={decision.risk.approved ? "approved" : "rejected"} tone={decision.risk.approved ? "gain" : "loss"}>
          <p>{decision.risk.rationale}</p>
          <DeterministicViolations violations={decision.risk.deterministicViolations} />
        </GlassBox>

        <GlassBox title="Execution" eyebrow={decision.execution.decision}>
          <p>{decision.execution.rationale}</p>
          {decision.execution.order ? <BrokerOrderSummary order={decision.execution.order} /> : null}
          {decision.execution.brokerRejection ? <p className="rejection">Broker rejection: {decision.execution.brokerRejection}</p> : null}
          {!decision.execution.order && !decision.execution.brokerRejection ? <p className="muted">No broker order was returned for this decision.</p> : null}
        </GlassBox>
      </div>

      <QualitativeSlot evidence={decision.qualitativeEvidence} />
    </article>
  );
}

function GlassBox({ title, eyebrow, tone, children }: { title: string; eyebrow: string; tone?: "gain" | "loss"; children: ReactNode }): ReactElement {
  return (
    <section className={tone ? `glass-box ${tone}` : "glass-box"}>
      <p className="eyebrow">{eyebrow}</p>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div>
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function KeyValueList({ title, values }: { title: string; values: Record<string, string | number | boolean | null> }): ReactElement {
  const entries = Object.entries(values).filter(([, value]) => value !== null && value !== undefined);

  if (entries.length === 0) {
    return <p className="muted">No {title.toLowerCase()} returned.</p>;
  }

  return (
    <div className="kv-block">
      <strong>{title}</strong>
      <dl>
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{splitCamel(key)}</dt>
            <dd>{typeof value === "number" ? formatNumber(value) : String(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function OrderSummary({ order, title }: { order: PortalProposedOrder; title: string }): ReactElement {
  return (
    <div className="order-summary">
      <strong>{title}</strong>
      <code>{order.symbol}</code>
      <span>{order.side} {order.qty} @ {formatMoney(String(order.limitPrice))}</span>
      <span>Notional {formatMoney(String(order.estimatedNotional))}</span>
    </div>
  );
}

function BrokerOrderSummary({ order }: { order: PortalBrokerOrder }): ReactElement {
  return (
    <div className="order-summary">
      <strong>Broker Order</strong>
      <code>{order.id}</code>
      {order.clientOrderId ? <code>{order.clientOrderId}</code> : null}
      <span>{order.status}: {order.side} {order.qty} {order.symbol} {order.type}</span>
    </div>
  );
}

function DeterministicViolations({ violations }: { violations: string[] }): ReactElement {
  if (violations.length === 0) {
    return <p className="muted">No deterministic violations.</p>;
  }

  return (
    <ul className="violations">
      {violations.map((violation) => (
        <li key={violation}>{violation}</li>
      ))}
    </ul>
  );
}

function QualitativeSlot({ evidence }: { evidence?: PortalQualitativeEvidence }): ReactElement {
  const hasEvidence = Boolean(evidence && (evidence.links.length > 0 || evidence.quotes.length > 0 || evidence.signals.length > 0));

  return (
    <section className="qualitative-slot">
      <div>
        <p className="eyebrow">P5 Content-Policy Slot</p>
        <h4>Qualitative Sources</h4>
      </div>
      {!hasEvidence ? (
        <p className="muted">No links, short attributed quotes, or agent-derived qualitative signals were returned for this decision.</p>
      ) : (
        <div className="qualitative-grid">
          {evidence?.links.map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.title}{link.source ? ` (${link.source})` : ""}</a>
          ))}
          {evidence?.quotes.map((quote) => (
            <blockquote key={`${quote.source}:${quote.quote}`}>"{quote.quote}" <cite>{quote.source}</cite></blockquote>
          ))}
          {evidence?.signals.map((signal) => (
            <span key={`${signal.label}:${signal.value}`}>{signal.label}: {signal.value}{signal.source ? ` (${signal.source})` : ""}</span>
          ))}
        </div>
      )}
    </section>
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

function ControlWorkspace(): ReactElement {
  const dispatch = useAppDispatch();
  const snapshot = useAppSelector((state) => state.runtime.snapshot);
  const status = useAppSelector((state) => state.runtime.status);
  const mutationStatus = useAppSelector((state) => state.runtime.mutationStatus);
  const error = useAppSelector((state) => state.runtime.error);
  const refreshedAt = useAppSelector((state) => state.runtime.refreshedAt);
  const running = snapshot?.state === "running";
  const busy = status === "loading" || mutationStatus === "loading";

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">POST /portal/runtime/start | stop</p>
          <h2>Agent Runtime Control</h2>
        </div>
        <div className="control-actions">
          <button type="button" className="ghost" onClick={() => dispatch(fetchRuntimeStatus())} disabled={busy}>
            {status === "loading" ? "Refreshing..." : "Refresh"}
          </button>
          <button type="button" onClick={() => dispatch(startAgentRuntime())} disabled={busy || running}>
            {mutationStatus === "loading" && !running ? "Starting..." : "Start One Cycle"}
          </button>
          <button type="button" className="danger" onClick={() => dispatch(stopAgentRuntime())} disabled={busy || !running}>
            {mutationStatus === "loading" && running ? "Stopping..." : "Stop"}
          </button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {refreshedAt ? <p className="muted">Last refresh {new Date(refreshedAt).toLocaleString()}</p> : null}
      {snapshot ? <RuntimeStatusCard snapshot={snapshot} /> : <p className="empty">No runtime status loaded yet. Use Refresh.</p>}
      <p className="muted">Start enqueues exactly one live paper-trading cycle. Use the Decision Log refresh after the worker completes to see the persisted glass-box entry.</p>
    </section>
  );
}

function RuntimeStatusCard({ snapshot }: { snapshot: RuntimeStateSnapshot }): ReactElement {
  return (
    <section className={snapshot.state === "running" ? "runtime-card running" : "runtime-card stopped"}>
      <div>
        <p className="eyebrow">Runtime</p>
        <h3>{snapshot.state}</h3>
      </div>
      <div className="runtime-grid">
        <Meta label="Active Job" value={snapshot.activeJobId ?? "none"} />
        <Meta label="Updated" value={formatDateTime(snapshot.updatedAt)} />
        <Meta label="Last Outcome" value={snapshot.lastCycle?.status ?? "none"} />
        <Meta label="Decision Log" value={snapshot.lastCycle?.decisionLogId ?? "none"} />
      </div>
      {snapshot.lastCycle ? <p>{snapshot.lastCycle.summary}</p> : <p className="muted">No completed cycle outcome recorded yet.</p>}
    </section>
  );
}

function isRuntimeManager(role: string): boolean {
  return role === "admin" || role === "manager";
}

function formatMoney(raw: string): string {
  const value = Number(raw);

  if (!Number.isFinite(value)) {
    return raw;
  }

  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
}

function formatNumber(raw: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(raw);
}

function formatDateTime(raw: string): string {
  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return date.toLocaleString();
}

function splitCamel(raw: string): string {
  return raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
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
