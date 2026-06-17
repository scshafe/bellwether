import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type WorkspaceTab = "positions" | "decisions" | "control";

type WorkspaceState = {
  activeTab: WorkspaceTab;
};

const initialState: WorkspaceState = {
  activeTab: "positions"
};

const workspaceSlice = createSlice({
  name: "workspace",
  initialState,
  reducers: {
    setActiveTab(state, action: PayloadAction<WorkspaceTab>) {
      state.activeTab = action.payload;
    }
  }
});

export const { setActiveTab } = workspaceSlice.actions;
export default workspaceSlice.reducer;
