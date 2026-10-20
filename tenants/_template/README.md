# Tenant template

Starter files for a new state. Copy this directory to `tenants/<state-slug>` and
fill in the config. No code lives here — tenants are configuration only.

```
tenants/
  _template/
    tenant.config.yaml   # validated at startup by packages/config (Phase 1)
    plugins/             # optional, versioned plugin hooks (core works with none)
```

The config schema, loader, and validation arrive in Phase 1. This placeholder
records the intended shape so onboarding stays config-only.
