import { generateTemporaryPassword, hashPassword } from "@tpirs/crypto";
import { DEFAULT_NATIONAL_ID_PATTERN } from "@tpirs/config";
import { repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb, UserRecord, UserRoleGrant } from "@tpirs/db";

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
  /** The roles this account holds, primary first. */
  readonly roles: readonly string[];
  /**
   * The role the person was hired for. Null for an account whose grants were
   * written without one — a row from before migration 0023 whose backfill found
   * no role, or a caller that assigned roles directly.
   */
  readonly primaryRoleKey: string | null;
  /** True while the account still holds a temporary password. */
  readonly mustChangeCredentials: boolean;
  /**
   * The zone a supervisor is responsible for. Null for every other role, and for
   * a supervisor whose zone has not been recorded yet.
   */
  readonly zoneId: string | null;
  /** The zone's name, so a list can print it without a second request. */
  readonly zoneName: string | null;
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

/**
 * The primary role has to be one of the roles being assigned. A key outside the
 * list would either be silently ignored or added, and both are wrong: the first
 * loses the administrator's choice, the second grants access they did not ask
 * for. Saying so is the only honest answer.
 */
function primaryRoleIssues(
  roleKeys: readonly string[],
  primaryRoleKey: string | undefined,
): readonly UserIssue[] {
  if (primaryRoleKey === undefined) return [];
  if (roleKeys.includes(primaryRoleKey)) return [];
  return [
    {
      path: "primaryRoleKey",
      message: "Choose the primary role from the roles you are assigning",
    },
  ];
}

/** The role whose holder takes cash from drivers and must be on file. */
const COLLECTOR_ROLE = "collector";
const SUPERVISOR_ROLE = "zone_supervisor";
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

/**
 * A zone supervisor is responsible for one zone, so the account needs one.
 *
 * Required only when the role set contains `zone_supervisor`, the same shape as
 * the collector profile: a role that carries a duty carries the data the duty
 * needs. Any other account may hold a zone (it is harmless), but a supervisor
 * without one could not register a vehicle anywhere, so creation refuses it.
 *
 * The zone's existence is checked inside the transaction, where row-level
 * security means another tenant's zone simply is not found.
 */
export function zoneIssues(
  roleKeys: readonly string[],
  zoneId: string | undefined,
): readonly UserIssue[] {
  if (!roleKeys.includes(SUPERVISOR_ROLE)) return [];
  if (zoneId !== undefined && zoneId.trim() !== "") return [];
  return [{ path: "zoneId", message: "Choose the zone this supervisor is responsible for" }];
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

function toSummary(
  user: UserRecord,
  grants: readonly UserRoleGrant[],
  zoneName: string | null,
): UserSummary {
  const primary = grants.find((grant) => grant.isPrimary);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    nationalId: user.nationalId,
    homeAddress: user.homeAddress,
    status: user.status === "disabled" ? "disabled" : "active",
    roles: grants.map((grant) => grant.key),
    primaryRoleKey: primary === undefined ? null : primary.key,
    mustChangeCredentials: user.mustChangeCredentials,
    zoneId: user.zoneId,
    zoneName,
  };
}

/**
 * One account. Roles are read separately because the grant is a join table; the
 * per-user query is intentional — a tenant has tens of staff, not thousands, and
 * a hand-written join would obscure that the role list is the same call the
 * session uses to build permissions.
 *
 * The zone is resolved here rather than joined, for the same reason: the account
 * list prints a name, and a supervisor's zone is one row.
 */
