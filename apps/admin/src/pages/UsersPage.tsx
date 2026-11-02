import { useState, type FormEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { unwrap, errorFrom, type ApiResult } from "../api/unwrap.js";
import { Badge, Button, Card, EmptyState, Field, ReadOnlyNote, TextInput } from "../components/ui.js";
import type { BadgeTone } from "../components/ui.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";

/**
 * Staff accounts (Phase 11, 11.0b).
 *
 * Create an account with a temporary password, change its roles, disable it, or
 * reset its password. The server enforces the rules (see
 * `@tpirs/application/src/user-service.ts`): anyone with the temporary password
 * must replace it at first sign-in, and no administrator can edit their own
 * account here — the screen shows that rather than letting the attempt fail.
 */
export interface StaffAccount {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly status: "active" | "disabled";
  readonly roles: readonly string[];
  readonly mustChangeCredentials: boolean;
}

export interface RoleOption {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

const USERS_KEY = ["users"] as const;
const ROLES_KEY = ["roles"] as const;

export function statusTone(status: StaffAccount["status"]): BadgeTone {
  return status === "active" ? "positive" : "neutral";
}

export function statusLabel(status: StaffAccount["status"]): string {
  return status === "active" ? "Active" : "Disabled";
}

/** Adds or removes a role key without mutating the input list. */
export function toggleRole(keys: readonly string[], key: string): readonly string[] {
  return keys.includes(key) ? keys.filter((candidate) => candidate !== key) : [...keys, key];
}

export function roleNames(roles: readonly RoleOption[], keys: readonly string[]): string {
  if (keys.length === 0) return "No role";
  return keys
    .map((key) => roles.find((role) => role.key === key)?.name ?? key)
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
}

function issueMap(issues: unknown): Record<string, string> {
  const mapped: Record<string, string> = {};
  if (!Array.isArray(issues)) return mapped;
  for (const item of issues) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.message !== "string") continue;
    mapped[record.path] ??= record.message;
  }
  return mapped;
}

function errorIssues(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const body = (error as { error?: unknown }).error;
  return typeof body === "object" && body !== null ? (body as { issues?: unknown }).issues : undefined;
}

