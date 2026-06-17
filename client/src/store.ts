import { configureStore } from "@reduxjs/toolkit";
import authReducer from "./store/authSlice";
import decisionsReducer from "./store/decisionsSlice";
import positionsReducer from "./store/positionsSlice";
import rosterReducer from "./store/rosterSlice";
import runtimeReducer from "./store/runtimeSlice";
import strategiesReducer from "./store/strategiesSlice";
import strategyChatReducer from "./store/strategyChatSlice";
import workspaceReducer from "./store/workspaceSlice";

export const store = configureStore({
  reducer: {
    auth: authReducer,
    decisions: decisionsReducer,
    positions: positionsReducer,
    roster: rosterReducer,
    runtime: runtimeReducer,
    strategies: strategiesReducer,
    strategyChat: strategyChatReducer,
    workspace: workspaceReducer
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
