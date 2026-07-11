import { createAsyncThunk, createEntityAdapter, createSlice } from "@reduxjs/toolkit";

import type { RootState } from "../store";

export type PortalAccount = {
  id: string;
  status: string;
  currency: string;
  cash: string;
  buyingPower: string;
  portfolioValue: string;
  equity: string;
  lastEquity: string;
  dailyPnl: string;
};

export type PortalPosition = {
  symbol: string;
  qty: string;
  marketValue: string;
  avgEntryPrice: string;
  unrealizedPl: string;
  unrealizedPlpc?: string;
};

export type PortalStrategyPerformanceSummary = {
  id: string;
  strategyId: string;
  strategyName?: string;
  strategyStatus?: string;
  symbol: string;
  marketValue: string;
  equity: string;
  unrealizedPl: string;
  unrealizedPlpc?: string;
  portfolioWeight: string;
  lastDecisionAt: string;
  lastDecisionId: string;
  lastExecutionDecision: string;
};

type PortalPositionsResponse = {
  account: PortalAccount;
  positions: PortalPosition[];
  strategySummaries: PortalStrategyPerformanceSummary[];
};

const positionsAdapter = createEntityAdapter<PortalPosition, string>({
  selectId: (position) => position.symbol,
  sortComparer: (left, right) => left.symbol.localeCompare(right.symbol)
});

const strategySummariesAdapter = createEntityAdapter<PortalStrategyPerformanceSummary, string>({
  selectId: (summary) => summary.id,
  sortComparer: (left, right) => right.lastDecisionAt.localeCompare(left.lastDecisionAt) || left.strategyId.localeCompare(right.strategyId)
});

const initialState = positionsAdapter.getInitialState({
  account: null as PortalAccount | null,
  strategySummaries: strategySummariesAdapter.getInitialState(),
  status: "idle" as "idle" | "loading" | "succeeded" | "failed",
  error: null as string | null,
  refreshedAt: null as string | null
});

export const fetchPortalPositions = createAsyncThunk<
  PortalPositionsResponse,
  void,
  { state: RootState; rejectValue: string }
>("positions/fetchPortalPositions", async (_arg, { getState, rejectWithValue }) => {
  const token = getState().auth.token;

  if (!token) {
    return rejectWithValue("missing session");
  }

  const response = await fetch("/portal/positions", {
    headers: { authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    return rejectWithValue(`positions rejected: ${response.status}`);
  }

  return (await response.json()) as PortalPositionsResponse;
});

const positionsSlice = createSlice({
  name: "positions",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchPortalPositions.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchPortalPositions.fulfilled, (state, action) => {
        state.status = "succeeded";
        state.account = action.payload.account;
        state.refreshedAt = new Date().toISOString();
        positionsAdapter.setAll(state, action.payload.positions);
        strategySummariesAdapter.setAll(state.strategySummaries, action.payload.strategySummaries);
      })
      .addCase(fetchPortalPositions.rejected, (state, action) => {
        state.status = "failed";
        state.error = action.payload ?? action.error.message ?? "positions failed";
      });
  }
});

export const positionsSelectors = positionsAdapter.getSelectors<RootState>((state) => state.positions);
export const strategyPerformanceSelectors = strategySummariesAdapter.getSelectors<RootState>((state) => state.positions.strategySummaries);
export default positionsSlice.reducer;
