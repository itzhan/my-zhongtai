"use client";

import { BillingView } from "@/modules/ops/views/billing-view";

// 跨客户出账单（入口在「客户」页右上角；单个客户的账单在客户详情的「账单」tab）
export default function BillingPage() {
  return <BillingView />;
}
