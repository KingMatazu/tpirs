import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { createChannelProviderFactory } from "@tpirs/channel-providers";
import type { ChannelProviderFactory } from "@tpirs/channel-providers";
import { createQrTokenSigner } from "@tpirs/crypto";
import type { AnyDb } from "@tpirs/db";
import type {
  AnomalyService,
  AssetService,
  CollectorCashService,
  DisputeService,
  ExceptionService,
  InboundSmsService,
  OtpService,
  OwnerService,
  PaidSetSyncService,
  PaymentService,
  RateLimiter,
  ReconciliationService,
  ReportService,
  ScanService,
  UssdService,
  VerificationService,
} from "@tpirs/application";
import type { QrTokenSigner } from "@tpirs/domain";
import {
  createAssetService,
  createCollectorCashService,
  createDisputeService,
  createDriverChannelService,
  createInboundSmsService,
  createOtpService,
  createOwnerService,
  createPaidSetSyncService,
  createPaymentService,
  createRateLimiter,
  createScanService,
  createSettlementImportService,
  createSmsCostGuard,
  createUssdService,
  createVerificationService,
  AnomalyService as AnomalyServiceImpl,
  ExceptionService as ExceptionServiceImpl,
  ReconciliationService as ReconciliationServiceImpl,
  ReportService as ReportServiceImpl,
} from "@tpirs/application";
import { createConfigAssetSchemaRegistry } from "@tpirs/asset-schema-registry-config";
import { createConfigFeeEngine } from "@tpirs/fee-engine-config";
import type {
  Cache,
  Clock,
  ExportFormat,
  ExportService,
  LockService,
  ObjectStorage,
  PaymentProvider,
  SecretsProvider,
  SettlementImport,
  SmsProvider,
  Telemetry,
} from "@tpirs/ports";
import { readTenantConfig } from "./tenants.js";

/**
 * Loads and validates a tenant's stored configuration document. Returns
 * undefined when the tenant is unknown; throws when config is present but
 * invalid, so a broken config fails loudly rather than silently.
 */
export function makeTenantConfigLoader(
  db: AnyDb,
): (tenantId: string) => Promise<TenantConfig | undefined> {
  return async (tenantId) => {
    const stored = await readTenantConfig(db, tenantId);
    if (stored === undefined) return undefined;
    return validateTenantConfig(stored.config);
  };
}

export interface ServiceDeps {
  readonly db: AnyDb;
  readonly objectStorage: ObjectStorage;
  readonly secrets: SecretsProvider;
  readonly sms: SmsProvider;
  readonly cache: Cache;
  readonly clock: Clock;
  readonly locks: LockService;
  /** Secret reference holding the per-deployment QR signing key. */
  readonly qrKeyRef: string;
  /**
   * Payment adapters by provider name. The composition root decides which real
   * gateways exist; core code never learns a gateway's name.
   */
  readonly paymentProviders?: Readonly<Record<string, PaymentProvider>>;
  /**
   * Resolves tenant config to channel adapters. Defaults to the standard
   * factory over `secrets`; tests inject their own transport to avoid the
   * network entirely.
   */
  readonly channelProviders?: ChannelProviderFactory;
  readonly telemetry?: Telemetry;
  /**
   * The statement reader the deployment supplies (e.g. the CSV adapter). The
   * tenant's config decides the provider, columns and tolerance; a tenant with
   * no statement mapping never reaches it.
   */
  readonly settlementReader?: SettlementImport;
  /** Report renderers by format. A missing format is refused by the report service. */
  readonly exporters?: Partial<Record<ExportFormat, ExportService>>;
}

export interface Services {
  readonly asset: AssetService;
  readonly owner: OwnerService;
  readonly otp: OtpService;
  readonly payment: PaymentService;
  readonly verification: VerificationService;
  readonly scan: ScanService;
  readonly dispute: DisputeService;
  /** Verifies presented QR tokens; also used by the public verify route. */
  readonly qrSigner: QrTokenSigner;
  /** USSD callbacks, from parse to rendered provider response. */
  readonly ussd: UssdService;
  /** Inbound SMS commands and their queued replies. */
  readonly inboundSms: InboundSmsService;
  /** Shared abuse control for unauthenticated endpoints. */
  readonly rateLimiter: RateLimiter;
  /** Tenant config to live channel adapters; used by the webhook routes. */
  readonly channelProviders: ChannelProviderFactory;
  /** Paid-set snapshot/delta feed for the offline field app. */
  readonly paidSetSync: PaidSetSyncService;
  /** Collector cash: intake, wallets, deposits and their matching. */
  readonly collectorCash: CollectorCashService;
  /** Reconciliation runs, their checklist and sign-off. */
  readonly reconciliation: ReconciliationService;
  /** Working the exception queue. */
  readonly exceptions: ExceptionService;
  /** Persisted anomaly events. */
  readonly anomalies: AnomalyService;
  /** Finance reports and their exports. */
  readonly reports: ReportService;
  /**
   * Statement intake, present only when the deployment supplies a reader.
   * The tenant's config decides the provider, columns and tolerance.
   */
  readonly settlementImport?: ReturnType<typeof createSettlementImportService>;
}

