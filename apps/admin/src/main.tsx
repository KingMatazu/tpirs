import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { wireSession } from "./api/client.js";
import { useSession } from "./session.js";
import { describeError, useToasts } from "./toast.js";
import { ToastHost } from "./components/ToastHost.js";
import { App } from "./App";
import "./index.css";

// Silent refresh wiring (D26): the client reads the in-memory token and the
// store performs the cookie-based refresh; both are installed before first use.
wireSession({
  getAccessToken: () => useSession.getState().accessToken,
  refresh: async () => {
    await useSession.getState().silentRefresh();
  },
});

const notifyError = (error: unknown): void => {
  const described = describeError(error);
  useToasts.getState().push({
    kind: "error",
    message: described.message,
    ...(described.requestId === undefined ? {} : { requestId: described.requestId }),
  });
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: notifyError }),
  mutationCache: new MutationCache({ onError: notifyError }),
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root element");

createRoot(container).render(
  <QueryClientProvider client={queryClient}>
    <App />
    <ToastHost />
  </QueryClientProvider>,
);
