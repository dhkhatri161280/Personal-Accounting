// Shared by app/api/attachments/route.ts (server-side enforcement), MastersPanel.tsx's manual
// Documents upload, and TaxReport.tsx's paystub-PDF auto-archive -- one number instead of three
// copies that could quietly drift apart. See next.config.ts's experimental.serverActions
// .bodySizeLimit comment for why this needs real headroom above 20MB (multipart overhead, plus
// the framework-level cap that used to silently reject anything over ~1MB regardless of this
// constant).
export const DOCUMENT_MAX_SIZE_BYTES = 20 * 1024 * 1024;
