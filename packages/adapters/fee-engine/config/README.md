# @tpirs/fee-engine-config

Config-backed adapter for the `FeeEngine` port.

Reads the tenant's fee rules from `obligations.feeRules` and resolves them with
the canonical `selectFeeRule` implementation in `@tpirs/domain`. Pricing a new
asset type or changing a levy amount is a tenant configuration change, not a
code change.

The tenant loader is injected, so this adapter holds no database or
tenant-resolution logic:

```ts
const feeEngine = createConfigFeeEngine({ loadConfig: makeTenantConfigLoader(db) });
```

Passes the shared conformance suite in `@tpirs/contracts`.
