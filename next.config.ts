import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // vinext (the Next.js-compatible framework this app runs on) treats ANY POST request whose
  // Content-Type is multipart/form-data as a possible progressive Server Action submission --
  // a heuristic for <form action={serverAction}> without JS, not something this app actually
  // uses -- and caps it at this same experimental.serverActions.bodySizeLimit regardless of
  // whether the target route is a real Server Action or (like app/api/attachments/route.ts) a
  // plain Route Handler. Confirmed live: the framework's own 1MB default, not our app code's
  // 20MB check or Cloudflare's 100MB account limit, was the actual thing silently rejecting
  // every document/attachment upload over ~1MB with a bare 413. Raised here to comfortably
  // clear app/api/attachments/route.ts's own 20MB MAX_SIZE (and MastersPanel.tsx's matching
  // DOCUMENT_MAX_SIZE_BYTES) with headroom for multipart overhead.
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/:path((?!api/).*\\.(?:ico|png|jpg|jpeg|gif|svg|webp|woff|woff2|ttf|otf|eot|mp4|webm|pdf|txt|xml|json|webmanifest|js))",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
        ],
      },
    ];
  },
};

export default nextConfig;