export function UsersPage(): ReactElement {
  const canRead = useSession((state) => state.hasPermission("user:read"));
  const canManage = useSession((state) => state.hasPermission("user:manage"));
  const currentUserId = useSession((state) => state.user?.userId);
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    username: "",
    displayName: "",
    email: "",
    password: "",
  });
  const [formRoles, setFormRoles] = useState<readonly string[]>([]);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const [rolesForId, setRolesForId] = useState<string | undefined>(undefined);
  const [roleSelection, setRoleSelection] = useState<readonly string[]>([]);
  const [passwordForId, setPasswordForId] = useState<string | undefined>(undefined);
  const [newPassword, setNewPassword] = useState("");

  const usersQuery = useQuery({
    queryKey: USERS_KEY,
    enabled: canRead,
    queryFn: async () => (await unwrap(await api.GET("/v1/users"))).users,
  });
  const rolesQuery = useQuery({
    queryKey: ROLES_KEY,
    enabled: canRead,
    queryFn: async () => (await unwrap(await api.GET("/v1/roles"))).roles,
  });

  if (!canRead) {
    return <p className="text-sm text-slate-600">You do not have permission to view accounts.</p>;
  }

  const users = usersQuery.data ?? [];
  const roles = rolesQuery.data ?? [];

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: USERS_KEY });
  };

  const createAccount = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setFormErrors({});
    try {
      const result = (await api.POST("/v1/users", {
        body: {
          username: form.username.trim(),
          displayName: form.displayName.trim(),
          email: form.email.trim(),
          password: form.password,
          roleKeys: [...formRoles],
        },
      })) as ApiResult<{ user: StaffAccount }>;
      if (result.error !== undefined && result.error !== null) {
        const issues = issueMap(errorIssues(result.error));
        if (Object.keys(issues).length > 0) setFormErrors(issues);
        else pushToast({ kind: "error", ...describeError(errorFrom(result)) });
        return;
      }
      pushToast({
        kind: "success",
        message: `Account "${form.username.trim()}" created. Hand over the temporary password directly; it must be replaced at first sign-in.`,
      });
      setForm({ username: "", displayName: "", email: "", password: "" });
      setFormRoles([]);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (account: StaffAccount): Promise<void> => {
    setBusy(true);
    try {
      const next = account.status === "active" ? "disabled" : "active";
      await unwrap(
        api.PATCH("/v1/users/{id}", {
          params: { path: { id: account.id } },
          body: { status: next },
        }),
      );
      pushToast({
        kind: "success",
        message: `${account.username} is now ${next === "active" ? "active" : "disabled"}.`,
      });
      await refresh();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const saveRoles = async (account: StaffAccount): Promise<void> => {
    setBusy(true);
    try {
      await unwrap(
        api.PATCH("/v1/users/{id}", {
          params: { path: { id: account.id } },
          body: { roleKeys: [...roleSelection] },
        }),
      );
      pushToast({ kind: "success", message: `Roles updated for ${account.username}.` });
      setRolesForId(undefined);
      await refresh();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (account: StaffAccount): Promise<void> => {
    setBusy(true);
    try {
      await unwrap(
        api.POST("/v1/users/{id}/password", {
          params: { path: { id: account.id } },
          body: { password: newPassword },
        }),
      );
      pushToast({
        kind: "success",
        message: `Password reset for ${account.username}. Their sessions ended and the new password must be replaced at next sign-in.`,
      });
      setPasswordForId(undefined);
      setNewPassword("");
      await refresh();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Accounts</h1>
      <ReadOnlyNote>
        Staff accounts and the roles that decide which screens they can open. A new account starts
        with a temporary password that must be replaced at its first sign-in; nobody can change
        their own roles or status here.
      </ReadOnlyNote>

      <Card title="Accounts" description={`${users.length} in this tenant`}>
        {usersQuery.isLoading ? <p className="text-sm text-slate-500">Loading accounts…</p> : null}
        {usersQuery.error !== null ? (
          <p className="text-sm text-red-600">Accounts could not be loaded.</p>
        ) : null}
        {!usersQuery.isLoading && usersQuery.error === null && users.length === 0 ? (
          <EmptyState message="No accounts yet." />
        ) : null}
        {users.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {users.map((account) => (
              <li key={account.id} className="space-y-2 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{account.username}</span>
                  <span className="text-slate-500">{account.displayName}</span>
                  <Badge tone={statusTone(account.status)}>{statusLabel(account.status)}</Badge>
                  {account.mustChangeCredentials ? (
                    <Badge tone="warning">Temporary password</Badge>
                  ) : null}
                  <span className="ml-auto text-xs text-slate-500">
                    {roleNames(roles, account.roles)}
                  </span>
                </div>
                {account.email !== null ? (
                  <p className="text-xs text-slate-500">{account.email}</p>
                ) : null}

                {canManage && account.id !== currentUserId ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        void setStatus(account);
                      }}
                    >
                      {account.status === "active" ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setPasswordForId(undefined);
                        setRolesForId(rolesForId === account.id ? undefined : account.id);
                        setRoleSelection(account.roles);
                      }}
                    >
                      Edit roles
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setRolesForId(undefined);
                        setPasswordForId(passwordForId === account.id ? undefined : account.id);
                        setNewPassword("");
                      }}
                    >
                      Reset password
                    </Button>
                  </div>
                ) : null}

                {rolesForId === account.id ? (
                  <div className="rounded-md border border-slate-200 p-2">
                    <p className="mb-1 text-xs font-medium text-slate-600">Roles</p>
                    <div className="flex flex-wrap gap-3">
                      {roles.map((role) => (
                        <label key={role.key} className="flex items-center gap-1 text-xs">
                          <input
                            type="checkbox"
                            checked={roleSelection.includes(role.key)}
                            onChange={() => {
                              setRoleSelection(toggleRole(roleSelection, role.key));
                            }}
                          />
                          {role.name}
                        </label>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button
                        disabled={busy || roleSelection.length === 0}
                        onClick={() => {
                          void saveRoles(account);
                        }}
                      >
                        Save roles
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setRolesForId(undefined);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}

                {passwordForId === account.id ? (
                  <div className="rounded-md border border-slate-200 p-2">
                    <Field label="New temporary password" hint="At least 6 characters">
                      <TextInput
                        name={`password-${account.id}`}
                        value={newPassword}
                        onValueChange={setNewPassword}
                        type="password"
                        autoComplete="new-password"
                      />
                    </Field>
                    <div className="mt-2 flex gap-2">
                      <Button
                        disabled={busy || newPassword === ""}
                        onClick={() => {
                          void resetPassword(account);
                        }}
                      >
                        Set temporary password
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setPasswordForId(undefined);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {canManage ? (
        <Card title="Add an account" description="The account must replace this password at first sign-in.">
          <form className="space-y-3" onSubmit={(event) => void createAccount(event)}>
            <div className="flex flex-wrap gap-3">
              <div className="w-48">
                <Field
                  label="Username"
                  hint="Lowercase, 3–40 characters"
                  {...(formErrors["username"] === undefined ? {} : { error: formErrors["username"] })}
                >
                  <TextInput
                    name="new-username"
                    value={form.username}
                    onValueChange={(value) => {
                      setForm({ ...form, username: value });
                    }}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <div className="w-56">
                <Field
                  label="Display name"
                  {...(formErrors["displayName"] === undefined
                    ? {}
                    : { error: formErrors["displayName"] })}
                >
                  <TextInput
                    name="new-display-name"
                    value={form.displayName}
                    onValueChange={(value) => {
                      setForm({ ...form, displayName: value });
                    }}
                  />
                </Field>
              </div>
              <div className="w-64">
                <Field
                  label="Email"
                  {...(formErrors["email"] === undefined ? {} : { error: formErrors["email"] })}
                >
                  <TextInput
                    name="new-email"
                    value={form.email}
                    onValueChange={(value) => {
                      setForm({ ...form, email: value });
                    }}
                    autoComplete="off"
                  />
                </Field>
              </div>
              <div className="w-56">
                <Field
                  label="Temporary password"
                  hint="At least 6 characters"
                  {...(formErrors["password"] === undefined
                    ? {}
                    : { error: formErrors["password"] })}
                >
                  <TextInput
                    name="new-password"
                    value={form.password}
                    onValueChange={(value) => {
                      setForm({ ...form, password: value });
                    }}
                    type="password"
                    autoComplete="new-password"
                  />
                </Field>
              </div>
            </div>
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-slate-700">Roles</legend>
              <div className="flex flex-wrap gap-3">
                {roles.map((role) => (
                  <label key={role.key} className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={formRoles.includes(role.key)}
                      onChange={() => {
                        setFormRoles(toggleRole(formRoles, role.key));
                      }}
                    />
                    {role.name}
                  </label>
                ))}
              </div>
              {formErrors["roleKeys"] === undefined ? null : (
                <p className="mt-1 text-xs text-red-600">{formErrors["roleKeys"]}</p>
              )}
            </fieldset>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create account"}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
