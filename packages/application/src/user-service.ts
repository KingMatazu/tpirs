import { hashPassword } from "@tpirs/crypto";
import { DEFAULT_NATIONAL_ID_PATTERN } from "@tpirs/config";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb, UserRecord } from "@tpirs/db";

/**
 * Staff account management (Phase 11, 11.0b).
 *
 * Until now an account existed only if the seed or the onboarding wizard made
 * one. A state that hires a new officer, loses a finance admin or needs to
 * disable someone who has left had no supported move except a SQL editor. These
 * are the rules for the small set of operations that actually come up:
 *
 * - **Create** an account with a temporary password, an email identifier and at
 *   least one role. There is no mail sender yet, so the administrator hands the
 *   password over in person and the account is flagged `mustChangeCredentials`:
 *   its first sign-in can only replace that password.
 * - **Edit** the display name, the active/disabled status and the role set.
 * - **Reset** the password to a new temporary one, which also ends the account's
 *   live sessions — a reset that leaves the old sessions working is not a reset.
 *
 * Two rules are deliberate and enforced here rather than in the form:
 *
 * 1. **No self-service.** An administrator cannot change their own status, roles
 *    or password through these calls. The account that could quietly widen its
 *    own permissions is exactly the account an audit cannot catch, and a lost
 *    administrator is a two-person problem by design.
 * 2. **No credentials in the trail.** Passwords are hashed before they reach a
 *    repository and never appear in a return value, so the audit hook, which
 *    records what the route hands it, has nothing secret to record.
 */

export interface UserIssue {
  readonly path: string;
  readonly message: string;
}

export class UserValidationError extends Error {
  readonly issues: readonly UserIssue[];

  constructor(issues: readonly UserIssue[]) {
    super("The account details were not accepted");
    this.name = "UserValidationError";
    this.issues = issues;
  }
}

export class UserConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserConflictError";
  }
}

export class UserNotFoundError extends Error {
  constructor() {
    super("User not found");
    this.name = "UserNotFoundError";
  }
}

export type UserStatus = "active" | "disabled";

export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  /** Contact number, recorded for every collector and optional otherwise. */
  readonly phone: string | null;
  /** National identification number in the tenant's own format. */
  readonly nationalId: string | null;
  readonly homeAddress: string | null;
  readonly status: UserStatus;
  readonly roles: readonly string[];
  /** True while the account still holds a temporary password. */
  readonly mustChangeCredentials: boolean;
}

