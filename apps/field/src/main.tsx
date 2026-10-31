import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";
import "./index.css";

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root element");

/**
 * Offline-first settings: a failed request must not be retried into a dead zone
 * (each retry is a radio wake-up and a battery cost), and returning to the tab
 * must not refetch over a queue that has not drained yet.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
