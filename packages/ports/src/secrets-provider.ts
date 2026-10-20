export interface SecretsProvider {
  /** Resolve a secret reference (never a literal secret in code). Throws PortError("not_found"). */
  getSecret(ref: string): Promise<string>;
}
