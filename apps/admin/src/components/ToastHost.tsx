import { type ReactElement } from "react";
import { useToasts } from "../toast.js";

/** Renders queued toasts fixed at the bottom right; dismissible inline. */
export function ToastHost(): ReactElement | null {
  const toasts = useToasts((state) => state.toasts);
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}

/** Stable dismiss callback; selecting a closure from the store would loop. */
function dismissToast(id: string): void {
  useToasts.getState().dismiss(id);
}

interface ToastCardProps {
  readonly toast: { id: string; kind: string; message: string; requestId: string | undefined };
  readonly onDismiss: (id: string) => void;
}

function ToastCard({ toast, onDismiss }: ToastCardProps): ReactElement {
  const tone =
    toast.kind === "error"
      ? "border-red-300 bg-red-50 text-red-900"
      : "border-emerald-300 bg-emerald-50 text-emerald-900";
  return (
    <div className={`rounded-md border p-3 text-sm shadow-sm ${tone}`}>
      <p className="font-medium">{toast.message}</p>
      {toast.requestId !== undefined ? (
        <p className="mt-1 text-xs opacity-80">request id: {toast.requestId}</p>
      ) : null}
      <button
        type="button"
        className="mt-2 cursor-pointer text-xs underline"
        onClick={() => {
          onDismiss(toast.id);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
