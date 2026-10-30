import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AnomalyEventRow, ReconciliationExceptionRow, ReconciliationRunRow } from "@tpirs/db";
import type { TenantConfig } from "@tpirs/config";
import { ExceptionError, ReconciliationRunError, ReportError } from "@tpirs/application";
import type { SettlementColumnMapping } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";
import { requirePermission } from "../auth.js";
import { errorEnvelope } from "../errors.js";
import type { Services } from "../services.js";
import {
  acknowledgeAnomalySchema,
  exportReportSchema,
  getReconciliationRunSchema,
  getReportSchema,
  importSettlementSchema,
  listAnomaliesSchema,
  listReconciliationExceptionsSchema,
  listReconciliationRunsSchema,
  resolveReconciliationExceptionSchema,
  signOffReconciliationRunSchema,
} from "../schemas.js";

/**
 * Phase 8 routes: reconciliation runs and sign-off, the exception queue,
 * settlement import, reports and their exports, and anomaly events.
 *
 * Every route is permission-guarded and tenant-scoped by the principal; money
 * crosses the wire as minor-unit strings, and the checklist is whatever the run
 * persisted (already JSON-safe). Business refusals are mapped here, so the
 * dashboard can act on `run_already_signed_off` instead of a generic 500.
 */

const RUN_ERROR_STATUS: Readonly<Record<ReconciliationRunError["code"], number>> = {
  run_not_found: 404,
  run_not_completed: 409,
  run_already_signed_off: 409,
  blocking_exceptions: 409,
  note_required: 400,
};

const REPORT_ERROR_STATUS: Readonly<Record<ReportError["code"], number>> = {
  unknown_report: 404,
  invalid_range: 400,
  range_too_large: 400,
  result_too_large: 400,
  format_unavailable: 400,
};

function toRunJson(run: ReconciliationRunRow) {
  return {
    id: run.id,
    businessDate: run.businessDate,
    runSeq: run.runSeq,
    status: run.status,
    toleranceMinor: run.toleranceSnapshot.toString(),
    feeToleranceMinor: run.feeToleranceSnapshot.toString(),
    checklist: run.checklist,
    exceptionCount: run.exceptionCount,
    failureReason: run.failureReason,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt === null ? null : run.completedAt.toISOString(),
    signedOffByUserId: run.signedOffByUserId,
    signedOffAt: run.signedOffAt === null ? null : run.signedOffAt.toISOString(),
    signOffNote: run.signOffNote,
  };
}

