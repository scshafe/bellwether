import { createAsyncThunk, createEntityAdapter, createSlice, type PayloadAction } from "@reduxjs/toolkit";

import { DEFAULT_QUANT_PLAYBOOK_PARAMETERS, type QuantPlaybookParameterKey, type QuantPlaybookParameters } from "../quantPlaybookParameters";
import type { RootState } from "../store";

export type StrategyStatus = "draft" | "under_discussion" | "approved" | "active" | "paused" | "retired";

export type StrategyRecord = {
  id: string;
  name: string;
  description?: string;
  status: StrategyStatus;
  parameters: QuantPlaybookParameters;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  activatedAt?: string;
  discussionStartedAt?: string;
  pausedAt?: string;
  retiredAt?: string;
  reason?: string;
};

export type StrategyAction = "discuss" | "return-to-draft" | "approve" | "activate" | "pause" | "resume" | "retire";
export type StrategyWorkbenchView = "registry" | "chat";

export type StrategyDraft = {
  name: string;
  description: string;
  parameters: QuantPlaybookParameters;
};

export type StrategyEditDraft = StrategyDraft & {
  id: string;
};

type PortalStrategiesResponse = {
  strategies: StrategyRecord[];
};

const strategiesAdapter = createEntityAdapter<StrategyRecord, string>({
  selectId: (strategy) => strategy.id,
  sortComparer: (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name)
});

const emptyDraft = (): StrategyDraft => ({
  name: "",
  description: "",
  parameters: { ...DEFAULT_QUANT_PLAYBOOK_PARAMETERS }
});

const initialState = strategiesAdapter.getInitialState({
  status: "idle" as "idle" | "loading" | "succeeded" | "failed",
  mutationStatus: "idle" as "idle" | "loading" | "succeeded" | "failed",
  error: null as string | null,
  refreshedAt: null as string | null,
  activeView: "registry" as StrategyWorkbenchView,
  selectedStrategyId: null as string | null,
  createDraft: emptyDraft(),
  editDraft: null as StrategyEditDraft | null
});

export const fetchPortalStrategies = createAsyncThunk<
  PortalStrategiesResponse,
  void,
  { state: RootState; rejectValue: string }
