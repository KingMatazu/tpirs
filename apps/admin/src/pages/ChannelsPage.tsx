import { type ReactElement } from "react";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { catalogMatrix, flattenMenus } from "../lib/channelsView.js";
import { Card, EmptyState, ReadOnlyNote } from "../components/ui.js";
import { useSession } from "../session.js";

/**
 * Step 5: read-only driver-channel viewer. The USSD menu graph and the message
 * catalogues it shows are the same config the USSD engine consumes, so this
 * screen documents driver behavior exactly as configured — no code lookup.
 */
export function ChannelsPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("tenant:read"));
  const { config, isLoading, error } = useTenantConfig();

  if (!canRead) {
    return <p className="text-sm text-slate-600">You do not have permission to view channels.</p>;
  }
  if (isLoading) return <p className="text-sm text-slate-500">Loading channels…</p>;
  if (error !== null || config === undefined) {
    return <p className="text-sm text-red-600">Channel configuration could not be loaded.</p>;
  }
  const tenantConfig = config.config;
  const menus = flattenMenus(tenantConfig);
  const catalog = catalogMatrix(tenantConfig);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Driver channels</h1>
      <ReadOnlyNote>
        Read-only view of the tenant's USSD menu graph and SMS templates. Drivers
        check status and pay from here; under pay-per-use the channels never remind
        about days with no payment, because such days are not debts.
      </ReadOnlyNote>

      <Card title={`${tenantConfig.channels.ussdCode} (USSD)`}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">SMS keyword</dt>
          <dd className="text-slate-900">{tenantConfig.channels.smsKeyword}</dd>
          <dt className="text-slate-500">Start menu</dt>
          <dd className="text-slate-900">{tenantConfig.channels.startMenu ?? menus[0]?.key ?? "—"}</dd>
        </dl>
      </Card>

      <Card title="Menu graph" description="Breadth-first from the start menu; unreachable nodes appear last.">
        {menus.length === 0 ? (
          <EmptyState message="No menu nodes configured." />
        ) : (
          <ul className="space-y-2">
            {menus.map((menu) => (
              <li key={menu.key} className="rounded-md border border-slate-200 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-500">{menu.type}</span>
                  <span className="font-medium text-slate-900">{menu.key}</span>
                </div>
                {menu.promptKey !== null ? (
                  <p className="mt-1 text-slate-600">prompt: {menu.promptKey}</p>
                ) : null}
                {menu.action !== null ? (
                  <p className="mt-1 text-slate-600">action: {menu.action}</p>
                ) : null}
                {menu.inputKey !== null ? (
                  <p className="mt-1 text-slate-600">
                    input: {menu.inputKey}
                    {menu.inputPattern !== null ? ` (pattern ${menu.inputPattern})` : ""}
                  </p>
                ) : null}
                {menu.options.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {menu.options.map((option) => (
                      <li key={option.key} className="flex gap-2 text-slate-700">
                        <span className="font-mono">{option.key}</span>
                        <span>{option.labelKey}</span>
                        <span className="text-slate-400">
                          → {option.action ?? option.next ?? "end"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Message catalogue" description="Driver-facing copy per language, configured in tenant config.">
        {catalog.languages.length === 0 ? (
          <EmptyState message="No catalogues configured." />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-1 pr-4 font-medium">Key</th>
                {catalog.languages.map((language) => (
                  <th key={language} className="py-1 pr-4 font-medium">
                    {language}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {catalog.rows.map((row) => (
                <tr key={row.key} className="border-b border-slate-100 align-top">
                  <td className="py-1 pr-4 font-mono text-xs text-slate-500">{row.key}</td>
                  {row.cells.map((cell) => (
                    <td key={cell.language} className={`py-1 pr-4 ${cell.value === null ? "text-red-500" : "text-slate-800"}`}>
                      {cell.value ?? "missing"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