export interface RoleSummary {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISPLAY_NAME_MAX = 120;

/** Matches the onboarding rule; six is short, and it is the recorded decision. */
export const MIN_USER_PASSWORD_LENGTH = 6;

export function userPasswordIssues(input: {
  readonly username: string;
  readonly password: string;
}): readonly UserIssue[] {
  const issues: UserIssue[] = [];
  if (input.password.length < MIN_USER_PASSWORD_LENGTH) {
    issues.push({
      path: "password",
      message: `Use at least ${String(MIN_USER_PASSWORD_LENGTH)} characters`,
    });
  } else if (input.password.toLowerCase() === "password") {
    issues.push({ path: "password", message: '"password" is not a password; choose another' });
  } else if (
    input.username !== "" &&
    input.password.toLowerCase() === input.username.toLowerCase()
  ) {
    issues.push({ path: "password", message: "The password must not be the username" });
  }
  return issues;
}

function identityIssues(input: {
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
}): readonly UserIssue[] {
  const issues: UserIssue[] = [];
  const username = input.username.trim();
  if (!USERNAME_PATTERN.test(username)) {
    issues.push({
      path: "username",
      message: "Use 3-40 characters: lowercase letters, digits, dot, underscore or hyphen",
    });
  }
  const displayName = input.displayName.trim();
  if (displayName === "") {
    issues.push({ path: "displayName", message: "Enter a display name" });
  } else if (displayName.length > DISPLAY_NAME_MAX) {
    issues.push({
      path: "displayName",
      message: `Use at most ${String(DISPLAY_NAME_MAX)} characters`,
    });
  }
  // Required, not optional: it is the account identifier a password-reset flow
  // will use once a mail sender exists, and an account without one is a user
  // nobody can recover without an administrator.
  if (!EMAIL_PATTERN.test(input.email.trim())) {
    issues.push({ path: "email", message: "Enter a valid email" });
  }
  return issues;
}

function roleIssues(roleKeys: readonly string[]): readonly UserIssue[] {
  if (roleKeys.length === 0) {
    return [{ path: "roleKeys", message: "Choose at least one role" }];
  }
  return [];
}

/** The role whose holder takes cash from drivers and must be on file. */
const COLLECTOR_ROLE = "collector";
/** Digits, with an optional leading +, spaces and dashes as people write them. */
const PHONE_PATTERN = /^\+?[0-9][0-9\s-]{6,19}$/;
const ADDRESS_MIN = 5;
const ADDRESS_MAX = 200;

export interface CollectorProfile {
  readonly phone: string;
  readonly nationalId: string;
  readonly homeAddress: string;
}

/**
 * The three details a state records about a person who carries its cash.
 *
 * Required only for an account with the collector role: an officer or a finance
 * user is not holding money, and forcing a national ID onto them would be
 * collecting personal data for no purpose — which the brief forbids. When the
 * fields are present they are validated whatever the role, because a phone number
 * that is not one is no use in an emergency.
 *
 * The ID's shape is the tenant's rule (`collectors.nationalIdPattern`), not a
 * constant: eleven digits here, something else in another state.
 */
export function collectorProfileIssues(
  profile: CollectorProfile,
  roleKeys: readonly string[],
  nationalIdPattern: string,
): readonly UserIssue[] {
  const issues: UserIssue[] = [];
  const isCollector = roleKeys.includes(COLLECTOR_ROLE);
  const phone = profile.phone.trim();
  const nationalId = profile.nationalId.trim();
  const homeAddress = profile.homeAddress.trim();

  if (phone === "") {
    if (isCollector) issues.push({ path: "phone", message: "Enter a phone number" });
  } else if (!PHONE_PATTERN.test(phone)) {
    issues.push({ path: "phone", message: "Enter a phone number with at least 7 digits" });
  }

  if (nationalId === "") {
    if (isCollector) issues.push({ path: "nationalId", message: "Enter the national ID number" });
  } else if (!new RegExp(nationalIdPattern).test(nationalId)) {
    issues.push({
      path: "nationalId",
      message: "Enter the national ID in the format this state uses",
    });
  }

  if (homeAddress === "") {
    if (isCollector) issues.push({ path: "homeAddress", message: "Enter a home address" });
  } else if (homeAddress.length < ADDRESS_MIN || homeAddress.length > ADDRESS_MAX) {
    issues.push({
      path: "homeAddress",
      message: `Use between ${String(ADDRESS_MIN)} and ${String(ADDRESS_MAX)} characters`,
    });
  }

  return issues;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

function toSummary(user: UserRecord, roles: readonly string[]): UserSummary {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    nationalId: user.nationalId,
    homeAddress: user.homeAddress,
    status: user.status === "disabled" ? "disabled" : "active",
    roles: [...roles],
    mustChangeCredentials: user.mustChangeCredentials,
  };
}

/**
 * One account. Roles are read separately because the grant is a join table; the
 * per-user query is intentional — a tenant has tens of staff, not thousands, and
 * a hand-written join would obscure that the role list is the same call the
 * session uses to build permissions.
 */
async function summarize(
  repos: ReturnType<typeof repositories>,
  user: UserRecord,
): Promise<UserSummary> {
  return toSummary(user, await repos.roles.roleKeysForUser(user.id));
}

export async function listUsers(db: AnyDb, tenantId: string): Promise<readonly UserSummary[]> {
  return withTenant(db, tenantId, async (tx) => {
    const repos = repositories(tx);
    const users = await repos.users.list();
    const summaries: UserSummary[] = [];
    for (const user of users) summaries.push(await summarize(repos, user));
    return summaries;
  });
}

export async function getUser(
  db: AnyDb,
  tenantId: string,
  userId: string,
): Promise<UserSummary | undefined> {
  return withTenant(db, tenantId, async (tx) => {
    const repos = repositories(tx);
    const user = await repos.users.findById(userId);
    return user === undefined ? undefined : await summarize(repos, user);
  });
}

export async function listRoles(db: AnyDb, tenantId: string): Promise<readonly RoleSummary[]> {
  return withTenant(db, tenantId, async (tx) => {
    const roles = await repositories(tx).roles.list();
    return roles.map((role) => ({
      key: role.key,
      name: role.name,
      permissions: [...role.permissions],
    }));
  });
}

/** Rejects role keys that this tenant does not define (rather than silently dropping them). */
async function resolveRoleIds(
  repos: ReturnType<typeof repositories>,
  roleKeys: readonly string[],
): Promise<{ roleIds: string[]; issues: UserIssue[] }> {
  const roleIds: string[] = [];
  const unknown: string[] = [];
  for (const key of roleKeys) {
    const role = await repos.roles.findByKey(key);
    if (role === undefined) unknown.push(key);
    else roleIds.push(role.id);
  }
  if (unknown.length > 0) {
    return {
      roleIds: [],
      issues: [{ path: "roleKeys", message: `Unknown role: ${unknown.join(", ")}` }],
    };
  }
  return { roleIds, issues: [] };
}

export interface CreateUserInput {
  readonly tenantId: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly roleKeys: readonly string[];
  /** Contact and identity details; required only for a collector. */
  readonly phone?: string;
  readonly nationalId?: string;
  readonly homeAddress?: string;
  /**
   * The tenant's national ID rule. Defaults to the platform pattern so a caller
   * that does not load config still applies one.
   */
  readonly nationalIdPattern?: string;
}

export async function createUser(db: AnyDb, input: CreateUserInput): Promise<UserSummary> {
  const profile: CollectorProfile = {
    phone: input.phone ?? "",
    nationalId: input.nationalId ?? "",
    homeAddress: input.homeAddress ?? "",
  };
  const issues = [
    ...identityIssues(input),
    ...roleIssues(input.roleKeys),
    ...collectorProfileIssues(
      profile,
      input.roleKeys,
      input.nationalIdPattern ?? DEFAULT_NATIONAL_ID_PATTERN,
    ),
    ...userPasswordIssues({ username: input.username.trim(), password: input.password }),
  ];
  if (issues.length > 0) throw new UserValidationError(issues);

  const username = input.username.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();

  try {
    return await withTenant(db, input.tenantId, async (tx) => {
      const repos = repositories(tx);
      const { roleIds, issues: roleProblems } = await resolveRoleIds(repos, input.roleKeys);
      if (roleProblems.length > 0) throw new UserValidationError(roleProblems);

      const user = await repos.users.create({
        tenantId: input.tenantId,
        username,
        displayName: input.displayName.trim(),
        email,
        phone: profile.phone.trim() === "" ? null : profile.phone.trim(),
        nationalId: profile.nationalId.trim() === "" ? null : profile.nationalId.trim(),
        homeAddress: profile.homeAddress.trim() === "" ? null : profile.homeAddress.trim(),
        passwordHash: await hashPassword(input.password),
        totpSecret: null,
        // The administrator knows this password, so it is temporary by
        // construction: the first sign-in may only replace it.
        mustChangeCredentials: true,
      });
      for (const roleId of roleIds) {
        await repos.roles.assignToUser({ tenantId: input.tenantId, userId: user.id, roleId });
      }
      return await summarize(repos, user);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new UserConflictError("That username or email is already in use in this tenant");
    }
    throw error;
  }
}

export interface UpdateUserInput {
  readonly tenantId: string;
  /** The administrator making the change; must not be the account being edited. */
  readonly actorUserId: string;
  readonly userId: string;
  readonly displayName?: string;
  readonly status?: UserStatus;
  readonly roleKeys?: readonly string[];
}

export async function updateUser(db: AnyDb, input: UpdateUserInput): Promise<UserSummary> {
  assertNotSelf(input.actorUserId, input.userId);

  const issues: UserIssue[] = [];
  if (input.displayName !== undefined) {
    const displayName = input.displayName.trim();
    if (displayName === "") issues.push({ path: "displayName", message: "Enter a display name" });
    else if (displayName.length > DISPLAY_NAME_MAX) {
      issues.push({
        path: "displayName",
        message: `Use at most ${String(DISPLAY_NAME_MAX)} characters`,
      });
    }
  }
  if (input.roleKeys !== undefined) issues.push(...roleIssues(input.roleKeys));
  if (issues.length > 0) throw new UserValidationError(issues);

  return withTenant(db, input.tenantId, async (tx) => {
    const repos = repositories(tx);
    const existing = await repos.users.findById(input.userId);
    if (existing === undefined) throw new UserNotFoundError();

    let roleIds: string[] | undefined;
    if (input.roleKeys !== undefined) {
      const resolved = await resolveRoleIds(repos, input.roleKeys);
      if (resolved.issues.length > 0) throw new UserValidationError(resolved.issues);
      roleIds = resolved.roleIds;
    }

    const updated = await repos.users.updateProfile(input.userId, {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    if (updated === undefined) throw new UserNotFoundError();

    if (roleIds !== undefined) {
      await repos.roles.clearRolesForUser(input.userId);
      for (const roleId of roleIds) {
        await repos.roles.assignToUser({ tenantId: input.tenantId, userId: input.userId, roleId });
      }
    }
    return await summarize(repos, updated);
  });
}

export interface ResetPasswordInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly userId: string;
  readonly password: string;
}

/**
 * Sets a new temporary password and ends every open session for the account.
 * The new password is checked against that account's username, not the
 * administrator's, because it is the account that has to be unusable as a guess.
 */
export async function resetUserPassword(
  db: AnyDb,
  input: ResetPasswordInput,
): Promise<UserSummary> {
  assertNotSelf(input.actorUserId, input.userId);

  return withTenant(db, input.tenantId, async (tx) => {
    const repos = repositories(tx);
    const existing = await repos.users.findById(input.userId);
    if (existing === undefined) throw new UserNotFoundError();

    const issues = userPasswordIssues({ username: existing.username, password: input.password });
    if (issues.length > 0) throw new UserValidationError(issues);

    const updated = await repos.users.setTemporaryPassword(
      input.userId,
      await hashPassword(input.password),
    );
    if (updated === undefined) throw new UserNotFoundError();
    await repos.sessions.revokeAllForUser(input.userId);
    return await summarize(repos, updated);
  });
}

export interface ChangeOwnPasswordInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly password: string;
}

/**
 * The owner of a temporary password replaces it, keeping the username the
 * administrator handed them.
 *
 * This is the staff counterpart of `completeOnboarding`, and deliberately not the
 * same call. Onboarding also forces a new *username*, because the provisioning
 * account is literally `admin` with the password `password` — a published pair.
 * A staff account was given a real username on a handover card, so asking the
 * person to invent another one only makes the card wrong.
 *
 * Every open session is ended, exactly as an administrator's reset does: the
 * sessions in question were authorised by the password that has just stopped
 * working. The route replaces the caller's own session afterwards.
 */
export async function changeOwnPassword(
  db: AnyDb,
  input: ChangeOwnPasswordInput,
): Promise<UserSummary> {
  return withTenant(db, input.tenantId, async (tx) => {
    const repos = repositories(tx);
    const existing = await repos.users.findById(input.userId);
    if (existing === undefined) throw new UserNotFoundError();

    const issues = userPasswordIssues({ username: existing.username, password: input.password });
    if (issues.length > 0) throw new UserValidationError(issues);

    const updated = await repos.users.changePassword(
      input.userId,
      await hashPassword(input.password),
    );
    if (updated === undefined) throw new UserNotFoundError();
    await repos.sessions.revokeAllForUser(input.userId);
    // Recorded here rather than by the route's audit descriptor: only the
    // service sees the flag it just cleared, and the hash is never part of it.
    await repos.audit.record({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: "auth.credentials_changed",
      entityType: "user",
      entityId: input.userId,
      before: {
        username: existing.username,
        mustChangeCredentials: existing.mustChangeCredentials,
      },
      after: { username: updated.username, mustChangeCredentials: false },
    });
    return await summarize(repos, updated);
  });
}

function assertNotSelf(actorUserId: string, userId: string): void {
  if (actorUserId === userId) {
    throw new UserConflictError(
      "You cannot change your own account here; ask another administrator to do it",
    );
  }
}
