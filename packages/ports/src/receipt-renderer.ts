import type { TenantId } from "@tpirs/domain";

export interface ReceiptRequest {
  readonly tenantId: TenantId;
  readonly templateKey: string;
  readonly language: string;
  readonly variables: Readonly<Record<string, string | number>>;
}

export interface ReceiptRenderer {
  /** Throws PortError("not_found") for unknown template keys. */
  renderSmsText(request: ReceiptRequest): Promise<string>;
  renderPdf(request: ReceiptRequest): Promise<Uint8Array>;
}
