# @tpirs/application

Use-case services wiring pure domain logic to ports and repositories: asset registry (`register`, `attachPhoto`, `getPhoto`, `getSticker`, `search`, `setStatus`, `correctAttributes`, `verifyQrToken`), owner registry, and OTP phone verification. No HTTP types and no vendor SDKs; `apps/api` composes these services into routes.

Tenant-varying behaviour (QR/short-code formats, sticker spec, branding, OTP message text) is read from validated tenant config at call time. `verifyQrToken` resolves opaque payloads cross-tenant under the system scope — see ADR 0007. Sticker SVG rendering (`sticker.ts`, `qrcode` library) is isolated here so a future `ReceiptRenderer` adapter can reuse it — ADR 0009.
