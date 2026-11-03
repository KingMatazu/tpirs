import { useState, type FormEvent, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { unwrap, errorFrom, type ApiResult } from "../api/unwrap.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  ReadOnlyNote,
  TextInput,
} from "../components/ui.js";
import type { BadgeTone } from "../components/ui.js";
import { destinationsForRoles } from "../lib/appLinks.js";
import type { AppDestination, HandoverDetails } from "../lib/appLinks.js";
import { nationalIdHint } from "../lib/collectorProfile.js";
import { temporaryPassword } from "../lib/temporaryPassword.js";
import { useTenantConfig } from "../lib/tenantConfig.js";
import { describeError, pushToast } from "../toast.js";
import { useSession } from "../session.js";
import { HandoverCard } from "./HandoverCard.js";

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
  /** Contact and identity details; recorded for a collector. */
  readonly phone: string | null;
  readonly nationalId: string | null;
  readonly homeAddress: string | null;
  readonly status: "active" | "disabled";
  /** Primary first; the rest follow alphabetically, as the server returns them. */
  readonly roles: readonly string[];
  /** The role the person was hired for; null when no grant carries the mark. */
  readonly primaryRoleKey: string | null;
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
  return keys.map((key) => roles.find((role) => role.key === key)?.name ?? key).join(", ");
}

/**
 * Picks the role an account exists for, and any extra roles on top.
 *
 * The radio group is the primary role: one choice, and choosing another replaces
 * it, which is what "who is this person" means. The panel below it lists every
 * other role as a checkbox, so extra access is granted deliberately and — just as
 * important — can be taken away again by clearing the box. Neither list can show
 * the same role twice: the extras exclude whichever role is primary.
 *
 * A panel toggled by a button rather than a native multi-select: `select multiple`
 * needs Ctrl-click, and an administrator who picks one role and sees it replace
 * the previous one has no way to tell whether the form or the browser did that.
 * The checkboxes are only rendered while the panel is open, so a role never
 * appears twice on the screen at once — once as the primary radio, once as an
 * extra — which would make the two indistinguishable to a screen reader.
 */