>("strategies/fetchPortalStrategies", async (_arg, { getState, rejectWithValue }) => {
  const token = getState().auth.token;

  if (!token) {
    return rejectWithValue("missing session");
  }

  const response = await fetch("/portal/strategies", {
    headers: { authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    return rejectWithValue(`strategies rejected: ${response.status}`);
  }

  return (await response.json()) as PortalStrategiesResponse;
});

export const createPortalStrategy = createAsyncThunk<
  StrategyRecord,
  StrategyDraft,
  { state: RootState; rejectValue: string }
>("strategies/createPortalStrategy", async (draft, { getState, rejectWithValue }) =>
  requestStrategyMutation("/portal/strategies", "POST", draft, getState, rejectWithValue, "strategy create")
);

export const updatePortalStrategy = createAsyncThunk<
  StrategyRecord,
  StrategyEditDraft,
  { state: RootState; rejectValue: string }
>("strategies/updatePortalStrategy", async (draft, { getState, rejectWithValue }) =>
  requestStrategyMutation(
    `/portal/strategies/${encodeURIComponent(draft.id)}`,
    "PATCH",
    { name: draft.name, description: draft.description, parameters: draft.parameters },
    getState,
    rejectWithValue,
    "strategy update"
  )
);

export const transitionPortalStrategy = createAsyncThunk<
  StrategyRecord,
  { id: string; action: StrategyAction },
  { state: RootState; rejectValue: string }
>("strategies/transitionPortalStrategy", async ({ id, action }, { getState, rejectWithValue }) => {
  const body = action === "pause" || action === "retire" ? {} : undefined;
  return requestStrategyMutation(
    `/portal/strategies/${encodeURIComponent(id)}/${action}`,
    "POST",
    body,
    getState,
    rejectWithValue,
    `strategy ${action}`
  );
});

const strategiesSlice = createSlice({
  name: "strategies",
  initialState,
  reducers: {
    setStrategiesView(state, action: PayloadAction<StrategyWorkbenchView>) {
      state.activeView = action.payload;
    },
    selectStrategy(state, action: PayloadAction<string>) {
      state.selectedStrategyId = action.payload;
      state.activeView = "chat";
    },
    updateCreateDraftField(state, action: PayloadAction<{ field: "name" | "description"; value: string }>) {
      state.createDraft[action.payload.field] = action.payload.value;
    },
    updateCreateDraftParameter(state, action: PayloadAction<{ key: QuantPlaybookParameterKey; value: number }>) {
      state.createDraft.parameters[action.payload.key] = action.payload.value;
    },
    loadStrategyEditDraft(state, action: PayloadAction<StrategyRecord>) {
      state.editDraft = {
        id: action.payload.id,
        name: action.payload.name,
        description: action.payload.description ?? "",
        parameters: { ...action.payload.parameters }
      };
    },
    clearStrategyEditDraft(state) {
      state.editDraft = null;
    },
    updateEditDraftField(state, action: PayloadAction<{ field: "name" | "description"; value: string }>) {
      if (state.editDraft) {
        state.editDraft[action.payload.field] = action.payload.value;
      }
    },
    updateEditDraftParameter(state, action: PayloadAction<{ key: QuantPlaybookParameterKey; value: number }>) {
      if (state.editDraft) {
        state.editDraft.parameters[action.payload.key] = action.payload.value;
      }
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchPortalStrategies.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchPortalStrategies.fulfilled, (state, action) => {
        state.status = "succeeded";
        state.refreshedAt = new Date().toISOString();
        strategiesAdapter.setAll(state, action.payload.strategies);
        if (state.selectedStrategyId && !action.payload.strategies.some((strategy) => strategy.id === state.selectedStrategyId)) {
          state.selectedStrategyId = null;
        }
      })
      .addCase(fetchPortalStrategies.rejected, (state, action) => {
        state.status = "failed";
        state.error = action.payload ?? action.error.message ?? "strategies failed";
      })
      .addCase(createPortalStrategy.pending, setMutationLoading)
      .addCase(createPortalStrategy.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        state.createDraft = emptyDraft();
        state.selectedStrategyId = action.payload.id;
        strategiesAdapter.upsertOne(state, action.payload);
      })
      .addCase(createPortalStrategy.rejected, setMutationFailed("strategy create failed"))
      .addCase(updatePortalStrategy.pending, setMutationLoading)
      .addCase(updatePortalStrategy.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        state.editDraft = null;
        strategiesAdapter.upsertOne(state, action.payload);
      })
      .addCase(updatePortalStrategy.rejected, setMutationFailed("strategy update failed"))
      .addCase(transitionPortalStrategy.pending, setMutationLoading)
      .addCase(transitionPortalStrategy.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        strategiesAdapter.upsertOne(state, action.payload);
      })
      .addCase(transitionPortalStrategy.rejected, setMutationFailed("strategy transition failed"));
  }
});

async function requestStrategyMutation(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  getState: () => RootState,
  rejectWithValue: (value: string) => unknown,
  label: string
): Promise<StrategyRecord> {
  const token = getState().auth.token;

  if (!token) {
    return rejectWithValue("missing session") as StrategyRecord;
  }

  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  if (!response.ok) {
    return rejectWithValue(`${label} rejected: ${response.status}`) as StrategyRecord;
  }

  return (await response.json()) as StrategyRecord;
}

function setMutationLoading(state: typeof initialState): void {
  state.mutationStatus = "loading";
  state.error = null;
}

function setMutationFailed(fallback: string) {
  return (state: typeof initialState, action: { payload?: string; error: { message?: string } }): void => {
    state.mutationStatus = "failed";
    state.error = action.payload ?? action.error.message ?? fallback;
  };
}

export const {
  clearStrategyEditDraft,
  loadStrategyEditDraft,
  selectStrategy,
  setStrategiesView,
  updateCreateDraftField,
  updateCreateDraftParameter,
  updateEditDraftField,
  updateEditDraftParameter
} = strategiesSlice.actions;
export const strategiesSelectors = strategiesAdapter.getSelectors<RootState>((state) => state.strategies);
export default strategiesSlice.reducer;