/**
 * Application services shared by routes. The QR signing key is read from the
 * SecretsProvider by reference; no secret is ever read from the environment in
 * core code.
 */
export async function buildServices(deps: ServiceDeps): Promise<Services> {
  const loadConfig = makeTenantConfigLoader(deps.db);
  const qrKey = await deps.secrets.getSecret(deps.qrKeyRef);
  const qrSigner = createQrTokenSigner(qrKey);

  const asset = createAssetService({
    db: deps.db,
    registry: createConfigAssetSchemaRegistry({ loadConfig }),
    qrSigner,
    objectStorage: deps.objectStorage,
    loadConfig,
  });
  const owner = createOwnerService({ db: deps.db });
  const otp = createOtpService({ cache: deps.cache, sms: deps.sms, clock: deps.clock });

  const paymentProviders = deps.paymentProviders ?? {};
  const feeEngine = createConfigFeeEngine({ loadConfig });
  const payment = createPaymentService({
    db: deps.db,
    loadConfig,
    feeEngine,
    providerFor: (name) => paymentProviders[name],
    now: () => deps.clock.now(),
  });

  const collectorCash = createCollectorCashService({
    db: deps.db,
    loadConfig,
    feeEngine,
    providerFor: (name) => paymentProviders[name],
    now: () => deps.clock.now(),
  });

  const rateLimiter = createRateLimiter({ cache: deps.cache, clock: deps.clock });
  const channelProviders =
    deps.channelProviders ?? createChannelProviderFactory({ secrets: deps.secrets });
  const driver = createDriverChannelService({
    db: deps.db,
    loadConfig,
    feeEngine,
    providerFor: (name) => paymentProviders[name],
    now: () => deps.clock.now(),
  });
  const telemetryProps = deps.telemetry === undefined ? {} : { telemetry: deps.telemetry };
  const ussd = createUssdService({
    cache: deps.cache,
    locks: deps.locks,
    driver,
    rateLimiter,
    ...telemetryProps,
  });
  const inboundSms = createInboundSmsService({
    db: deps.db,
    driver,
    rateLimiter,
    costGuard: createSmsCostGuard({
      db: deps.db,
      clock: deps.clock,
      ...telemetryProps,
    }),
    ...telemetryProps,
  });
  const paidSetSync = createPaidSetSyncService({
    db: deps.db,
    loadConfig,
    now: () => deps.clock.now(),
  });
  const verification = createVerificationService({
    db: deps.db,
    loadConfig,
    now: () => deps.clock.now(),
  });
  const scan = createScanService({ db: deps.db, loadConfig, now: () => deps.clock.now() });
  const dispute = createDisputeService({
    db: deps.db,
    loadConfig,
    objectStorage: deps.objectStorage,
    now: () => deps.clock.now(),
  });

  const reconciliation = new ReconciliationServiceImpl({ db: deps.db });
  const exceptions = new ExceptionServiceImpl({ db: deps.db });
  const anomalies = new AnomalyServiceImpl({
    db: deps.db,
    ...(deps.telemetry === undefined ? {} : { telemetry: deps.telemetry }),
  });
  const reports = new ReportServiceImpl({ db: deps.db, exporters: deps.exporters ?? {} });
  const settlementImport =
    deps.settlementReader === undefined
      ? undefined
      : createSettlementImportService({ db: deps.db, settlementImport: deps.settlementReader });

  return {
    asset,
    owner,
    otp,
    payment,
    verification,
    scan,
    dispute,
    qrSigner,
    ussd,
    inboundSms,
    rateLimiter,
    channelProviders,
    paidSetSync,
    collectorCash,
    reconciliation,
    exceptions,
    anomalies,
    reports,
    ...(settlementImport === undefined ? {} : { settlementImport }),
  };
}
