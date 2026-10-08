/** @type {import('next').NextConfig} */
// 后端（ops-center/server）独立运行，前端同源代理过去（Cookie、下载链接原样透传）
const OPS_API_URL = (process.env.OPS_API_URL || "http://127.0.0.1:3400").replace(/\/+$/, "");

const nextConfig = {
  output: "standalone",
  reactCompiler: true,
  compress: false,
  compiler: {
    removeConsole: process.env.NODE_ENV === "production",
  },
  experimental: {
    // Next 16 默认把开发编译结果持久化到 .next/dev/cache；在本机上每次写盘要 70 秒以上并拖垮整机，关掉
    turbopackFileSystemCacheForDev: false,
    // 构建时最多 2 个 worker，避免吃满内存
    cpus: 2,
    // rewrites 代理默认 30 秒超时，大账单导出会被中途掐断（下载卡在 99%）
    proxyTimeout: 600_000,
    optimizePackageImports: ["lucide-react", "date-fns", "radix-ui", "recharts"],
  },
  async redirects() {
    return [
      {
        source: "/dashboard",
        destination: "/dashboard/monitor",
        permanent: false,
      },
      // 菜单合并后的旧地址
      { source: "/dashboard/traffic", destination: "/dashboard/monitor", permanent: false },
      { source: "/dashboard/accounts", destination: "/dashboard/channels?tab=accounts", permanent: false },
      { source: "/dashboard/groups", destination: "/dashboard/channels?tab=sched", permanent: false },
      { source: "/dashboard/sched", destination: "/dashboard/channels?tab=sched", permanent: false },
      { source: "/dashboard/suppliers/monitor", destination: "/dashboard/suppliers?tab=monitor", permanent: false },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/ops/api/:path*",
        destination: `${OPS_API_URL}/api/:path*`,
      },
    ];
  },
}

export default nextConfig