export function RolePicker({
  name,
  roles,
  primary,
  extras,
  disabled = false,
  error,
  onPrimaryChange,
  onExtrasChange,
}: {
  readonly name: string;
  readonly roles: readonly RoleOption[];
  readonly primary: string;
  readonly extras: readonly string[];
  readonly disabled?: boolean;
  readonly error?: string;
  readonly onPrimaryChange: (key: string) => void;
  readonly onExtrasChange: (keys: readonly string[]) => void;
}): ReactElement {
  const [extrasOpen, setExtrasOpen] = useState(false);
  const chosenExtras = extras.filter((key) => key !== primary);
  const available = roles.filter((role) => role.key !== primary);
  const panelId = `${name}-extras`;
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-slate-700">Role</legend>
      <div className="flex flex-wrap gap-3">
        {roles.map((role) => (
          <label key={role.key} className="flex items-center gap-1 text-sm">
            <input
              type="radio"
              name={name}
              value={role.key}
              checked={primary === role.key}
              disabled={disabled}
              onChange={() => {
                // The new primary cannot also be an extra, so it leaves that list
                // rather than appearing in both.
                onExtrasChange(chosenExtras.filter((key) => key !== role.key));
                onPrimaryChange(role.key);
              }}
            />
            {role.name}
          </label>
        ))}
      </div>
      <button
        type="button"
        aria-expanded={extrasOpen}
        aria-controls={panelId}
        className="mt-2 text-xs font-medium text-slate-600 underline"
        onClick={() => {
          setExtrasOpen(!extrasOpen);
        }}
      >
        Additional roles:{" "}
        <span className="font-normal text-slate-500">
          {chosenExtras.length === 0 ? "none" : roleNames(roles, chosenExtras)}
        </span>
      </button>
      {extrasOpen ? (
        <div
          id={panelId}
          role="group"
          aria-label="Additional roles"
          className="mt-1 flex flex-wrap gap-3"
        >
          {primary === "" ? (
            <p className="text-xs text-slate-500">Choose a role first.</p>
          ) : (
            available.map((role) => (
              <label key={role.key} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={chosenExtras.includes(role.key)}
                  disabled={disabled}
                  onChange={() => {
                    onExtrasChange(toggleRole(chosenExtras, role.key));
                  }}
                />
                {role.name}
              </label>
            ))
          )}
        </div>
      ) : null}
      {error === undefined ? null : <p className="mt-1 text-xs text-red-600">{error}</p>}
    </fieldset>
  );
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
  return typeof body === "object" && body !== null
    ? (body as { issues?: unknown }).issues
    : undefined;
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
    phone: "",
    nationalId: "",
    homeAddress: "",
  });
  const [formPrimaryRole, setFormPrimaryRole] = useState("");
  const [formExtraRoles, setFormExtraRoles] = useState<readonly string[]>([]);
  /**
   * The temporary password is masked by default and shown only on request. It is
   * not a secret the administrator does not already know — they typed it or
   * pressed Generate — but this screen is often used in an office where a
   * shoulder is close to the monitor, and the card that hands it over is the
   * intended place to read it.
   */
  const [showFormPassword, setShowFormPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const [rolesForId, setRolesForId] = useState<string | undefined>(undefined);
  const [editPrimaryRole, setEditPrimaryRole] = useState("");
  const [editExtraRoles, setEditExtraRoles] = useState<readonly string[]>([]);
  const [passwordForId, setPasswordForId] = useState<string | undefined>(undefined);
  const [newPassword, setNewPassword] = useState("");
  /**
   * The handover card, which exists only while the password is still known: the
   * server hashes it and cannot give it back, so create and reset are the only
   * two moments that can produce one. `accountId` is present when the card was
   * re-opened from the account row, where it can offer to issue a new password.
   */
  const [handover, setHandover] = useState<
    | {
        readonly details: HandoverDetails;
        readonly destinations: readonly AppDestination[];
        readonly accountId?: string;
      }
    | undefined
  >(undefined);

  // The slug every sign-in form asks for, from the config this screen already
  // holds — so the card cannot disagree with what the apps expect.
  const { config: tenantPayload } = useTenantConfig();
  const slug = tenantPayload?.config.identity.slug;
  // The state's national ID rule, for the hint and the local check. The server
  // is authoritative; when the config has not loaded yet, it decides alone.
  const nationalIdPattern = tenantPayload?.config.collectors?.nationalIdPattern;
  /** The role set the API will receive: the primary one, then the extras. */
  const formRoleKeys =
    formPrimaryRole === ""
      ? []
      : [formPrimaryRole, ...formExtraRoles.filter((key) => key !== formPrimaryRole)];
  const isCollector = formRoleKeys.includes("collector");

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

    // A collector carries the state's cash, so the state needs to know who they
    // are and how to reach them. Everyone else is not asked.
    const local: Record<string, string> = {};
    if (formPrimaryRole === "") local["roleKeys"] = "Choose a role";
    if (isCollector) {
      if (form.phone.trim() === "") local["phone"] = "Enter a phone number";
      if (form.nationalId.trim() === "") {
        local["nationalId"] = "Enter the national ID number";
      } else if (
        nationalIdPattern !== undefined &&
        !new RegExp(nationalIdPattern).test(form.nationalId.trim())
      ) {
        local["nationalId"] = "Enter the national ID in the format this state uses";
      }
      if (form.homeAddress.trim() === "") local["homeAddress"] = "Enter a home address";
    }
    if (Object.keys(local).length > 0) {
      setFormErrors(local);
      setBusy(false);
      return;
    }

    try {
      const result = (await api.POST("/v1/users", {
        body: {
          username: form.username.trim(),
          displayName: form.displayName.trim(),
          email: form.email.trim(),
          password: form.password,
          roleKeys: formRoleKeys,
          primaryRoleKey: formPrimaryRole,
          ...(isCollector
            ? {
                phone: form.phone.trim(),
                nationalId: form.nationalId.trim(),
                homeAddress: form.homeAddress.trim(),
              }
            : {}),
        },
      })) as ApiResult<{ user: StaffAccount }>;
      if (result.error !== undefined && result.error !== null) {
        const issues = issueMap(errorIssues(result.error));
        if (Object.keys(issues).length > 0) setFormErrors(issues);
        else pushToast({ kind: "error", ...describeError(errorFrom(result)) });
        return;
      }
      const created = result.data?.user;
      if (created !== undefined) {
        // The password is known only here: it is in the form, not in the
        // response. Handing over anything less than the whole card is what made
        // an officer ask "which app, and what is the state called?".
        setHandover({
          details: {
            displayName: created.displayName,
            username: created.username,
            password: form.password,
            slug,
          },
          destinations: destinationsForRoles(created.roles),
        });
      }
      setForm({
        username: "",
        displayName: "",
        email: "",
        password: "",
        phone: "",
        nationalId: "",
        homeAddress: "",
      });
      setFormPrimaryRole("");
      setFormExtraRoles([]);
      // A new account is handed over from a card, so the field goes back to
      // masked rather than staying readable for whoever uses the screen next.
      setShowFormPassword(false);
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
      // The whole set is replaced, so unticking an extra role takes it away. The
      // primary is always part of the set: an account with no role at all cannot
      // open anything, and disabling it is the honest way to say that.
      await unwrap(
        api.PATCH("/v1/users/{id}", {
          params: { path: { id: account.id } },
          body: {
            roleKeys: [editPrimaryRole, ...editExtraRoles.filter((key) => key !== editPrimaryRole)],
            primaryRoleKey: editPrimaryRole,
          },
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
      // A reset is the other moment the password is known, so it produces the
      // same card: the person needs the address and the slug as much as the
      // password.
      setHandover({
        details: {
          displayName: account.displayName,
          username: account.username,
          password: newPassword,
          slug,
        },
        destinations: destinationsForRoles(account.roles),
      });
      setPasswordForId(undefined);
      setNewPassword("");
      setShowNewPassword(false);
      await refresh();
    } catch (error) {
      pushToast({ kind: "error", ...describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Issues a fresh temporary password for an account whose original one is gone.
   *
   * This is the only honest answer to "show me the password again": the server
   * stores a hash, so the old value cannot be recovered. Setting a new one ends
   * the account's sessions and re-flags it, which is what a re-handover means —
   * the old password stops working the moment this succeeds.
   */
  const issueNewPassword = async (accountId: string): Promise<void> => {
    const password = temporaryPassword();
    setBusy(true);
    try {
      const result = (await unwrap(
        api.POST("/v1/users/{id}/password", {
          params: { path: { id: accountId } },
          body: { password },
        }),
      )) as { user: StaffAccount };
      pushToast({
        kind: "success",
        message: `A new temporary password was set for ${result.user.username}. The old one no longer works.`,
      });
      setHandover({
        details: {
          displayName: result.user.displayName,
          username: result.user.username,
          password,
          slug,
        },
        destinations: destinationsForRoles(result.user.roles),
      });
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

      {handover === undefined ? null : (
        <HandoverCard
          details={handover.details}
          destinations={handover.destinations}
          busy={busy}
          {...(handover.accountId === undefined
            ? {}
            : {
                onNewPassword: () => {
                  void issueNewPassword(handover.accountId ?? "");
                },
              })}
          onDone={() => {
            setHandover(undefined);
          }}
        />
      )}

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
                {account.phone !== null ? (
                  <p className="text-xs text-slate-500">Phone {account.phone}</p>
                ) : null}
                {account.nationalId !== null ? (
                  <p className="text-xs text-slate-500">National ID {account.nationalId}</p>
                ) : null}
                {account.homeAddress !== null ? (
                  <p className="text-xs text-slate-500">Home address {account.homeAddress}</p>
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
                        // The server returns the primary first; the fallback keeps
                        // an account with no mark editable rather than stuck.
                        const primary = account.primaryRoleKey ?? account.roles[0] ?? "";
                        setEditPrimaryRole(primary);
                        setEditExtraRoles(account.roles.filter((key) => key !== primary));
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
                        setShowNewPassword(false);
                      }}
                    >
                      Reset password
                    </Button>
                    {account.mustChangeCredentials ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          // Re-opens the card without the password: the server
                          // cannot read it back, so this is the reminder, not
                          // the secret.
                          setHandover({
                            details: {
                              displayName: account.displayName,
                              username: account.username,
                              slug,
                            },
                            destinations: destinationsForRoles(account.roles),
                            // The password is gone, so the card can only offer
                            // to issue a new one — which needs the account id.
                            accountId: account.id,
                          });
                        }}
                      >
                        Handover
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {rolesForId === account.id ? (
                  <div
                    className="rounded-md border border-slate-200 p-2"
                    role="group"
                    aria-label={`Edit roles for ${account.username}`}
                  >
                    <RolePicker
                      name={`edit-roles-${account.id}`}
                      roles={roles}
                      primary={editPrimaryRole}
                      extras={editExtraRoles}
                      disabled={busy}
                      onPrimaryChange={setEditPrimaryRole}
                      onExtrasChange={setEditExtraRoles}
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      Clearing an additional role takes that access away when you save.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        disabled={busy || editPrimaryRole === ""}
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
                        type={showNewPassword ? "text" : "password"}
                        autoComplete="new-password"
                      />
                    </Field>
                    <div className="mt-1">
                      <Button
                        variant="ghost"
                        ariaLabel={
                          showNewPassword
                            ? "Hide the new temporary password"
                            : "Show the new temporary password"
                        }
                        onClick={() => {
                          setShowNewPassword(!showNewPassword);
                        }}
                      >
                        {showNewPassword ? "Hide" : "Show"}
                      </Button>
                    </div>
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
        <Card
          title="Add an account"
          description="The account must replace this password at first sign-in."
        >
          <form className="space-y-3" onSubmit={(event) => void createAccount(event)}>
            <div className="flex flex-wrap gap-3">
              <div className="w-48">
                <Field
                  label="Username"
                  hint="Lowercase, 3–40 characters"
                  {...(formErrors["username"] === undefined
                    ? {}
                    : { error: formErrors["username"] })}
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
                  label="Full name"
                  hint="As it appears on their ID"
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
                    type={showFormPassword ? "text" : "password"}
                    autoComplete="new-password"
                  />
                </Field>
                <div className="mt-1 flex gap-2">
                  <Button
                    variant="ghost"
                    ariaLabel={
                      showFormPassword
                        ? "Hide the temporary password"
                        : "Show the temporary password"
                    }
                    onClick={() => {
                      setShowFormPassword(!showFormPassword);
                    }}
                  >
                    {showFormPassword ? "Hide" : "Show"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setForm({ ...form, password: temporaryPassword() });
                    }}
                  >
                    Generate
                  </Button>
                </div>
              </div>
            </div>
            <RolePicker
              name="new-account-role"
              roles={roles}
              primary={formPrimaryRole}
              extras={formExtraRoles}
              disabled={busy}
              onPrimaryChange={setFormPrimaryRole}
              onExtrasChange={setFormExtraRoles}
              {...(formErrors["roleKeys"] === undefined ? {} : { error: formErrors["roleKeys"] })}
            />

            {isCollector ? (
              <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
                <legend className="px-1 text-sm font-medium text-slate-700">
                  Collector details
                </legend>
                <p className="-mt-1 text-xs text-slate-500">
                  A collector carries the state's cash, so these are required. They are shown to
                  staff with account access and never written to the audit trail.
                </p>
                <div className="flex flex-wrap gap-3">
                  <div className="w-56">
                    <Field
                      label="Phone number"
                      hint="The number to reach them on during a shift"
                      {...(formErrors["phone"] === undefined ? {} : { error: formErrors["phone"] })}
                    >
                      <TextInput
                        name="new-phone"
                        value={form.phone}
                        onValueChange={(value) => {
                          setForm({ ...form, phone: value });
                        }}
                        inputMode="tel"
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                  <div className="w-56">
                    <Field
                      label="National ID number"
                      hint={nationalIdHint(nationalIdPattern)}
                      {...(formErrors["nationalId"] === undefined
                        ? {}
                        : { error: formErrors["nationalId"] })}
                    >
                      <TextInput
                        name="new-national-id"
                        value={form.nationalId}
                        onValueChange={(value) => {
                          setForm({ ...form, nationalId: value });
                        }}
                        inputMode="numeric"
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                  <div className="w-72">
                    <Field
                      label="Home address"
                      {...(formErrors["homeAddress"] === undefined
                        ? {}
                        : { error: formErrors["homeAddress"] })}
                    >
                      <TextInput
                        name="new-home-address"
                        value={form.homeAddress}
                        onValueChange={(value) => {
                          setForm({ ...form, homeAddress: value });
                        }}
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                </div>
              </fieldset>
            ) : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create account"}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
