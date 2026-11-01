import {
  TenantConfigValidationError,
  defaultTenantConfig,
  validateTenantConfig,
} from "@tpirs/config";
import type { TenantConfig, TenantConfigDefaultsInput } from "@tpirs/config";
import {
  TenantAlreadyProvisionedError,
  provisionTenantRows,
  repositories,
  withSystem,
  withTenant,
} from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { hashPassword } from "@tpirs/crypto";

/**
 * First-run onboarding: the only supported way a deployment acquires its first
 * tenant.
 *
 * Two calls, deliberately separate:
 *
 * 1. `startOnboarding` takes the answers a levy office can give on day one,
 *    builds a complete configuration from them, and provisions the tenant. It
 *    creates the first account as a **temporary** one — the username and
 *    password below — with `must_change_credentials` set, so the account can
 *    reach nothing but step 2 for as long as it exists.
 * 2. `completeOnboarding` replaces that account's username and password with the
 *    operator's own, clears the flag, and records the change.
 *
 * There is no email provider, so nothing is mailed: the person finishing setup is
 * the same person who started it, and the temporary credentials never have to
 * leave the machine. The email captured at step 1 is an account identifier for
 * the password-reset flow that will arrive with a sender.
 *
 * Both calls are only meaningful while the deployment has no tenant; the routes
 * in `apps/api/src/routes/setup.ts` close them once one exists.
 */

/**
 * The provisioning account. It is deliberately a name a person would never keep:
 * `completeOnboarding` refuses it, so the account cannot survive onboarding.
 */
export const TEMPORARY_ADMIN_USERNAME = "admin";

/** The temp password, refused at step 2 for the same reason. */
export const TEMPORARY_ADMIN_PASSWORD = "password";

/** Minimum length for a real password (D-recorded: length only, no complexity rules). */
export const MIN_PASSWORD_LENGTH = 6;

/** Usernames staff sign in with. Lowercase, no spaces, easy to say over a phone. */
const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OnboardingIssue {
  readonly path: string;
  readonly message: string;
}

/** Every problem with a submitted answer set, so a form can show them all at once. */
export class OnboardingValidationError extends Error {
  readonly issues: readonly OnboardingIssue[];

  constructor(issues: readonly OnboardingIssue[]) {
    super(`Onboarding input has ${String(issues.length)} issue(s)`);
    this.name = "OnboardingValidationError";
    this.issues = issues;
  }
}

export interface StartOnboardingInput {
  /** State details, money and channel settings — the wizard's answers. */
  readonly config: TenantConfigDefaultsInput;
  /** The address the new administrator can be reached at. Required. */
  readonly adminEmail: string;
  /** Optional zones. A tenant with none is valid. */
  readonly zones?: readonly string[];
  /** Only the seed uses this: it owns demo tenants and re-runs on every setup. */
  readonly updateExisting?: boolean;
}

export interface StartOnboardingResult {
  readonly tenantId: string;
  readonly adminUserId: string;
  readonly temporaryUsername: string;
  readonly created: boolean;
}

export interface CompleteOnboardingInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly username: string;
  readonly password: string;
}

export interface CompleteOnboardingResult {
  readonly userId: string;
  readonly username: string;
}

/**
 * Credential rules for the account that replaces the temporary one. They are
 * checked here rather than in the form, so a crafted request cannot skip them.
 */
export function credentialIssues(input: {
  readonly username: string;
  readonly password: string;
}): readonly OnboardingIssue[] {
  const issues: OnboardingIssue[] = [];
  const username = input.username.trim();
  const password = input.password;

  if (username.toLowerCase() === TEMPORARY_ADMIN_USERNAME) {
    issues.push({
      path: "username",
      message: `"${TEMPORARY_ADMIN_USERNAME}" is the provisioning account; choose your own username`,
    });
  } else if (!USERNAME_PATTERN.test(username)) {
    issues.push({
      path: "username",
      message: "Use 3-40 characters: lowercase letters, digits, dot, underscore or hyphen",
    });
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push({
      path: "password",
      message: `Use at least ${String(MIN_PASSWORD_LENGTH)} characters`,
    });
  } else if (password.toLowerCase() === TEMPORARY_ADMIN_PASSWORD) {
    issues.push({
      path: "password",
      message: `"${TEMPORARY_ADMIN_PASSWORD}" is the temporary password; choose your own`,
    });
  } else if (username !== "" && password.toLowerCase() === username.toLowerCase()) {
    issues.push({ path: "password", message: "The password must not be the username" });
  }

  return issues;
}

