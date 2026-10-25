import type { ReactElement } from "react";
import { Card } from "../components/ui.js";

/** Placeholder for Steps 7–9 (registry/payments screens land with those phases). */
export function PlaceholderPage(props: Readonly<{ title: string; step: string }>): ReactElement {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">{props.title}</h1>
      <Card>
        <p className="text-sm text-slate-600">
          This screen arrives with the UI track step {props.step}. Its entry is already
          permission-gated in the navigation so the shell matches the eventual access model.
        </p>
      </Card>
    </div>
  );
}
