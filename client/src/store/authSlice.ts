import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "manager" | "viewer";
};

type AuthState = {
  user: AuthenticatedUser | null;
  status: "checking" | "signed-in" | "signed-out";
  detail: string | null;
};

const initialState: AuthState = {
  user: null,
  status: "checking",
  detail: null
};

/** RP-initiated logout (infra POCKETID-STACK-PATTERN.md §Sign-out).
 *  oauth2-proxy clears its own cookie, substitutes the session's {id_token}
 *  into the redirect, and hands the browser to Pocket ID's end-session
 *  endpoint — ending the IdP session too — which bounces back to the app root,
 *  where the door presents the passkey prompt. A plain /oauth2/sign_out clears
 *  only the proxy cookie and the still-live IdP session re-authenticates
 *  instantly. The IdP is `id.` on the app's own tailnet suffix, by house
 *  convention. */
export function proxySignOutUrl(): string {
  const suffix = window.location.hostname.split(".").slice(1).join(".");
  const postLogout = encodeURIComponent(`${window.location.origin}/`);
  const endSession = `https://id.${suffix}/api/oidc/end-session?id_token_hint={id_token}&post_logout_redirect_uri=${postLogout}`;
  return `/oauth2/sign_out?rd=${encodeURIComponent(endSession)}`;
}

/** The portal's only sign-in: ask the server who this browser already is.
 *  Reached through oauth2-proxy the request arrives carrying a Pocket ID token
 *  the server verifies, and this resolves with the portal user. Reached any
 *  other way it 401s and the app stays signed out — there is no form to fall
 *  back to, because the app holds no credential of its own. */
export const bootstrapSession = createAsyncThunk<AuthenticatedUser, void, { rejectValue: string }>(
  "auth/bootstrapSession",
  async (_arg, { rejectWithValue }) => {
    const response = await fetch("/family/overview");

    if (!response.ok) {
      return rejectWithValue(`not signed in (${response.status})`);
    }

    const body = (await response.json()) as { ok: boolean; user: AuthenticatedUser };

    return body.user;
  }
);

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(bootstrapSession.pending, (state) => {
        state.status = "checking";
        state.detail = null;
      })
      .addCase(bootstrapSession.fulfilled, (state, action) => {
        state.status = "signed-in";
        state.user = action.payload;
        state.detail = null;
      })
      .addCase(bootstrapSession.rejected, (state, action) => {
        state.status = "signed-out";
        state.user = null;
        state.detail = action.payload ?? action.error.message ?? "not signed in";
      });
  }
});

export default authSlice.reducer;