async function summarize(
  repos: ReturnType<typeof repositories>,
  user: UserRecord,
): Promise<UserSummary> {
  const grants = await repos.roles.rolesForUser(user.id);
  const zone = user.zoneId === null ? undefined : await repos.zones.findById(user.zoneId);
  return toSummary(user, grants, zone?.name ?? null);
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

/**
 * Rejects role keys that this tenant does not define (rather than silently
 * dropping them), and returns the resolved grants so the caller can name the
 * primary one without a second lookup.
 */
async function resolveRoles(
  repos: ReturnType<typeof repositories>,
  roleKeys: readonly string[],
): Promise<{ roles: { id: string; key: string }[]; issues: UserIssue[] }> {
  const roles: { id: string; key: string }[] = [];
  const unknown: string[] = [];
  for (const key of roleKeys) {
    const role = await repos.roles.findByKey(key);
    if (role === undefined) unknown.push(key);
    else roles.push({ id: role.id, key: role.key });
  }
  if (unknown.length > 0) {
    return {
      roles: [],
      issues: [{ path: "roleKeys", message: `Unknown role: ${unknown.join(", ")}` }],
    };
  }
  return { roles, issues: [] };
}

/**
 * Records which of the resolved roles is the person's primary one.
 *
 * The default is the first key the caller sent, which is the only possible answer
 * for a single-role account and keeps that common case free of an extra field. A
 * key that is not in the resolved set is ignored here because `primaryRoleIssues`
 * has already refused it — reaching this point with a stranger's key would mean
 * the validation and the write disagree.
 */
async function markPrimary(
  repos: ReturnType<typeof repositories>,
  userId: string,
  resolved: readonly { id: string; key: string }[],
  primaryRoleKey: string | undefined,
): Promise<void> {
  const wanted = primaryRoleKey ?? resolved[0]?.key;
  const primary = resolved.find((role) => role.key === wanted);
  if (primary === undefined) return;
  await repos.roles.setPrimaryRoleForUser({ userId, roleId: primary.id });
}

export interface CreateUserInput {
  readonly tenantId: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly roleKeys: readonly string[];
  /**
   * The role the person is being hired for. Optional so a single-role account
   * needs no extra field: it defaults to the first key, which for one role is the
   * only possible answer.
   */
  readonly primaryRoleKey?: string;
  /** Contact and identity details; required only for a collector. */
  readonly phone?: string;
  readonly nationalId?: string;
  readonly homeAddress?: string;
  /** The zone a supervisor is responsible for; required for that role only. */
  readonly zoneId?: string;
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
    ...primaryRoleIssues(input.roleKeys, input.primaryRoleKey),
    ...collectorProfileIssues(
      profile,
      input.roleKeys,
      input.nationalIdPattern ?? DEFAULT_NATIONAL_ID_PATTERN,
    ),
    ...zoneIssues(input.roleKeys, input.zoneId),
    ...userPasswordIssues({ username: input.username.trim(), password: input.password }),
  ];
  if (issues.length > 0) throw new UserValidationError(issues);

  const username = input.username.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();

  try {
    return await withTenant(db, input.tenantId, async (tx) => {
      const repos = repositories(tx);
      const { roles: resolved, issues: roleProblems } = await resolveRoles(repos, input.roleKeys);
      if (roleProblems.length > 0) throw new UserValidationError(roleProblems);

      // A zone named for an account that is not a supervisor is stored anyway:
      // it is harmless, it is what the form sent, and clearing it on a role
      // change is the edit path's job.
      let zoneId: string | null = null;
      if (input.zoneId !== undefined && input.zoneId.trim() !== "") {
        const zone = await repos.zones.findById(input.zoneId.trim());
        if (zone === undefined) {
          throw new UserValidationError([
            { path: "zoneId", message: "That zone does not exist in this tenant" },
          ]);
        }
        zoneId = zone.id;
      }

      const user = await repos.users.create({
        tenantId: input.tenantId,
        username,
        displayName: input.displayName.trim(),
        email,
        phone: profile.phone.trim() === "" ? null : profile.phone.trim(),
        nationalId: profile.nationalId.trim() === "" ? null : profile.nationalId.trim(),
        homeAddress: profile.homeAddress.trim() === "" ? null : profile.homeAddress.trim(),
        zoneId,
        passwordHash: await hashPassword(input.password),
        totpSecret: null,
        // The administrator knows this password, so it is temporary by
        // construction: the first sign-in may only replace it.
        mustChangeCredentials: true,
      });
      for (const role of resolved) {
        await repos.roles.assignToUser({
          tenantId: input.tenantId,
          userId: user.id,
          roleId: role.id,
        });
      }
      await markPrimary(repos, user.id, resolved, input.primaryRoleKey);
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
  /**
   * Moves the primary mark, either as part of a role replacement or on its own.
   * Sending it without `roleKeys` only re-labels a grant the account already
   * holds; it never grants the role, so a typo cannot widen access.
   */
  readonly primaryRoleKey?: string;
  /**
   * The zone a supervisor is responsible for. `null` clears it. Omitted leaves
   * the recorded zone alone, so renaming an account does not wipe its zone.
   */
  readonly zoneId?: string | null;
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
  // Only checkable here when the role set is being replaced; a lone
  // `primaryRoleKey` is checked against the grants inside the transaction, where
  // they can actually be read.
  if (input.roleKeys !== undefined) {
    issues.push(...primaryRoleIssues(input.roleKeys, input.primaryRoleKey));
    // The zone's existence is checked inside the transaction; only the
    // "required for a supervisor" rule is decidable here.
    issues.push(...zoneIssues(input.roleKeys, input.zoneId ?? undefined));
  }
  if (issues.length > 0) throw new UserValidationError(issues);

  return withTenant(db, input.tenantId, async (tx) => {
    const repos = repositories(tx);
    const existing = await repos.users.findById(input.userId);
    if (existing === undefined) throw new UserNotFoundError();

    const roleKeys = input.roleKeys;
    let resolved: { id: string; key: string }[] | undefined;
    if (roleKeys !== undefined) {
      const outcome = await resolveRoles(repos, roleKeys);
      if (outcome.issues.length > 0) throw new UserValidationError(outcome.issues);
      resolved = outcome.roles;
    }

    // The effective role set decides whether a zone is required: a role edit can
    // make an account a supervisor, and then the zone must come with it.
    const effectiveRoles =
      roleKeys ?? (await repos.roles.rolesForUser(input.userId)).map((grant) => grant.key);
    const wantsZone = effectiveRoles.includes(SUPERVISOR_ROLE);
    const requestedZone = input.zoneId === undefined ? existing.zoneId : input.zoneId;
    let zoneId: string | null = existing.zoneId;
    if (wantsZone) {
      if (requestedZone === null || requestedZone.trim() === "") {
        throw new UserValidationError([
          { path: "zoneId", message: "Choose the zone this supervisor is responsible for" },
        ]);
      }
      const zone = await repos.zones.findById(requestedZone);
      if (zone === undefined) {
        throw new UserValidationError([
          { path: "zoneId", message: "That zone does not exist in this tenant" },
        ]);
      }
      zoneId = zone.id;
    } else if (input.zoneId !== undefined || roleKeys !== undefined) {
      // No longer a supervisor: the zone has no meaning, so it is cleared rather
      // than left behind to confuse the next edit.
      zoneId = null;
    }

    const updated = await repos.users.updateProfile(input.userId, {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
      ...(input.status === undefined ? {} : { status: input.status }),
      zoneId,
    });
    if (updated === undefined) throw new UserNotFoundError();

    if (resolved !== undefined) {
      await repos.roles.clearRolesForUser(input.userId);
      for (const role of resolved) {
        await repos.roles.assignToUser({
          tenantId: input.tenantId,
          userId: input.userId,
          roleId: role.id,
        });
      }
      await markPrimary(repos, input.userId, resolved, input.primaryRoleKey);
    } else if (input.primaryRoleKey !== undefined) {
      const held = await repos.roles.rolesForUser(input.userId);
      const grant = held.find((role) => role.key === input.primaryRoleKey);
      if (grant === undefined) {
        throw new UserValidationError([
          {
            path: "primaryRoleKey",
            message: "That role is not assigned to this account",
          },
        ]);
      }
      const role = await repos.roles.findByKey(input.primaryRoleKey);
      if (role === undefined) throw new UserNotFoundError();
      await repos.roles.setPrimaryRoleForUser({ userId: input.userId, roleId: role.id });
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

export interface ResetOwnPasswordInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly password: string;
}

/**
 * An administrator re-issues their own password as a temporary one.
 *
 * This exists for one reason: there is no email sender yet, so an administrator
 * who forgets their password has no recovery path, and the account that created
 * the tenant is the account nobody else can reset. It is a **temporary measure**
 * and is removed when forgot-password arrives (ADR 0060).
 *
 * It is not the self-service escape hatch the general reset refuses: the caller
 * can only touch their own account, the new password is flagged temporary so the
 * next sign-in must replace it, and every other session ends — a reset that
 * leaves an old token working is not a reset.
 */
export async function resetOwnPasswordToTemporary(
  db: AnyDb,
  input: ResetOwnPasswordInput,
): Promise<UserSummary> {
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
    await repos.audit.record({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: "user.password.self_reissued",
      entityType: "user",
      entityId: input.userId,
      before: { username: existing.username },
      // No password, no hash: the trail says what happened, not what it was.
      after: { username: updated.username, mustChangeCredentials: true, temporary: true },
    });
    return await summarize(repos, updated);
  });
}

export interface ReissuedAdminPassword {
  readonly username: string;
  readonly password: string;
}

/**
 * Re-issues the tenant creator's temporary password for a deployment operator.
 *
 * The account that created the tenant is the first account the tenant had, and
 * it is the one nobody can reset: every other reset needs a signed-in
 * administrator. With no email sender, a lost password would otherwise mean a SQL
 * editor. The route that calls this is gated by `SETUP_TOKEN`, so possession of
 * the deployment secret is the authorisation — which is why the account is
 * identified by its role and creation order rather than by a username an
 * attacker would have to guess.
 *
 * Temporary by construction: the flag is set, every session ends, and the audit
 * row names the setup token as the source without ever recording the token or the
 * password.
 */
export async function reissueAdminTemporaryPassword(
  db: AnyDb,
  input: { readonly tenantSlug: string },
): Promise<ReissuedAdminPassword | undefined> {
  const slug = input.tenantSlug.trim().toLowerCase();
  if (slug === "") return undefined;
  const tenant = await withSystem(db, (tx) => repositories(tx).tenants.findBySlug(slug));
  if (tenant === undefined) return undefined;

  return withTenant(db, tenant.id, async (tx) => {
    const repos = repositories(tx);
    const admin = await repos.users.findEarliestWithRole("system_admin");
    if (admin === undefined) return undefined;

    const password = generateTemporaryPassword();
    await repos.users.setTemporaryPassword(admin.id, await hashPassword(password));
    await repos.sessions.revokeAllForUser(admin.id);
    await repos.audit.record({
      tenantId: tenant.id,
      actorUserId: null,
      action: "user.password.setup_reissued",
      entityType: "user",
      entityId: admin.id,
      before: { username: admin.username },
      after: {
        username: admin.username,
        mustChangeCredentials: true,
        temporary: true,
        via: "setup_token",
      },
    });
    return { username: admin.username, password };
  });
}
