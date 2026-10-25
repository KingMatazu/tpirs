import { useState, type ReactElement } from "react";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { simulateUssd, type SimulatorFrame } from "../lib/simulator.js";
import { Button, Card, ReadOnlyNote, TextInput } from "../components/ui.js";
import { useSession } from "../session.js";

/**
 * USSD simulator (Step 5): a developer/test aid that replays the pure session
 * engine in the browser against the loaded tenant config. Nothing is sent to
 * the payment backend — it shows prompts, choices, input checks, and end
 * reasons exactly as the channel would render them for a driver.
 */
export function UssdSimulatorPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("tenant:read"));
  const { config, isLoading, error } = useTenantConfig();
  const [draft, setDraft] = useState("");
  const [language, setLanguage] = useState<string | undefined>(undefined);
  const [submitted, setSubmitted] = useState("");

  if (!canRead) {
    return <p className="text-sm text-slate-600">You do not have permission to use the simulator.</p>;
  }
  if (isLoading) return <p className="text-sm text-slate-500">Loading configuration…</p>;
  if (error !== null || config === undefined) {
    return <p className="text-sm text-red-600">Simulator configuration could not be loaded.</p>;
  }

  const tenantConfig = config.config;
  const activeLanguage = language ?? tenantConfig.locale.defaultLanguage;
  const frame: SimulatorFrame | null =
    submitted === "" ? null : simulateUssd(tenantConfig, submitted, activeLanguage);

  const submit = (segment: string): void => {
    // Providers send cumulative replay text joined with `*`.
    setSubmitted((current) => (current === "" ? segment : `${current}*${segment}`));
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">USSD simulator</h1>
      <ReadOnlyNote>
        Runs the pure USSD session engine against the tenant config in your browser —
        no gateway, no network. Selections accumulate as replay text for{" "}
        {tenantConfig.channels.ussdCode}.
      </ReadOnlyNote>

      <Card title="Handset">
        <div className="rounded-lg border border-slate-300 bg-slate-50 p-4">
          <p className="text-xs text-slate-500">
            {tenantConfig.channels.ussdCode} · language {activeLanguage} · replay:{" "}
            {submitted === "" ? "(empty)" : submitted}
          </p>
          <div className="mt-2">
            <FrameView frame={frame} />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <TextInput
            value={draft}
            onValueChange={setDraft}
            placeholder="Type a segment (e.g. 1, or a short code)"
          />
          <Button type="button" onClick={() => { submit(draft); }}>
            Send
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft("");
              setSubmitted("");
            }}
          >
            Restart
          </Button>
        </div>

        {frame?.kind === "prompt" && frame.choices.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {frame.choices.map((choice) => (
              <Button
                key={choice.key}
                type="button"
                variant="secondary"
                onClick={() => { submit(choice.key); }}
              >
                {choice.key} — {choice.label}
              </Button>
            ))}
          </div>
        ) : null}
      </Card>

      <Card title="Language">
        <div className="flex flex-wrap gap-2">
          {tenantConfig.locale.enabledLanguages.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              variant={candidate === activeLanguage ? "secondary" : "ghost"}
              onClick={() => { setLanguage(candidate); }}
            >
              {candidate}
            </Button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function FrameView(props: { readonly frame: SimulatorFrame | null }): ReactElement {
  const { frame } = props;
  if (frame === null) {
    return <p className="text-sm text-slate-500">Send a segment to start a session.</p>;
  }
  if (frame.kind === "prompt") {
    return (
      <div className="space-y-1 text-sm">
        {frame.errorLine !== null ? <p className="text-red-600">{frame.errorLine}</p> : null}
        <p className="whitespace-pre-line text-slate-900">{frame.prompt}</p>
        {frame.expectsInput ? (
          <p className="text-xs text-slate-500">This step expects typed input.</p>
        ) : null}
      </div>
    );
  }
  if (frame.kind === "action") {
    return (
      <div className="space-y-1 text-sm">
        <p className="text-slate-900">Engine action: {frame.action}</p>
        <CollectedList items={frame.collected} />
      </div>
    );
  }
  return (
    <div className="space-y-1 text-sm">
      <p className="text-slate-900">Session ended ({frame.endReason}).</p>
      <CollectedList items={frame.collected} />
    </div>
  );
}

function CollectedList(props: {
  readonly items: readonly { key: string; value: string }[];
}): ReactElement | null {
  if (props.items.length === 0) return null;
  return (
    <ul className="text-xs text-slate-600">
      {props.items.map((item) => (
        <li key={item.key}>
          {item.key} = {item.value}
        </li>
      ))}
    </ul>
  );
}
