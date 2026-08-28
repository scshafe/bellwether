import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";

import type { QuantPlaybookParameters } from "../quantPlaybookParameters";
import type { RootState } from "../store";

export type StrategyChatMode = "formalize" | "brainstorm";

export type StrategyChatMessage = {
  id: string;
  strategyId: string;
  role: "user" | "analyst";
  content: string;
  createdAt: string;
  metadata?: StrategyChatMetadata;
};

export type StrategyChatMetadata = {
  mode?: StrategyChatMode;
  proposedParameterDelta?: Partial<QuantPlaybookParameters>;
  candidateIdeas?: Array<{
    name: string;
    mandate: string;
    suggestedParameters: Partial<QuantPlaybookParameters>;
  }>;
  fallback?: boolean;
};

type StrategyChatThreadState = {
  messages: StrategyChatMessage[];
  status: "idle" | "loading" | "succeeded" | "failed";
  postStatus: "idle" | "loading" | "succeeded" | "failed";
  error: string | null;
  refreshedAt: string | null;
  draft: string;
  mode: StrategyChatMode;
};

type StrategyChatState = {
  threads: Record<string, StrategyChatThreadState>;
};

type StrategyChatResponse = {
  thread: StrategyChatMessage[];
};

const initialState: StrategyChatState = {
  threads: {}
};

export const fetchStrategyChatThread = createAsyncThunk<
  { strategyId: string; thread: StrategyChatMessage[] },
  string,
  { state: RootState; rejectValue: string }
>("strategyChat/fetchStrategyChatThread", async (strategyId, { getState, rejectWithValue }) => {
  const signedIn = getState().auth.user !== null;

  if (!signedIn) {
    return rejectWithValue("missing session");
  }

  const response = await fetch(`/portal/strategies/${encodeURIComponent(strategyId)}/chat`);

  if (!response.ok) {
    return rejectWithValue(`strategy chat rejected: ${response.status}`);
  }

  const payload = (await response.json()) as StrategyChatResponse;
  return { strategyId, thread: payload.thread };
});

export const postStrategyChatMessage = createAsyncThunk<
  { strategyId: string; content: string; mode: StrategyChatMode; message: StrategyChatMessage },
  { strategyId: string; content: string; mode: StrategyChatMode },
  { state: RootState; rejectValue: string }
>("strategyChat/postStrategyChatMessage", async ({ strategyId, content, mode }, { getState, rejectWithValue }) => {
  const signedIn = getState().auth.user !== null;

  if (!signedIn) {
    return rejectWithValue("missing session");
  }

  const response = await fetch(`/portal/strategies/${encodeURIComponent(strategyId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, mode })
  });

  if (!response.ok) {
    return rejectWithValue(`strategy chat post rejected: ${response.status}`);
  }

  const payload = (await response.json()) as { message: StrategyChatMessage };
  return { strategyId, content, mode, message: payload.message };
});

const strategyChatSlice = createSlice({
  name: "strategyChat",
  initialState,
  reducers: {
    setStrategyChatDraft(state, action: PayloadAction<{ strategyId: string; value: string }>) {
      threadState(state, action.payload.strategyId).draft = action.payload.value;
    },
    setStrategyChatMode(state, action: PayloadAction<{ strategyId: string; mode: StrategyChatMode }>) {
      threadState(state, action.payload.strategyId).mode = action.payload.mode;
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchStrategyChatThread.pending, (state, action) => {
        const thread = threadState(state, action.meta.arg);
        thread.status = "loading";
        thread.error = null;
      })
      .addCase(fetchStrategyChatThread.fulfilled, (state, action) => {
        const thread = threadState(state, action.payload.strategyId);
        thread.status = "succeeded";
        thread.messages = action.payload.thread;
        thread.refreshedAt = new Date().toISOString();
      })
      .addCase(fetchStrategyChatThread.rejected, (state, action) => {
        const thread = threadState(state, action.meta.arg);
        thread.status = "failed";
        thread.error = action.payload ?? action.error.message ?? "strategy chat failed";
      })
      .addCase(postStrategyChatMessage.pending, (state, action) => {
        const thread = threadState(state, action.meta.arg.strategyId);
        thread.postStatus = "loading";
        thread.error = null;
      })
      .addCase(postStrategyChatMessage.fulfilled, (state, action) => {
        const thread = threadState(state, action.payload.strategyId);
        const userEcho: StrategyChatMessage = {
          id: `local:${action.payload.message.id}:user`,
          strategyId: action.payload.strategyId,
          role: "user",
          content: action.payload.content,
          createdAt: new Date().toISOString(),
          metadata: { mode: action.payload.mode }
        };
        thread.postStatus = "succeeded";
        thread.draft = "";
        thread.messages = [...thread.messages.filter((message) => message.id !== action.payload.message.id), userEcho, action.payload.message];
      })
      .addCase(postStrategyChatMessage.rejected, (state, action) => {
        const thread = threadState(state, action.meta.arg.strategyId);
        thread.postStatus = "failed";
        thread.error = action.payload ?? action.error.message ?? "strategy chat post failed";
      });
  }
});

function threadState(state: StrategyChatState, strategyId: string): StrategyChatThreadState {
  state.threads[strategyId] ??= {
    messages: [],
    status: "idle",
    postStatus: "idle",
    error: null,
    refreshedAt: null,
    draft: "",
    mode: "formalize"
  };

  return state.threads[strategyId];
}

export const { setStrategyChatDraft, setStrategyChatMode } = strategyChatSlice.actions;
export default strategyChatSlice.reducer;
