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

type PortalPositionsResponse = {
  account: PortalAccount;
  positions: PortalPosition[];
};

const positionsAdapter = createEntityAdapter<PortalPosition, string>({
  selectId: (position) => position.symbol,
  sortComparer: (left, right) => left.symbol.localeCompare(right.symbol)
});

const initialState = positionsAdapter.getInitialState({
  account: null as PortalAccount | null,
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
      })
      .addCase(fetchPortalPositions.rejected, (state, action) => {
        state.status = "failed";
        state.error = action.payload ?? action.error.message ?? "positions failed";
      });
  }
});

export const positionsSelectors = positionsAdapter.getSelectors<RootState>((state) => state.positions);
export default positionsSlice.reducer;
