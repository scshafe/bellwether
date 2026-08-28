import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";

import type { RootState } from "../store";

export type RuntimeStateSnapshot = {
  state: "running" | "stopped";
  activeJobId: string | null;
  lastCycle: {
    jobId: string | null;
    status: "succeeded" | "failed" | "cancelled";
    summary: string;
    decisionLogId: string | null;
    completedAt: string | null;
  } | null;
  updatedAt: string;
};

type RuntimeSliceState = {
  snapshot: RuntimeStateSnapshot | null;
  status: "idle" | "loading" | "succeeded" | "failed";
  mutationStatus: "idle" | "loading" | "succeeded" | "failed";
  error: string | null;
  refreshedAt: string | null;
};

const initialState: RuntimeSliceState = {
  snapshot: null,
  status: "idle",
  mutationStatus: "idle",
  error: null,
  refreshedAt: null
};

export const fetchRuntimeStatus = createAsyncThunk<RuntimeStateSnapshot, void, { state: RootState; rejectValue: string }>(
  "runtime/fetchRuntimeStatus",
  async (_arg, { getState, rejectWithValue }) => requestRuntime("/portal/runtime", "GET", getState, rejectWithValue)
);

export const startAgentRuntime = createAsyncThunk<RuntimeStateSnapshot, void, { state: RootState; rejectValue: string }>(
  "runtime/startAgentRuntime",
  async (_arg, { getState, rejectWithValue }) => requestRuntime("/portal/runtime/start", "POST", getState, rejectWithValue)
);

export const stopAgentRuntime = createAsyncThunk<RuntimeStateSnapshot, void, { state: RootState; rejectValue: string }>(
  "runtime/stopAgentRuntime",
  async (_arg, { getState, rejectWithValue }) => requestRuntime("/portal/runtime/stop", "POST", getState, rejectWithValue)
);

const runtimeSlice = createSlice({
  name: "runtime",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchRuntimeStatus.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchRuntimeStatus.fulfilled, (state, action) => {
        state.status = "succeeded";
        state.snapshot = action.payload;
        state.refreshedAt = new Date().toISOString();
      })
      .addCase(fetchRuntimeStatus.rejected, (state, action) => {
        state.status = "failed";
        state.error = action.payload ?? action.error.message ?? "runtime status failed";
      })
      .addCase(startAgentRuntime.pending, (state) => {
        state.mutationStatus = "loading";
        state.error = null;
      })
      .addCase(startAgentRuntime.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        state.snapshot = action.payload;
        state.refreshedAt = new Date().toISOString();
      })
      .addCase(startAgentRuntime.rejected, (state, action) => {
        state.mutationStatus = "failed";
        state.error = action.payload ?? action.error.message ?? "runtime start failed";
      })
      .addCase(stopAgentRuntime.pending, (state) => {
        state.mutationStatus = "loading";
        state.error = null;
      })
      .addCase(stopAgentRuntime.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        state.snapshot = action.payload;
        state.refreshedAt = new Date().toISOString();
      })
      .addCase(stopAgentRuntime.rejected, (state, action) => {
        state.mutationStatus = "failed";
        state.error = action.payload ?? action.error.message ?? "runtime stop failed";
      });
  }
});

async function requestRuntime(
  path: string,
  method: "GET" | "POST",
  getState: () => RootState,
  rejectWithValue: (value: string) => unknown
): Promise<RuntimeStateSnapshot> {
  const signedIn = getState().auth.user !== null;

  if (!signedIn) {
    return rejectWithValue("missing session") as RuntimeStateSnapshot;
  }

  const response = await fetch(path, { method });

  if (!response.ok) {
    return rejectWithValue(`runtime rejected: ${response.status}`) as RuntimeStateSnapshot;
  }

  return (await response.json()) as RuntimeStateSnapshot;
}

export default runtimeSlice.reducer;
