import { create } from "zustand";
import { ApiError } from "@tpirs/api-client";

export type ToastKind = "error" | "success";

export interface ToastInput {
  readonly kind: ToastKind;
  readonly message: string;
  readonly requestId?: string;
  /** Test seam: real pushes auto-dismiss; tests can pin the toast. */
  readonly expireMs?: number;
}

export interface ToastItem {
  readonly id: string;
  readonly kind: ToastKind;
  readonly message: string;
  readonly requestId: string | undefined;
}

interface ToastState {
  readonly toasts: readonly ToastItem[];
  push(input: ToastInput): void;
  dismiss(id: string): void;
}

const DEFAULT_EXPIRE_MS = 6000;

/**
 * Error-envelope surfacing: every failed request shows the server's message and
 * — always — the request ID, so finance can quote it against server logs.
 */
export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],

  push(input) {
    const id =
      typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : String(Date.now());
    const item: ToastItem = {
      id,
      kind: input.kind,
      message: input.message,
      requestId: input.requestId,
    };
    set({ toasts: [...get().toasts, item] });
    const expireMs = input.expireMs ?? DEFAULT_EXPIRE_MS;
    setTimeout(() => {
      get().dismiss(id);
    }, expireMs);
  },

  dismiss(id) {
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
  },
}));

/** Maps any thrown value to what the toast host can render. */
export function describeError(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: "Something went wrong" };
}
