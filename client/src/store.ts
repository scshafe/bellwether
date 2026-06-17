import { configureStore } from "@reduxjs/toolkit";
import authReducer from "./store/authSlice";
import positionsReducer from "./store/positionsSlice";
import workspaceReducer from "./store/workspaceSlice";

export const store = configureStore({
  reducer: {
    auth: authReducer,
    positions: positionsReducer,
    workspace: workspaceReducer
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
