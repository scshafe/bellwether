import { createAsyncThunk, createEntityAdapter, createSlice } from "@reduxjs/toolkit";

import type { RootState } from "../store";

export type PortalUserStatus = "pending" | "active" | "disabled";

/** A portal account, linked to a Pocket ID user by `subject`. There is no
 *  credential here — Pocket ID authenticates; this records what the person
 *  may do afterwards. */
export type PortalUserRecord = {
  id: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  role: "admin" | "manager" | "viewer" | null;
  status: PortalUserStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  grantedAt: string | null;
  grantedBy: string | null;
};

const usersAdapter = createEntityAdapter<PortalUserRecord>({
  sortComparer: (left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)
});

const initialState = usersAdapter.getInitialState({
  status: "idle" as "idle" | "loading" | "succeeded" | "failed",
  error: null as string | null
});

export const fetchPortalUsers = createAsyncThunk<PortalUserRecord[], void, { state: RootState; rejectValue: string }>(
  "users/fetchPortalUsers",
  async (_arg, { getState, rejectWithValue }) => {
    const signedIn = getState().auth.user !== null;

    if (!signedIn) {
      return rejectWithValue("missing session");
    }

    const response = await fetch("/portal/users");

    if (!response.ok) {
      return rejectWithValue(`users rejected: ${response.status}`);
    }

    const body = (await response.json()) as { users: PortalUserRecord[] };

    return body.users;
  }
);

export const updatePortalUser = createAsyncThunk<
  PortalUserRecord,
  { id: string; role?: PortalUserRecord["role"]; status?: PortalUserStatus },
  { state: RootState; rejectValue: string }
>("users/updatePortalUser", async ({ id, ...patch }, { getState, rejectWithValue }) => {
  const signedIn = getState().auth.user !== null;

  if (!signedIn) {
    return rejectWithValue("missing session");
  }

  const response = await fetch(`/portal/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });

  if (!response.ok) {
    // The one refusal worth naming: it is the guard against locking everyone out.
    return rejectWithValue(
      response.status === 409 ? "that would leave the portal with no admin" : `update rejected: ${response.status}`
    );
  }

  const body = (await response.json()) as { user: PortalUserRecord };

  return body.user;
});

const usersSlice = createSlice({
  name: "users",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchPortalUsers.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchPortalUsers.fulfilled, (state, action) => {
        state.status = "succeeded";
        usersAdapter.setAll(state, action.payload);
      })
      .addCase(fetchPortalUsers.rejected, (state, action) => {
        state.status = "failed";
        state.error = action.payload ?? action.error.message ?? "users failed";
      })
      .addCase(updatePortalUser.fulfilled, (state, action) => {
        state.error = null;
        usersAdapter.upsertOne(state, action.payload);
      })
      .addCase(updatePortalUser.rejected, (state, action) => {
        state.error = action.payload ?? action.error.message ?? "update failed";
      });
  }
});

export const usersSelectors = usersAdapter.getSelectors<RootState>((state) => state.users);
export default usersSlice.reducer;
