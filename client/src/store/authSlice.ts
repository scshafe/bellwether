import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "manager" | "viewer";
};

type SessionResponse = {
  token: string;
  user: AuthenticatedUser;
};

type AuthState = {
  username: string;
  password: string;
  token: string | null;
  user: AuthenticatedUser | null;
  status: "idle" | "loading" | "succeeded" | "failed";
  error: string | null;
};

const initialState: AuthState = {
  username: "admin",
  password: "",
  token: null,
  user: null,
  status: "idle",
  error: null
};

export const createSession = createAsyncThunk<SessionResponse, void, { state: { auth: AuthState }; rejectValue: string }>(
  "auth/createSession",
  async (_arg, { getState, rejectWithValue }) => {
    const { username, password } = getState().auth;
    const response = await fetch("/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    if (!response.ok) {
      return rejectWithValue(`session rejected: ${response.status}`);
    }

    return (await response.json()) as SessionResponse;
  }
);

/** Sentinel token for reverse-proxy identity mode: the server ignores Bearer
 *  tokens entirely in that mode, so this value only satisfies client-side
 *  "has a session" gates; it never authenticates anything. */
export const TRUSTED_PROXY_TOKEN = "trusted-proxy";

/** Ambient-session probe. Behind the OIDC proxy the request arrives already
 *  authenticated and this resolves with the mapped portal user — the login
 *  screen never renders. In password mode it 401s and nothing changes. */
export const bootstrapSession = createAsyncThunk<SessionResponse, void, { rejectValue: string }>(
  "auth/bootstrapSession",
  async (_arg, { rejectWithValue }) => {
    const response = await fetch("/family/overview");

    if (!response.ok) {
      return rejectWithValue(`no ambient session: ${response.status}`);
    }

    const body = (await response.json()) as { ok: boolean; user: AuthenticatedUser };

    return { token: TRUSTED_PROXY_TOKEN, user: body.user };
  }
);

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    setUsername(state, action: PayloadAction<string>) {
      state.username = action.payload;
    },
    setPassword(state, action: PayloadAction<string>) {
      state.password = action.payload;
    },
    signOut(state) {
      state.token = null;
      state.user = null;
      state.status = "idle";
      state.error = null;
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(createSession.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(createSession.fulfilled, (state, action) => {
        state.status = "succeeded";
        state.token = action.payload.token;
        state.user = action.payload.user;
        state.password = "";
      })
      .addCase(createSession.rejected, (state, action) => {
        state.status = "failed";
        state.token = null;
        state.user = null;
        state.error = action.payload ?? action.error.message ?? "session failed";
      })
      // No pending/rejected cases on purpose: a failed probe must leave the
      // password login flow byte-identical to today.
      .addCase(bootstrapSession.fulfilled, (state, action) => {
        state.status = "succeeded";
        state.token = action.payload.token;
        state.user = action.payload.user;
        state.password = "";
      });
  }
});

export const { setUsername, setPassword, signOut } = authSlice.actions;
export default authSlice.reducer;
