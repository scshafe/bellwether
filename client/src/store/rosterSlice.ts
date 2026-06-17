import { createAsyncThunk, createEntityAdapter, createSlice, type PayloadAction } from "@reduxjs/toolkit";

import type { RootState } from "../store";

export type SourceType = "rss" | "atom" | "programmatic" | "x-handle";

export type SourceRecord = {
  id: string;
  sourceKey: string;
  name: string;
  sourceType: SourceType;
  feedUrl?: string;
  enabled: boolean;
  qualityRating: number;
  createdAt: string;
  updatedAt: string;
};

export type SourceCreateDraft = {
  sourceKey: string;
  name: string;
  sourceType: SourceType;
  feedUrl: string;
  qualityRating: number;
};

type SourceUpdatePatch = {
  id: string;
  name?: string;
  feedUrl?: string | null;
  enabled?: boolean;
  qualityRating?: number;
};

type PortalRosterResponse = {
  sources: SourceRecord[];
};

const rosterAdapter = createEntityAdapter<SourceRecord, string>({
  selectId: (source) => source.id,
  sortComparer: (left, right) => left.name.localeCompare(right.name) || left.sourceKey.localeCompare(right.sourceKey)
});

const emptyDraft = (): SourceCreateDraft => ({
  sourceKey: "",
  name: "",
  sourceType: "rss",
  feedUrl: "",
  qualityRating: 3
});

const initialState = rosterAdapter.getInitialState({
  status: "idle" as "idle" | "loading" | "succeeded" | "failed",
  mutationStatus: "idle" as "idle" | "loading" | "succeeded" | "failed",
  error: null as string | null,
  refreshedAt: null as string | null,
  createDraft: emptyDraft()
});

export const fetchRoster = createAsyncThunk<PortalRosterResponse, void, { state: RootState; rejectValue: string }>(
  "roster/fetchRoster",
  async (_arg, { getState, rejectWithValue }) => {
    const token = getState().auth.token;

    if (!token) {
      return rejectWithValue("missing session");
    }

    const response = await fetch("/portal/roster", {
      headers: { authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      return rejectWithValue(`roster rejected: ${response.status}`);
    }

    return (await response.json()) as PortalRosterResponse;
  }
);

export const createSource = createAsyncThunk<SourceRecord, SourceCreateDraft, { state: RootState; rejectValue: string }>(
  "roster/createSource",
  async (draft, { getState, rejectWithValue }) =>
    requestSourceMutation(
      "/portal/roster",
      "POST",
      {
        sourceKey: draft.sourceKey,
        name: draft.name,
        sourceType: draft.sourceType,
        ...(draft.sourceType === "programmatic" ? {} : { feedUrl: draft.feedUrl }),
        enabled: true,
        qualityRating: draft.qualityRating
      },
      getState,
      rejectWithValue,
      "source create"
    )
);

export const updateSource = createAsyncThunk<SourceRecord, SourceUpdatePatch, { state: RootState; rejectValue: string }>(
  "roster/updateSource",
  async ({ id, ...patch }, { getState, rejectWithValue }) =>
    requestSourceMutation(`/portal/roster/${encodeURIComponent(id)}`, "PATCH", patch, getState, rejectWithValue, "source update")
);

export const deleteSource = createAsyncThunk<string, string, { state: RootState; rejectValue: string }>(
  "roster/deleteSource",
  async (id, { getState, rejectWithValue }) => {
    const token = getState().auth.token;

    if (!token) {
      return rejectWithValue("missing session");
    }

    const response = await fetch(`/portal/roster/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      return rejectWithValue(`source delete rejected: ${response.status}`);
    }

    return id;
  }
);

const rosterSlice = createSlice({
  name: "roster",
  initialState,
  reducers: {
    updateSourceCreateDraftField(state, action: PayloadAction<{ field: "sourceKey" | "name" | "feedUrl"; value: string }>) {
      state.createDraft[action.payload.field] = action.payload.value;
    },
    updateSourceCreateDraftType(state, action: PayloadAction<SourceType>) {
      state.createDraft.sourceType = action.payload;
      if (action.payload === "programmatic") {
        state.createDraft.feedUrl = "";
      }
    },
    updateSourceCreateDraftRating(state, action: PayloadAction<number>) {
      state.createDraft.qualityRating = action.payload;
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchRoster.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchRoster.fulfilled, (state, action) => {
        state.status = "succeeded";
        state.refreshedAt = new Date().toISOString();
        rosterAdapter.setAll(state, action.payload.sources);
      })
      .addCase(fetchRoster.rejected, (state, action) => {
        state.status = "failed";
        state.error = action.payload ?? action.error.message ?? "roster failed";
      })
      .addCase(createSource.pending, setMutationLoading)
      .addCase(createSource.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        state.createDraft = emptyDraft();
        rosterAdapter.upsertOne(state, action.payload);
      })
      .addCase(createSource.rejected, setMutationFailed("source create failed"))
      .addCase(updateSource.pending, setMutationLoading)
      .addCase(updateSource.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        rosterAdapter.upsertOne(state, action.payload);
      })
      .addCase(updateSource.rejected, setMutationFailed("source update failed"))
      .addCase(deleteSource.pending, setMutationLoading)
      .addCase(deleteSource.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        rosterAdapter.removeOne(state, action.payload);
      })
      .addCase(deleteSource.rejected, setMutationFailed("source delete failed"));
  }
});

async function requestSourceMutation(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  getState: () => RootState,
  rejectWithValue: (value: string) => unknown,
  label: string
): Promise<SourceRecord> {
  const token = getState().auth.token;

  if (!token) {
    return rejectWithValue("missing session") as SourceRecord;
  }

  const response = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    return rejectWithValue(`${label} rejected: ${response.status}`) as SourceRecord;
  }

  return (await response.json()) as SourceRecord;
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
  updateSourceCreateDraftField,
  updateSourceCreateDraftRating,
  updateSourceCreateDraftType
} = rosterSlice.actions;
export const rosterSelectors = rosterAdapter.getSelectors<RootState>((state) => state.roster);
export default rosterSlice.reducer;
