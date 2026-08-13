import { useEffect } from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";

import { quantPlaybookParameterKeys, type QuantPlaybookParameterKey, type QuantPlaybookParameters } from "./quantPlaybookParameters";
import { bootstrapSession, createSession, setPassword, setUsername, signOut, TRUSTED_PROXY_TOKEN } from "./store/authSlice";
import { decisionsSelectors, fetchPortalDecisions, type PortalBrokerOrder, type PortalDecision, type PortalProposedOrder, type PortalQualitativeEvidence } from "./store/decisionsSlice";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { fetchPortalPositions, positionsSelectors, strategyPerformanceSelectors, type PortalAccount, type PortalPosition, type PortalStrategyPerformanceSummary } from "./store/positionsSlice";
import { acceptProposal, dismissProposal, fetchPortalProposals, proposalsSelectors, type StrategyProposalRecord } from "./store/proposalsSlice";
import {
  createSource,
  deleteSource,
  fetchRoster,
  rosterSelectors,
  updateSource,
  updateSourceCreateDraftField,
  updateSourceCreateDraftRating,
  updateSourceCreateDraftType,
  type SourceCreateDraft,
  type SourceRecord,
  type SourceType
} from "./store/rosterSlice";
import { fetchRuntimeStatus, startAgentRuntime, stopAgentRuntime, type RuntimeStateSnapshot } from "./store/runtimeSlice";
import {
  clearStrategyEditDraft,
  createPortalStrategy,
  fetchPortalStrategies,
  loadStrategyEditDraft,
  selectStrategy,
  setStrategiesView,
  strategiesSelectors,
  transitionPortalStrategy,
  updateCreateDraftField,
  updateCreateDraftParameter,
  updateEditDraftField,
  updateEditDraftParameter,
  updatePortalStrategy,
  type StrategyAction,
  type StrategyDraft,
  type StrategyRecord,
  type StrategyStatus
} from "./store/strategiesSlice";
import {
  fetchStrategyChatThread,
  postStrategyChatMessage,
  setStrategyChatDraft,
  setStrategyChatMode,
  type StrategyChatMessage,
  type StrategyChatMetadata,
  type StrategyChatMode
} from "./store/strategyChatSlice";
import { setActiveTab, type WorkspaceTab } from "./store/workspaceSlice";

const tabs: Array<{ id: WorkspaceTab; label: string; status: string }> = [
  { id: "positions", label: "Positions + P&L", status: "live" },
  { id: "decisions", label: "Decision Log", status: "live" },
  { id: "proposals", label: "Proposals", status: "P8e2" },
  { id: "roster", label: "Analyst Roster", status: "P7c" },
  { id: "strategies", label: "Strategy Workbench", status: "P6d" },
  { id: "control", label: "Agent Control", status: "P4d" }
];

