import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Địa chỉ API nội bộ (server-side). Trình duyệt luôn gọi cùng origin, Next rewrite sang đây.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  output: "standalone",
  // File dịch được đọc bằng fs lúc chạy, cần khai báo để bản standalone mang theo.
  outputFileTracingIncludes: {
    "/**": ["./messages/**/*.json"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` },
      { source: "/agent/:path*", destination: `${apiInternalUrl}/agent/:path*` },
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
