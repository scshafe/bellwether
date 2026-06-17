import { createAsyncThunk, createEntityAdapter, createSlice } from "@reduxjs/toolkit";

import type { QuantPlaybookParameters } from "../quantPlaybookParameters";
import type { RootState } from "../store";
import type { PortalQualitativeEvidence } from "./decisionsSlice";
import type { StrategyRecord } from "./strategiesSlice";

export type StrategyProposalStatus = "pending" | "reviewed" | "dismissed";

export type StrategyProposalRecord = {
  id: string;
  status: StrategyProposalStatus;
  strategyId?: string;
  suggestedCandidate: {
    name: string;
    mandate: string;
    suggestedParameters: Partial<QuantPlaybookParameters>;
  };
  quantRationale: string;
  qualitativeEvidence: PortalQualitativeEvidence;
  createdAt: string;
  reviewedAt?: string;
};

type PortalProposalsResponse = {
  proposals: StrategyProposalRecord[];
};

type ProposalReviewDecision = "accept" | "dismiss";

type ProposalReviewResponse = {
  proposal: StrategyProposalRecord;
  strategy?: StrategyRecord;
};

const proposalsAdapter = createEntityAdapter<StrategyProposalRecord, string>({
  selectId: (proposal) => proposal.id,
  sortComparer: (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
});

const initialState = proposalsAdapter.getInitialState({
  status: "idle" as "idle" | "loading" | "succeeded" | "failed",
  mutationStatus: "idle" as "idle" | "loading" | "succeeded" | "failed",
  error: null as string | null,
  refreshedAt: null as string | null
});

export const fetchPortalProposals = createAsyncThunk<
  PortalProposalsResponse,
  void,
  { state: RootState; rejectValue: string }
>("proposals/fetchPortalProposals", async (_arg, { getState, rejectWithValue }) => {
  const token = getState().auth.token;

  if (!token) {
    return rejectWithValue("missing session");
  }

  const response = await fetch("/portal/proposals", {
    headers: { authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    return rejectWithValue(`proposals rejected: ${response.status}`);
  }

  return (await response.json()) as PortalProposalsResponse;
});

export const acceptProposal = createAsyncThunk<
  ProposalReviewResponse,
  string,
  { state: RootState; rejectValue: string }
>("proposals/acceptProposal", async (id, { getState, rejectWithValue }) =>
  requestProposalReview(id, "accept", getState, rejectWithValue)
);

export const dismissProposal = createAsyncThunk<
  ProposalReviewResponse,
  string,
  { state: RootState; rejectValue: string }
>("proposals/dismissProposal", async (id, { getState, rejectWithValue }) =>
  requestProposalReview(id, "dismiss", getState, rejectWithValue)
);

const proposalsSlice = createSlice({
  name: "proposals",
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchPortalProposals.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(fetchPortalProposals.fulfilled, (state, action) => {
        state.status = "succeeded";
        state.refreshedAt = new Date().toISOString();
        proposalsAdapter.setAll(state, action.payload.proposals);
      })
      .addCase(fetchPortalProposals.rejected, (state, action) => {
        state.status = "failed";
        state.error = action.payload ?? action.error.message ?? "proposals failed";
      })
      .addCase(acceptProposal.pending, setMutationLoading)
      .addCase(acceptProposal.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        state.refreshedAt = new Date().toISOString();
        proposalsAdapter.removeOne(state, action.payload.proposal.id);
      })
      .addCase(acceptProposal.rejected, setMutationFailed("proposal accept failed"))
      .addCase(dismissProposal.pending, setMutationLoading)
      .addCase(dismissProposal.fulfilled, (state, action) => {
        state.mutationStatus = "succeeded";
        state.refreshedAt = new Date().toISOString();
        proposalsAdapter.removeOne(state, action.payload.proposal.id);
      })
      .addCase(dismissProposal.rejected, setMutationFailed("proposal dismiss failed"));
  }
});

async function requestProposalReview(
  id: string,
  decision: ProposalReviewDecision,
  getState: () => RootState,
  rejectWithValue: (value: string) => unknown
): Promise<ProposalReviewResponse> {
  const token = getState().auth.token;

  if (!token) {
    return rejectWithValue("missing session") as ProposalReviewResponse;
  }

  const response = await fetch(`/portal/proposals/${encodeURIComponent(id)}/review`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ decision })
  });

  if (!response.ok) {
    return rejectWithValue(`proposal ${decision} rejected: ${response.status}`) as ProposalReviewResponse;
  }

  return (await response.json()) as ProposalReviewResponse;
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

export const proposalsSelectors = proposalsAdapter.getSelectors<RootState>((state) => state.proposals);
export default proposalsSlice.reducer;