export function App(): ReactElement {
  const dispatch = useAppDispatch();
  const auth = useAppSelector((state) => state.auth);
  const activeTab = useAppSelector((state) => state.workspace.activeTab);
  const canManageRuntime = auth.user ? isRuntimeManager(auth.user.role) : false;
  const canManageProposals = canManageRuntime;
  const visibleTabs = canManageRuntime ? tabs : tabs.filter((tab) => tab.id !== "control");

  const loadPortalData = () => {
    void dispatch(fetchPortalPositions());
    void dispatch(fetchPortalDecisions());
    void dispatch(fetchPortalProposals());
    void dispatch(fetchRoster());
    void dispatch(fetchRuntimeStatus());
    void dispatch(fetchPortalStrategies());
  };

  const submitSession = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void dispatch(createSession()).unwrap().then(loadPortalData);
  };

  // Ambient-session probe: behind the OIDC proxy this succeeds immediately
  // and the login panel never renders; in password mode it 401s and the app
  // behaves exactly as before. Mount-once by design.
  useEffect(() => {
    void dispatch(bootstrapSession()).unwrap().then(loadPortalData).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="app-shell">
      <section className="masthead">
        <div className="brand">
          <button
            type="button"
            className="brand-button"
            onClick={() => dispatch(setActiveTab("positions"))}
            aria-label="Bellwether — home"
            title="Bellwether"
          >
            <img src="/icon.svg" alt="" className="brand-logo" width="44" height="44" />
          </button>
          <div className="brand-text">
            <p className="eyebrow">Bellwether Portal</p>
            <h1>Agent Trading Platform</h1>
          </div>
        </div>
        <div className="session-card">
          {auth.user ? (
            <>
              <span className="label">Session</span>
              <strong>{auth.user.displayName}</strong>
              <code>{auth.user.role}</code>
              {auth.token === TRUSTED_PROXY_TOKEN ? null : (
                <button type="button" className="ghost" onClick={() => dispatch(signOut())}>
                  Sign out
                </button>
              )}
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
          {activeTab === "proposals" ? <ProposalsWorkspace canManageProposals={canManageProposals} /> : null}
          {activeTab === "roster" ? <RosterWorkspace canManageRoster={canManageRuntime} /> : null}
          {activeTab === "strategies" ? <StrategiesWorkspace canManageStrategies={canManageRuntime} /> : null}
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

function ProposalsWorkspace({ canManageProposals }: { canManageProposals: boolean }): ReactElement {
  const dispatch = useAppDispatch();
  const proposals = useAppSelector(proposalsSelectors.selectAll);
  const status = useAppSelector((state) => state.proposals.status);
  const mutationStatus = useAppSelector((state) => state.proposals.mutationStatus);
  const error = useAppSelector((state) => state.proposals.error);
  const refreshedAt = useAppSelector((state) => state.proposals.refreshedAt);

  return (
    <section className="panel strategies-workbench">
      <header className="panel-header">
        <div>
          <p className="eyebrow">GET /portal/proposals</p>
          <h2>Proposals</h2>
        </div>
        <button type="button" className="ghost" onClick={() => dispatch(fetchPortalProposals())} disabled={status === "loading"}>
          {status === "loading" ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      <p className="muted">PROPOSED advisory candidates raised by mode-c monitoring. These are future candidates, separate from the historical Decision Log.</p>
      {error ? <p className="error">{error}</p> : null}
      {refreshedAt ? <p className="muted">Proposal inbox refreshed {formatDateTime(refreshedAt)}</p> : null}
      {!canManageProposals ? <p className="muted">Viewer session: proposals are read-only.</p> : null}

      {proposals.length === 0 ? (
        <ProposalEmptyState status={status} />
      ) : (
        <div className="strategy-grid proposal-grid">
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              canManageProposals={canManageProposals}
              busy={mutationStatus === "loading"}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProposalEmptyState({ status }: { status: "idle" | "loading" | "succeeded" | "failed" }): ReactElement {
  if (status === "loading") {
    return <p className="empty">Loading proposed strategy candidates...</p>;
  }

  return <p className="empty">No pending proposals returned. Use Refresh after a paced cycle raises a new advisory candidate.</p>;
}

function ProposalCard({ proposal, canManageProposals, busy }: { proposal: StrategyProposalRecord; canManageProposals: boolean; busy: boolean }): ReactElement {
  const dispatch = useAppDispatch();
  const candidate = proposal.suggestedCandidate;

  const accept = () => {
    if (canManageProposals) {
      void dispatch(acceptProposal(proposal.id))
        .unwrap()
        .then(() => {
          void dispatch(fetchPortalStrategies());
        });
    }
  };

  const dismiss = () => {
    if (canManageProposals) {
      void dispatch(dismissProposal(proposal.id));
    }
  };

  return (
    <article className="decision-card strategy-card proposal-card">
      <header className="decision-card-header">
        <div>
          <p className="eyebrow">PROPOSED Candidate</p>
          <h3>{candidate.name}</h3>
        </div>
        <div className="id-stack">
          <span className={`status-badge status-${proposal.status}`}>{proposal.status}</span>
          <code>{proposal.id}</code>
        </div>
      </header>

      <p>{candidate.mandate}</p>
      <div className="decision-meta">
        <Meta label="Created" value={formatDateTime(proposal.createdAt)} />
        <Meta label="Status" value={proposal.status} />
        <Meta label="Source Strategy" value={proposal.strategyId ?? "none"} />
      </div>

      <ParameterSummary parameters={candidate.suggestedParameters} />

      <GlassBox title="Quant Rationale" eyebrow="advisory proposal">
        <p>{proposal.quantRationale}</p>
      </GlassBox>

      <QualitativeSlot evidence={proposal.qualitativeEvidence} />

      {canManageProposals ? (
        <div className="control-actions strategy-actions">
          <button type="button" onClick={accept} disabled={busy}>Accept</button>
          <button type="button" className="danger" onClick={dismiss} disabled={busy}>Dismiss</button>
        </div>
      ) : (
        <p className="muted">Viewer session: proposals are read-only.</p>
      )}
    </article>
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
  const strategySummaries = useAppSelector(strategyPerformanceSelectors.selectAll);

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">GET /portal/positions</p>
          <h2>Positions + Strategy P&amp;L</h2>
        </div>
        <button type="button" onClick={() => dispatch(fetchPortalPositions())} disabled={status === "loading"}>
          {status === "loading" ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {refreshedAt ? <p className="muted">Last refresh {new Date(refreshedAt).toLocaleString()}</p> : null}

      {account ? <AccountGrid account={account} /> : <p className="empty">No account snapshot loaded yet. Use Refresh.</p>}
      <StrategyPerformancePanel summaries={strategySummaries} />
      <PositionsTable positions={positions} />
    </section>
  );
}

function StrategyPerformancePanel({ summaries }: { summaries: PortalStrategyPerformanceSummary[] }): ReactElement {
  if (summaries.length === 0) {
    return (
      <section className="strategy-performance-panel">
        <div>
          <p className="eyebrow">Per-Strategy Paper P&amp;L</p>
          <h3>Strategy Equity Summary</h3>
        </div>
        <p className="empty">No strategy-linked paper decision snapshots yet. Run or refresh after an agent cycle records a decision.</p>
      </section>
    );
  }

  return (
    <section className="strategy-performance-panel">
      <div>
        <p className="eyebrow">Per-Strategy Paper P&amp;L</p>
        <h3>Strategy Equity Summary</h3>
        <p className="muted">Read-only attribution from existing paper positions and the latest strategy-linked decision snapshot.</p>
      </div>
      <div className="strategy-performance-grid">
        {summaries.map((summary) => (
          <article key={summary.id} className="strategy-performance-card">
            <header className="decision-card-header">
              <div>
                <p className="eyebrow">{summary.symbol}</p>
                <h4>{summary.strategyName ?? "Strategy"}</h4>
              </div>
              <div className="id-stack">
                {summary.strategyStatus ? <span className={`status-badge status-${summary.strategyStatus}`}>{summary.strategyStatus}</span> : null}
                <code>{summary.strategyId}</code>
              </div>
            </header>
            <div className="strategy-performance-metrics">
              <Metric label="Equity" value={formatMoney(summary.equity)} raw={summary.equity} />
              <Metric label="Unrealized P&L" value={formatMoney(summary.unrealizedPl)} raw={summary.unrealizedPl} tone={Number(summary.unrealizedPl) >= 0 ? "gain" : "loss"} />
              <Metric label="Portfolio Weight" value={formatPercent(summary.portfolioWeight)} raw={summary.portfolioWeight} />
            </div>
            <div className="decision-meta compact-meta">
              <Meta label="Last Decision" value={formatDateTime(summary.lastDecisionAt)} />
              <Meta label="Decision ID" value={summary.lastDecisionId} />
              <Meta label="Execution" value={summary.lastExecutionDecision} />
            </div>
          </article>
        ))}
      </div>
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

function RosterWorkspace({ canManageRoster }: { canManageRoster: boolean }): ReactElement {
  const dispatch = useAppDispatch();
  const sources = useAppSelector(rosterSelectors.selectAll);
  const status = useAppSelector((state) => state.roster.status);
  const mutationStatus = useAppSelector((state) => state.roster.mutationStatus);
  const error = useAppSelector((state) => state.roster.error);
  const refreshedAt = useAppSelector((state) => state.roster.refreshedAt);
  const draft = useAppSelector((state) => state.roster.createDraft);
  const busy = status === "loading" || mutationStatus === "loading";

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canManageRoster) {
      void dispatch(createSource(draft));
    }
  };

  return (
    <section className="panel strategies-workbench">
      <header className="panel-header">
        <div>
          <p className="eyebrow">GET /portal/roster</p>
          <h2>Analyst Roster</h2>
        </div>
        <button type="button" className="ghost" onClick={() => dispatch(fetchRoster())} disabled={busy}>
          {status === "loading" ? "Refreshing..." : "Refresh"}
        </button>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {refreshedAt ? <p className="muted">Roster refreshed {formatDateTime(refreshedAt)}</p> : null}
      {!canManageRoster ? <p className="muted">Viewer session: roster is read-only. Source management controls are hidden.</p> : null}

      {canManageRoster ? <SourceCreateForm draft={draft} busy={mutationStatus === "loading"} onSubmit={submitCreate} /> : null}

      {sources.length === 0 ? (
        <p className="empty">No sources returned. Use Refresh or add the first analyst source.</p>
      ) : (
        <div className="strategy-grid roster-grid">
          {sources.map((source) => (
            <SourceCard key={source.id} source={source} canManageRoster={canManageRoster} busy={mutationStatus === "loading"} />
          ))}
        </div>
      )}
    </section>
  );
}

function SourceCreateForm({ draft, busy, onSubmit }: { draft: SourceCreateDraft; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }): ReactElement {
  const dispatch = useAppDispatch();
  const needsFeedUrl = draft.sourceType === "rss" || draft.sourceType === "atom";
  const valid = draft.sourceKey.trim() && draft.name.trim() && (!needsFeedUrl || draft.feedUrl.trim());

  return (
    <form className="login-panel strategy-form roster-form" onSubmit={onSubmit}>
      <div>
        <p className="eyebrow">POST /portal/roster</p>
        <h2>Add Source</h2>
        <p className="muted">Source keys must be unique; RSS and Atom sources require a feed URL.</p>
      </div>
      <label>
        Source Key
        <input value={draft.sourceKey} onChange={(event) => dispatch(updateSourceCreateDraftField({ field: "sourceKey", value: event.currentTarget.value }))} required />
      </label>
      <label>
        Name
        <input value={draft.name} onChange={(event) => dispatch(updateSourceCreateDraftField({ field: "name", value: event.currentTarget.value }))} required />
      </label>
      <label>
        Type
        <select value={draft.sourceType} onChange={(event) => dispatch(updateSourceCreateDraftType(event.currentTarget.value as SourceType))}>
          {sourceTypes.map((type) => <option key={type} value={type}>{formatSourceType(type)}</option>)}
        </select>
      </label>
      {needsFeedUrl ? (
        <label>
          Feed URL
          <input type="url" value={draft.feedUrl} onChange={(event) => dispatch(updateSourceCreateDraftField({ field: "feedUrl", value: event.currentTarget.value }))} required />
        </label>
      ) : null}
      <label>
        Quality Rating
        <select value={draft.qualityRating} onChange={(event) => dispatch(updateSourceCreateDraftRating(Number(event.currentTarget.value)))}>
          {qualityRatings.map((rating) => <option key={rating} value={rating}>{rating}</option>)}
        </select>
      </label>
      <button type="submit" disabled={busy || !valid}>{busy ? "Adding..." : "Add Source"}</button>
    </form>
  );
}

function SourceCard({ source, canManageRoster, busy }: { source: SourceRecord; canManageRoster: boolean; busy: boolean }): ReactElement {
  const dispatch = useAppDispatch();

  return (
    <article className="decision-card strategy-card source-card">
      <header className="decision-card-header">
        <div>
          <p className="eyebrow">Source</p>
          <h3>{source.name}</h3>
        </div>
        <div className="id-stack">
          <span className={`status-badge source-${source.sourceType}`}>{formatSourceType(source.sourceType)}</span>
          <code>{source.sourceKey}</code>
        </div>
      </header>

      {source.feedUrl ? <p className="muted">{source.feedUrl}</p> : <p className="muted">Programmatic source; no feed URL.</p>}
      <div className="decision-meta">
        <Meta label="Quality" value={`${source.qualityRating}/5`} />
        <Meta label="Enabled" value={source.enabled ? "yes" : "no"} />
        <Meta label="Updated" value={formatDateTime(source.updatedAt)} />
        <Meta label="Created" value={formatDateTime(source.createdAt)} />
      </div>
      {canManageRoster ? (
        <div className="source-controls">
          <label>
            Quality Rating
            <select value={source.qualityRating} onChange={(event) => dispatch(updateSource({ id: source.id, qualityRating: Number(event.currentTarget.value) }))} disabled={busy}>
              {qualityRatings.map((rating) => <option key={rating} value={rating}>{rating}</option>)}
            </select>
          </label>
          <label className="source-toggle">
            <input
              type="checkbox"
              checked={source.enabled}
              onChange={(event) => dispatch(updateSource({ id: source.id, enabled: event.currentTarget.checked }))}
              disabled={busy}
            />
            Enabled
          </label>
          <button type="button" className="danger" onClick={() => dispatch(deleteSource(source.id))} disabled={busy}>Remove</button>
        </div>
      ) : null}
    </article>
  );
}

function StrategiesWorkspace({ canManageStrategies }: { canManageStrategies: boolean }): ReactElement {
  const dispatch = useAppDispatch();
  const strategies = useAppSelector(strategiesSelectors.selectAll);
  const status = useAppSelector((state) => state.strategies.status);
  const mutationStatus = useAppSelector((state) => state.strategies.mutationStatus);
  const error = useAppSelector((state) => state.strategies.error);
  const refreshedAt = useAppSelector((state) => state.strategies.refreshedAt);
  const activeView = useAppSelector((state) => state.strategies.activeView);
  const busy = status === "loading" || mutationStatus === "loading";

  return (
    <section className="panel strategies-workbench">
      <header className="panel-header">
        <div>
          <p className="eyebrow">GET /portal/strategies</p>
          <h2>Strategy Workbench</h2>
        </div>
        <div className="control-actions">
          <button type="button" className={activeView === "registry" ? undefined : "ghost"} onClick={() => dispatch(setStrategiesView("registry"))}>
            Registry
          </button>
          <button type="button" className={activeView === "chat" ? undefined : "ghost"} onClick={() => dispatch(setStrategiesView("chat"))}>
            Chat
          </button>
          <button type="button" className="ghost" onClick={() => dispatch(fetchPortalStrategies())} disabled={busy}>
            {status === "loading" ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {refreshedAt ? <p className="muted">Strategy registry refreshed {formatDateTime(refreshedAt)}</p> : null}
      {!canManageStrategies ? <p className="muted">Viewer session: registry and chat are read-only. Draft strategies are filtered server-side.</p> : null}

      {activeView === "registry" ? <StrategyRegistry strategies={strategies} canManageStrategies={canManageStrategies} /> : null}
      {activeView === "chat" ? <StrategyChatWorkspace strategies={strategies} canManageStrategies={canManageStrategies} /> : null}
    </section>
  );
}

function StrategyRegistry({ strategies, canManageStrategies }: { strategies: StrategyRecord[]; canManageStrategies: boolean }): ReactElement {
  const dispatch = useAppDispatch();
  const createDraft = useAppSelector((state) => state.strategies.createDraft);
  const editDraft = useAppSelector((state) => state.strategies.editDraft);
  const mutationStatus = useAppSelector((state) => state.strategies.mutationStatus);
  const busy = mutationStatus === "loading";

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canManageStrategies) {
      void dispatch(createPortalStrategy(createDraft));
    }
  };

  return (
    <div className="strategy-registry">
      {canManageStrategies ? <StrategyCreateForm draft={createDraft} busy={busy} onSubmit={submitCreate} /> : null}
      {editDraft && canManageStrategies ? <StrategyEditForm draft={editDraft} busy={busy} /> : null}

      {strategies.length === 0 ? (
        <p className="empty">No strategies returned. Use Refresh or create the first draft strategy.</p>
      ) : (
        <div className="strategy-grid">
          {strategies.map((strategy) => (
            <StrategyCard key={strategy.id} strategy={strategy} canManageStrategies={canManageStrategies} busy={busy} />
          ))}
        </div>
      )}
    </div>
  );
}

function StrategyCreateForm({ draft, busy, onSubmit }: { draft: StrategyDraft; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }): ReactElement {
  const dispatch = useAppDispatch();

  return (
    <form className="login-panel strategy-form" onSubmit={onSubmit}>
      <div>
        <p className="eyebrow">POST /portal/strategies</p>
        <h2>Create Strategy Draft</h2>
        <p className="muted">Parameters are prefilled from the quant playbook defaults; override only what changes the mandate.</p>
      </div>
      <label>
        Name
        <input value={draft.name} onChange={(event) => dispatch(updateCreateDraftField({ field: "name", value: event.currentTarget.value }))} required />
      </label>
      <label>
        Description
        <input value={draft.description} onChange={(event) => dispatch(updateCreateDraftField({ field: "description", value: event.currentTarget.value }))} />
      </label>
      <ParameterInputs
        parameters={draft.parameters}
        onChange={(key, value) => dispatch(updateCreateDraftParameter({ key, value }))}
      />
      <button type="submit" disabled={busy || !draft.name.trim()}>
        {busy ? "Creating..." : "Create Draft"}
      </button>
    </form>
  );
}

function StrategyEditForm({ draft, busy }: { draft: StrategyDraft & { id: string }; busy: boolean }): ReactElement {
  const dispatch = useAppDispatch();
  const submitEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void dispatch(updatePortalStrategy(draft));
  };

  return (
    <form className="decision-card strategy-edit-form" onSubmit={submitEdit}>
      <header className="decision-card-header">
        <div>
          <p className="eyebrow">PATCH /portal/strategies/:id</p>
          <h3>Edit Strategy</h3>
        </div>
        <div className="control-actions">
          <button type="button" className="ghost" onClick={() => dispatch(clearStrategyEditDraft())} disabled={busy}>Cancel</button>
          <button type="submit" disabled={busy || !draft.name.trim()}>{busy ? "Saving..." : "Save Patch"}</button>
        </div>
      </header>
      <div className="strategy-edit-grid">
        <label>
          Name
          <input value={draft.name} onChange={(event) => dispatch(updateEditDraftField({ field: "name", value: event.currentTarget.value }))} required />
        </label>
        <label>
          Description
          <input value={draft.description} onChange={(event) => dispatch(updateEditDraftField({ field: "description", value: event.currentTarget.value }))} />
        </label>
      </div>
      <ParameterInputs parameters={draft.parameters} onChange={(key, value) => dispatch(updateEditDraftParameter({ key, value }))} />
    </form>
  );
}

function ParameterInputs({ parameters, onChange }: { parameters: QuantPlaybookParameters; onChange: (key: QuantPlaybookParameterKey, value: number) => void }): ReactElement {
  return (
    <div className="parameter-input-grid">
      {quantPlaybookParameterKeys.map((key) => (
        <label key={key}>
          {splitCamel(key)}
          <input
            type="number"
            step="any"
            value={parameters[key]}
            onChange={(event) => onChange(key, Number(event.currentTarget.value))}
          />
        </label>
      ))}
    </div>
  );
}

function StrategyCard({ strategy, canManageStrategies, busy }: { strategy: StrategyRecord; canManageStrategies: boolean; busy: boolean }): ReactElement {
  const dispatch = useAppDispatch();
  const actions = lifecycleActions[strategy.status];
  const openChat = () => {
    dispatch(selectStrategy(strategy.id));
    void dispatch(fetchStrategyChatThread(strategy.id));
  };

  return (
    <article className="decision-card strategy-card">
      <header className="decision-card-header">
        <div>
          <p className="eyebrow">Strategy</p>
          <h3>{strategy.name}</h3>
        </div>
        <div className="id-stack">
          <span className={`status-badge status-${strategy.status}`}>{formatStatus(strategy.status)}</span>
          <code>{strategy.id}</code>
        </div>
      </header>

      {strategy.description ? <p>{strategy.description}</p> : <p className="muted">No description provided.</p>}
      <div className="decision-meta">
        <Meta label="Updated" value={formatDateTime(strategy.updatedAt)} />
        <Meta label="Created" value={formatDateTime(strategy.createdAt)} />
        <Meta label="Reason" value={strategy.reason ?? "none"} />
      </div>
      <ParameterSummary parameters={strategy.parameters} />
      <div className="control-actions strategy-actions">
        <button type="button" className="ghost" onClick={openChat}>Open Chat</button>
        {canManageStrategies ? <button type="button" className="ghost" onClick={() => dispatch(loadStrategyEditDraft(strategy))} disabled={busy}>Edit</button> : null}
        {canManageStrategies
          ? actions.map((action) => (
              <button
                key={action}
                type="button"
                className={action === "retire" ? "danger" : "ghost"}
                onClick={() => dispatch(transitionPortalStrategy({ id: strategy.id, action }))}
                disabled={busy}
              >
                {lifecycleActionLabel(action)}
              </button>
            ))
          : null}
      </div>
    </article>
  );
}

function ParameterSummary({ parameters }: { parameters: QuantPlaybookParameters | Partial<QuantPlaybookParameters> }): ReactElement {
  const values = Object.fromEntries(
    Object.entries(parameters).filter(([, value]) => value !== undefined)
  ) as Record<string, string | number | boolean | null>;

  return <KeyValueList title="Quant Parameters" values={values} />;
}

function StrategyChatWorkspace({ strategies, canManageStrategies }: { strategies: StrategyRecord[]; canManageStrategies: boolean }): ReactElement {
  const dispatch = useAppDispatch();
  const selectedStrategy = useAppSelector((state) => {
    const selectedId = state.strategies.selectedStrategyId;
    return selectedId ? state.strategies.entities[selectedId] ?? null : null;
  });

  return (
    <div className="strategy-chat-layout">
      <aside className="strategy-chat-sidebar">
        <p className="eyebrow">Strategies</p>
        {strategies.length === 0 ? <p className="muted">Refresh the registry to select a strategy.</p> : null}
        {strategies.map((strategy) => (
          <button
            key={strategy.id}
            type="button"
            className={selectedStrategy?.id === strategy.id ? "tab active" : "tab"}
            onClick={() => {
              dispatch(selectStrategy(strategy.id));
              void dispatch(fetchStrategyChatThread(strategy.id));
            }}
          >
            <span>{strategy.name}</span>
            <code>{formatStatus(strategy.status)}</code>
          </button>
        ))}
      </aside>
      {selectedStrategy ? <StrategyChatPanel strategy={selectedStrategy} canManageStrategies={canManageStrategies} /> : <p className="empty">Select a strategy to read its Strategy/Analyst thread.</p>}
    </div>
  );
}

function StrategyChatPanel({ strategy, canManageStrategies }: { strategy: StrategyRecord; canManageStrategies: boolean }): ReactElement {
  const dispatch = useAppDispatch();
  const thread = useAppSelector((state) => state.strategyChat.threads[strategy.id]);
  const messages = thread?.messages ?? [];
  const status = thread?.status ?? "idle";
  const postStatus = thread?.postStatus ?? "idle";
  const draft = thread?.draft ?? "";
  const mode = thread?.mode ?? "formalize";
  const error = thread?.error ?? null;
  const busy = status === "loading" || postStatus === "loading";

  const submitMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (content && canManageStrategies) {
      void dispatch(postStrategyChatMessage({ strategyId: strategy.id, content, mode }));
    }
  };

  return (
    <section className="strategy-chat-panel">
      <header className="decision-card-header">
        <div>
          <p className="eyebrow">GET /portal/strategies/:id/chat</p>
          <h3>{strategy.name}</h3>
        </div>
        <button type="button" className="ghost" onClick={() => dispatch(fetchStrategyChatThread(strategy.id))} disabled={busy}>
          {status === "loading" ? "Refreshing..." : "Refresh Thread"}
        </button>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {thread?.refreshedAt ? <p className="muted">Thread refreshed {formatDateTime(thread.refreshedAt)}</p> : null}
      <div className="chat-thread">
        {messages.length === 0 ? <p className="empty">No messages yet. Refresh the thread or start the co-development conversation.</p> : null}
        {messages.map((message) => <StrategyChatBubble key={message.id} message={message} />)}
      </div>
      {canManageStrategies ? (
        <form className="chat-composer" onSubmit={submitMessage}>
          <label>
            Mode
            <select value={mode} onChange={(event) => dispatch(setStrategyChatMode({ strategyId: strategy.id, mode: event.currentTarget.value as StrategyChatMode }))}>
              <option value="formalize">Formalize mandate</option>
              <option value="brainstorm">Brainstorm candidates</option>
            </select>
          </label>
          <label>
            Message
            <textarea value={draft} onChange={(event) => dispatch(setStrategyChatDraft({ strategyId: strategy.id, value: event.currentTarget.value }))} rows={4} />
          </label>
          <button type="submit" disabled={busy || !draft.trim()}>{postStatus === "loading" ? "Posting..." : "Post Message"}</button>
        </form>
      ) : (
        <p className="muted">Viewer session: chat posting is hidden to avoid admin-only 403s.</p>
      )}
    </section>
  );
}

function StrategyChatBubble({ message }: { message: StrategyChatMessage }): ReactElement {
  return (
    <article className={`chat-bubble ${message.role}`}>
      <div className="chat-bubble-header">
        <strong>{message.role === "analyst" ? "Strategy/Analyst" : "Operator"}</strong>
        <span>{formatDateTime(message.createdAt)}</span>
      </div>
      <p>{message.content}</p>
      {message.role === "analyst" && message.metadata ? <StrategyChatMetadataBlock metadata={message.metadata} /> : null}
    </article>
  );
}

function StrategyChatMetadataBlock({ metadata }: { metadata: StrategyChatMetadata }): ReactElement | null {
  const hasDelta = metadata.proposedParameterDelta && Object.keys(metadata.proposedParameterDelta).length > 0;
  const candidateIdeas = metadata.candidateIdeas ?? [];

  if (!hasDelta && candidateIdeas.length === 0 && !metadata.fallback) {
    return null;
  }

  return (
    <section className="chat-metadata">
      <p className="eyebrow">Read-Only Analyst Metadata{metadata.mode ? ` / ${metadata.mode}` : ""}</p>
      {metadata.fallback ? <p className="muted">Fallback response: the analyst model did not return a structured proposal.</p> : null}
      {hasDelta ? <ParameterSummary parameters={metadata.proposedParameterDelta ?? {}} /> : null}
      {candidateIdeas.length > 0 ? (
        <div className="candidate-ideas">
          {candidateIdeas.map((idea) => (
            <article key={`${idea.name}:${idea.mandate}`}>
              <strong>{idea.name}</strong>
              <p>{idea.mandate}</p>
              <ParameterSummary parameters={idea.suggestedParameters} />
            </article>
          ))}
        </div>
      ) : null}
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
  return raw.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
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

function formatStatus(status: StrategyStatus): string {
  return status.replace(/_/g, " ");
}

function formatSourceType(sourceType: SourceType): string {
  return sourceType.replace(/-/g, " ");
}

function lifecycleActionLabel(action: StrategyAction): string {
  switch (action) {
    case "discuss":
      return "Discuss";
    case "return-to-draft":
      return "Return to Draft";
    case "approve":
      return "Approve";
    case "activate":
      return "Activate";
    case "pause":
      return "Pause";
    case "resume":
      return "Resume";
    case "retire":
      return "Retire";
  }
}

const lifecycleActions: Record<StrategyStatus, StrategyAction[]> = {
  draft: ["discuss", "approve"],
  under_discussion: ["approve", "return-to-draft"],
  approved: ["activate"],
  active: ["pause", "retire"],
  paused: ["resume", "retire"],
  retired: []
};

const sourceTypes: SourceType[] = ["rss", "atom", "programmatic"];
const qualityRatings = [1, 2, 3, 4, 5];
