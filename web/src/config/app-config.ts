import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "运维中台",
  version: packageJson.version,
  copyright: `© ${currentYear}, 运维中台.`,
  url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  locale: "zh-CN",
  meta: {
    title: "运维中台",
    description: "sub2api 客户、分组、账号、智能调度、账单与供应商管理。",
    keywords: ["运维中台", "sub2api", "监控"],
  },
};
