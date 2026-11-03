import { useState, type ReactElement } from "react";
import { Button, Card } from "../components/ui.js";
import { handoverText } from "../lib/appLinks.js";
import type { AppDestination, AppKey, HandoverDetails } from "../lib/appLinks.js";
import { pushToast } from "../toast.js";

/**
 * What an administrator reads out when they hand an account over.
 *
 * The password is only known at the moment of creation or reset — the server
 * hashes it and never returns it — so this card is deliberately ephemeral: it
 * exists for one handover and disappears when it is dismissed. Every line is
 * copyable, and the whole thing can be copied as one message or printed, because
 * the realistic channel is WhatsApp, a phone call, or a slip of paper.
 */

const ADDRESS_VARIABLE: Readonly<Record<AppKey, string>> = {
  admin: "VITE_ADMIN_APP_URL",
  field: "VITE_FIELD_APP_URL",
  collector: "VITE_COLLECTOR_APP_URL",
};

interface Row {
  readonly label: string;
  readonly value: string;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await globalThis.navigator.clipboard.writeText(value);
    return true;
  } catch {
    // No clipboard (an insecure origin, or a browser that refuses the call).
    return false;
  }
}

export function HandoverCard(
  props: Readonly<{
    details: HandoverDetails;
    destinations: readonly AppDestination[];
    onDone: () => void;
  }>,
): ReactElement {
  const [copied, setCopied] = useState<string | undefined>(undefined);
  const rows: Row[] = [
    ...props.destinations.map((destination) => ({
      label: destination.label,
      value: destination.url ?? "Not configured in this build",
    })),
    { label: "State", value: props.details.slug ?? "Unknown" },
    { label: "Username", value: props.details.username },
    ...(props.details.password === undefined
      ? []
      : [{ label: "Temporary password", value: props.details.password }]),
  ];
  const unconfigured = props.destinations.filter((destination) => destination.url === undefined);

  const copy = (label: string, value: string): void => {
    void (async () => {
      const ok = await copyText(value);
      setCopied(ok ? label : undefined);
      pushToast(
        ok
          ? { kind: "success", message: `${label} copied.` }
          : { kind: "error", message: "Copying was blocked; select the text instead." },
      );
    })();
  };

  return (
    <Card
      title={`Hand over to ${props.details.displayName}`}
      description="Shown once: the server cannot read the password back, so closing this loses it."
    >
      <div className="space-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-wrap items-center gap-2">
            <span className="w-40 shrink-0 text-slate-500">{row.label}</span>
            <code className="break-all rounded bg-slate-50 px-2 py-1 font-mono text-slate-900">
              {row.value}
            </code>
            <Button
              variant="ghost"
              onClick={() => {
                copy(row.label, row.value);
              }}
            >
              {copied === row.label ? "Copied" : "Copy"}
            </Button>
          </div>
        ))}
      </div>

      {props.details.password === undefined ? (
        <p className="mt-2 text-xs text-slate-600">
          The temporary password is not stored in a readable form. Ask the administrator who
          created or reset the account, or reset it again to produce a new one.
        </p>
      ) : null}

      {unconfigured.length > 0 ? (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          This build was not told the {unconfigured.map((app) => app.label).join(" or ")} address.
          Set{" "}
          {unconfigured.map((app) => ADDRESS_VARIABLE[app.key]).join(" and ")}{" "}
          on the dashboard project, redeploy it, and the link appears here.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          onClick={() => {
            copy("Handover text", handoverText(props.details, props.destinations));
          }}
        >
          Copy handover text
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            globalThis.print();
          }}
        >
          Print
        </Button>
        <Button variant="ghost" onClick={props.onDone}>
          Done
        </Button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        They sign in once with this password and choose their own; the temporary one stops working.
      </p>
    </Card>
  );
}
