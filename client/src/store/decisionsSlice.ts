import { createAsyncThunk, createEntityAdapter, createSlice } from "@reduxjs/toolkit";

import type { RootState } from "../store";
import type { PortalAccount, PortalPosition } from "./positionsSlice";

export type PortalDecision = {
  id: string;
  cycleId: string;
  strategyId: string;
  createdAt: string;
  quantSignal: {
    asOf: string;
    symbol: string;
    score: number;
    signals: Record<string, string | number | boolean | null>;
    sizing: Record<string, string | number | boolean | null>;
  };
  brokerSnapshot: {
    account: PortalAccount;
    positions: PortalPosition[];
  };
  strategyAnalyst: {
    thesis: string;
    proposedOrder: PortalProposedOrder;
  };
  risk: {
    approved: boolean;
    verdict: "approved" | "rejected";
    rationale: string;
    deterministicViolations: string[];
  };
  execution: {
    decision: "placed" | "skipped" | "rejected";
    rationale: string;
    order?: PortalBrokerOrder;
    brokerRejection?: string;
  };
  qualitativeEvidence?: PortalQualitativeEvidence;
};

export type PortalProposedOrder = {
  symbol: string;
  qty: number;
  side: "buy";
  type: "limit";
  timeInForce: "day";
  limitPrice: number;
  estimatedNotional: number;
  strategyId: string;
};

export type PortalBrokerOrder = {
  id: string;
  clientOrderId?: string;
  symbol: string;
  qty: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  timeInForce: "day" | "gtc";
  status: string;
};

export type PortalQualitativeEvidence = {
  links: Array<{ href: string; title: string; source?: string }>;
  quotes: Array<{ quote: string; source: string; href?: string }>;
  signals: Array<{ label: string; value: string; source?: string }>;
};

type PortalDecisionsResponse = {
  decisions: PortalDecision[];
  limit: number;
};

const decisionsAdapter = createEntityAdapter<PortalDecision, string>({
  selectId: (decision) => decision.id,
  sortComparer: (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
});

const initialState = decisionsAdapter.getInitialState({
  limit: 50,
  status: "idle" as "idle" | "loading" | "succeeded" | "failed",
  error: null as string | null,
  refreshedAt: null as string | null
});

export const fetchPortalDecisions = createAsyncThunk<
  PortalDecisionsResponse,
  void,
  { state: RootState; rejectValue: string }
>("decisions/fetchPortalDecisions", async (_arg, { getState, rejectWithValue }) => {
  const state = getState();
  const signedIn = state.auth.user !== null;

  if (!signedIn) {
    return rejectWithValue("missing session");
  }

  const response = await fetch(`/portal/decisions?limit=${state.decisions.limit}`);

  if (!response.ok) {
    return rejectWithValue(`decisions rejected: ${response.status}`);
  }

  return (await response.json()) as PortalDecisionsResponse;
});

const decisionsSlice = createSlice({
  name: "decisions",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchPortalDecisions.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchPortalDecisions.fulfilled, (state, action) => {
        state.status = "succeeded";
        state.limit = action.payload.limit;
        state.refreshedAt = new Date().toISOString();
        decisionsAdapter.setAll(state, action.payload.decisions);
      })
      .addCase(fetchPortalDecisions.rejected, (state, action) => {
        state.status = "failed";
        state.error = action.payload ?? action.error.message ?? "decisions failed";
      });
  }
});

export const decisionsSelectors = decisionsAdapter.getSelectors<RootState>((state) => state.decisions);
export default decisionsSlice.reducer;