function toExceptionJson(row: ReconciliationExceptionRow) {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    businessDate: row.businessDate,
    expectedMinor: row.expectedMinor === null ? null : row.expectedMinor.toString(),
    actualMinor: row.actualMinor === null ? null : row.actualMinor.toString(),
    differenceMinor: row.differenceMinor === null ? null : row.differenceMinor.toString(),
    currency: row.currency,
    detail: row.detail,
    resolutionNote: row.resolutionNote,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    firstSeenRunId: row.firstSeenRunId,
    lastSeenRunId: row.lastSeenRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAnomalyJson(row: AnomalyEventRow) {
  return {
    id: row.id,
    ruleKey: row.ruleKey,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    observed: row.observed,
    baseline: row.baseline,
    threshold: row.threshold,
    severity: row.severity,
    status: row.status,
    detail: row.detail,
    acknowledgedByUserId: row.acknowledgedByUserId,
    acknowledgedAt: row.acknowledgedAt === null ? null : row.acknowledgedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function sendRunError(request: FastifyRequest, reply: FastifyReply, error: ReconciliationRunError) {
  return reply
    .code(RUN_ERROR_STATUS[error.code])
    .send(errorEnvelope(error.code, error.message, request.id));
}

function sendReportError(request: FastifyRequest, reply: FastifyReply, error: ReportError) {
  return reply
    .code(REPORT_ERROR_STATUS[error.code])
    .send(errorEnvelope(error.code, error.message, request.id));
}

function sendExceptionError(request: FastifyRequest, reply: FastifyReply, error: ExceptionError) {
  return reply
    .code(error.code === "note_required" ? 400 : 404)
    .send(errorEnvelope(error.code, error.message, request.id));
}

/** Builds the adapter mapping from the tenant's statement config. */
function statementMapping(config: TenantConfig): SettlementColumnMapping | undefined {
  const statement = config.reconciliation.settlementImport;
  if (statement === undefined) return undefined;
  return {
    reference: statement.columns.reference,
    amount: statement.columns.amount,
    settledAt: statement.columns.settledAt,
    settledAtFormat: statement.dateFormat,
    amountInMinorUnits: statement.amountInMinorUnits,
    decimalSeparator: statement.decimalSeparator ?? ".",
    ...(statement.columns.fee === undefined ? {} : { fee: statement.columns.fee }),
    ...(statement.columns.currency === undefined ? {} : { currency: statement.columns.currency }),
    ...(statement.columns.description === undefined
      ? {}
      : { description: statement.columns.description }),
  };
}

export function registerReconciliationRoutes(
  app: FastifyInstance,
  context: {
    readonly services: Services;
    readonly loadConfig: (tenantId: string) => Promise<TenantConfig | undefined>;
  },
): void {
  const { services, loadConfig } = context;

  app.post<{ Body: { filename: string; content: string } }>(
    "/v1/settlements/import",
    // A settlement statement is a file in a JSON body; it gets its own ceiling
    // above the 1 MiB global limit (Phase 10, Step 7).
    { schema: importSettlementSchema, bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) => {
      const principal = requirePermission(request, "reconciliation:run");
      const config = await loadConfig(principal.tenantId);
      const statement = config?.reconciliation.settlementImport;
      if (config === undefined || statement === undefined) {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              "settlement_import_not_configured",
              "This tenant has no settlement statement mapping configured",
              request.id,
            ),
          );
      }
      if (services.settlementImport === undefined) {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              "settlement_import_unavailable",
              "No statement reader is available in this deployment",
              request.id,
            ),
          );
      }

      const mapping = statementMapping(config);
      if (mapping === undefined) {
        return reply
          .code(400)
          .send(
            errorEnvelope(
              "settlement_import_not_configured",
              "This tenant has no settlement statement mapping configured",
              request.id,
            ),
          );
      }

      try {
        const summary = await services.settlementImport.importStatement({
          tenantId: principal.tenantId,
          provider: statement.provider,
          filename: request.body.filename,
          content: request.body.content,
          mapping,
          defaultCurrency: statement.defaultCurrency ?? config.locale.currency,
          feeToleranceMinor: BigInt(config.reconciliation.feeToleranceMinor),
          actor: principal,
        });
        return await reply.send(summary);
      } catch (error) {
        if (error instanceof PortError) {
          return reply
            .code(error.code === "invalid_request" ? 400 : 502)
            .send(errorEnvelope(error.code, error.message, request.id));
        }
        throw error;
      }
    },
  );

  app.get<{
    Querystring: { from?: string; to?: string; status?: string; limit?: string };
  }>(
    "/v1/reconciliation/runs",
    { schema: listReconciliationRunsSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "reconciliation:read");
      const { from, to, status } = request.query;
      const runs = await services.reconciliation.list(principal.tenantId, {
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(status === undefined ? {} : { status: status as never }),
      });
      return reply.send({ runs: runs.map((run) => toRunJson(run)) });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/reconciliation/runs/:id",
    { schema: getReconciliationRunSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "reconciliation:read");
      const run = await services.reconciliation.findById(principal.tenantId, request.params.id);
      if (run === undefined) {
        return reply
          .code(404)
          .send(errorEnvelope("run_not_found", "Reconciliation run not found", request.id));
      }
      return reply.send({ run: toRunJson(run) });
    },
  );

  app.post<{ Params: { id: string }; Body: { note: string } }>(
    "/v1/reconciliation/runs/:id/sign-off",
    { schema: signOffReconciliationRunSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "reconciliation:run");
      try {
        const run = await services.reconciliation.signOff({
          tenantId: principal.tenantId,
          runId: request.params.id,
          actor: principal,
          note: request.body.note,
        });
        return await reply.send({ run: toRunJson(run) });
      } catch (error) {
        if (error instanceof ReconciliationRunError) {
          return sendRunError(request, reply, error);
        }
        throw error;
      }
    },
  );

  app.get<{
    Querystring: { status?: string; severity?: string; runId?: string; limit?: string };
  }>(
    "/v1/reconciliation/exceptions",
    { schema: listReconciliationExceptionsSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "reconciliation:read");
      const { status, severity, runId, limit } = request.query;
      const exceptions = await services.exceptions.list(principal.tenantId, {
        ...(status === undefined ? {} : { status: status as never }),
        ...(severity === undefined ? {} : { severity: severity as never }),
        ...(runId === undefined ? {} : { runId }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      });
      return reply.send({ exceptions: exceptions.map((row) => toExceptionJson(row)) });
    },
  );

  const transition = (path: string, action: "resolve" | "waive") =>
    app.post<{ Params: { id: string }; Body: { note: string } }>(
      path,
      { schema: resolveReconciliationExceptionSchema },
      async (request, reply) => {
        const principal = requirePermission(request, "reconciliation:run");
        try {
          const row = await services.exceptions[action]({
            tenantId: principal.tenantId,
            id: request.params.id,
            actor: principal,
            note: request.body.note,
          });
          return await reply.send({ exception: toExceptionJson(row) });
        } catch (error) {
          if (error instanceof ExceptionError) return sendExceptionError(request, reply, error);
          throw error;
        }
      },
    );

  transition("/v1/reconciliation/exceptions/:id/resolve", "resolve");
  transition("/v1/reconciliation/exceptions/:id/waive", "waive");

  app.get<{ Querystring: { status?: string; ruleKey?: string; limit?: string } }>(
    "/v1/anomalies",
    { schema: listAnomaliesSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "reconciliation:read");
      const { status, ruleKey, limit } = request.query;
      const anomalies = await services.reconciliation.anomalyEvents(principal.tenantId, {
        ...(status === undefined ? {} : { status: status as never }),
      });
      // The service lists newest-first; rule filtering and the limit are a view
      // concern the dashboard asks for directly.
      const filtered =
        ruleKey === undefined ? anomalies : anomalies.filter((row) => row.ruleKey === ruleKey);
      const capped = limit === undefined ? filtered : filtered.slice(0, Number(limit));
      return reply.send({ anomalies: capped.map((row) => toAnomalyJson(row)) });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/anomalies/:id/acknowledge",
    { schema: acknowledgeAnomalySchema },
    async (request, reply) => {
      const principal = requirePermission(request, "reconciliation:run");
      try {
        const anomaly = await services.reconciliation.acknowledgeAnomaly({
          tenantId: principal.tenantId,
          actor: principal,
          anomalyId: request.params.id,
        });
        return await reply.send({ anomaly: toAnomalyJson(anomaly) });
      } catch (error) {
        if (error instanceof ReconciliationRunError) {
          return sendRunError(request, reply, error);
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { key: string }; Querystring: { from: string; to: string } }>(
    "/v1/reports/:key",
    { schema: getReportSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "report:read");
      try {
        const report = await services.reports.run(
          {
            tenantId: principal.tenantId,
            actor: principal,
            from: request.query.from,
            to: request.query.to,
          },
          request.params.key as never,
        );
        return await reply.send({
          report: {
            reportKey: report.reportKey,
            from: report.from,
            to: report.to,
            generatedAt: report.generatedAt.toISOString(),
            columns: report.columns,
            rows: report.rows,
            totals: report.totals,
          },
        });
      } catch (error) {
        if (error instanceof ReportError) {
          return sendReportError(request, reply, error);
        }
        throw error;
      }
    },
  );

  app.get<{
    Params: { key: string };
    Querystring: { from: string; to: string; format: "csv" | "pdf" | "xlsx" };
  }>("/v1/reports/:key/export", { schema: exportReportSchema }, async (request, reply) => {
    const principal = requirePermission(request, "report:read");
    try {
      const result = await services.reports.exportReport({
        tenantId: principal.tenantId,
        actor: principal,
        from: request.query.from,
        to: request.query.to,
        reportKey: request.params.key as never,
        format: request.query.format,
        filenameBase: `${request.params.key}-${request.query.from}-${request.query.to}`,
      });
      return await reply
        .header("content-type", result.contentType)
        .header("content-disposition", `attachment; filename="${result.filename}"`)
        .send(Buffer.from(result.bytes));
    } catch (error) {
      if (error instanceof Error && error.name === "ReportError") {
        return sendReportError(request, reply, error as ReportError);
      }
      throw error;
    }
  });
}