/** True while the deployment has no tenant, and therefore needs onboarding. */
export async function isSetupRequired(db: AnyDb): Promise<boolean> {
  const tenants = await withSystem(db, (tx) => repositories(tx).tenants.list());
  return tenants.length === 0;
}

function adminEmailIssues(email: string): readonly OnboardingIssue[] {
  if (EMAIL_PATTERN.test(email.trim())) return [];
  return [{ path: "adminEmail", message: "Enter a valid email" }];
}

/** Turns wizard answers into a validated config, reporting every problem at once. */
export function buildTenantConfig(answers: TenantConfigDefaultsInput): TenantConfig {
  try {
    return defaultTenantConfig(answers);
  } catch (error) {
    if (error instanceof TenantConfigValidationError) {
      throw new OnboardingValidationError(
        error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      );
    }
    throw error;
  }
}

/**
 * Every problem with a submission, in one list.
 *
 * The email is checked in the same pass as the configuration: a form that says
 * "fix this" three times, once per round trip, is a form people abandon. This is
 * also why `buildTenantConfig` is not simply called first — its throw would end
 * the pass before the email was looked at.
 */
function submissionIssues(input: StartOnboardingInput): readonly OnboardingIssue[] {
  const issues: OnboardingIssue[] = [];
  try {
    buildTenantConfig(input.config);
  } catch (error) {
    if (!(error instanceof OnboardingValidationError)) throw error;
    issues.push(...error.issues);
  }
  issues.push(...adminEmailIssues(input.adminEmail));
  return issues;
}

export async function startOnboarding(
  db: AnyDb,
  input: StartOnboardingInput,
): Promise<StartOnboardingResult> {
  const issues = submissionIssues(input);
  if (issues.length > 0) throw new OnboardingValidationError(issues);

  const email = input.adminEmail.trim();
  const config = buildTenantConfig(input.config);
  // The factory already validates; this is the guard for anyone who later builds
  // a config by hand and passes it down this path.
  validateTenantConfig(config);

  const provisioned = await provisionTenantRows(db, {
    config,
    zones: input.zones ?? [],
    ...(input.updateExisting === undefined ? {} : { updateExisting: input.updateExisting }),
    admin: {
      username: TEMPORARY_ADMIN_USERNAME,
      displayName: "Administrator",
      email,
      password: TEMPORARY_ADMIN_PASSWORD,
      roleKeys: ["system_admin"],
      mustChangeCredentials: true,
    },
  });

  await withTenant(db, provisioned.tenantId, async (tx) => {
    await repositories(tx).audit.record({
      tenantId: provisioned.tenantId,
      actorUserId: provisioned.adminUserId,
      action: "tenant.provision",
      entityType: "tenant",
      entityId: provisioned.tenantId,
      // Never the password or its hash: an audit row is readable by auditors and
      // is append-only, so a secret written here could never be removed.
      after: {
        slug: config.identity.slug,
        name: config.identity.name,
        currency: config.locale.currency,
        timezone: config.locale.timezone,
        languages: config.locale.enabledLanguages,
        adminEmail: email,
      },
    });
  });

  return {
    tenantId: provisioned.tenantId,
    adminUserId: provisioned.adminUserId,
    temporaryUsername: TEMPORARY_ADMIN_USERNAME,
    created: provisioned.created,
  };
}

export async function completeOnboarding(
  db: AnyDb,
  input: CompleteOnboardingInput,
): Promise<CompleteOnboardingResult> {
  const username = input.username.trim();
  const issues = credentialIssues({ username, password: input.password });
  if (issues.length > 0) throw new OnboardingValidationError(issues);

  return withTenant(db, input.tenantId, async (tx) => {
    const repos = repositories(tx);
    const before = await repos.users.findById(input.userId);
    if (before === undefined) {
      throw new OnboardingValidationError([
        { path: "username", message: "The account could not be updated" },
      ]);
    }
    const updated = await repos.users.updateCredentials({
      userId: input.userId,
      username,
      passwordHash: await hashPassword(input.password),
    });
    if (updated === undefined) {
      throw new OnboardingValidationError([
        { path: "username", message: "The account could not be updated" },
      ]);
    }
    await repos.audit.record({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: "auth.credentials_changed",
      entityType: "user",
      entityId: input.userId,
      before: { username: before.username, mustChangeCredentials: before.mustChangeCredentials },
      after: { username: updated.username, mustChangeCredentials: false },
    });
    return { userId: updated.id, username: updated.username };
  });
}

export { TenantAlreadyProvisionedError };
