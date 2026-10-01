import { Activity, Gauge, Users, Layers, Server, Workflow, Receipt, Truck, Radar, type LucideIcon } from "lucide-react";

export interface NavSubItem {
  title: string;
  url: string;
  icon?: LucideIcon;
  comingSoon?: boolean;
  newTab?: boolean;
  isNew?: boolean;
}

export interface NavMainItem {
  title: string;
  url: string;
  icon?: LucideIcon;
  subItems?: NavSubItem[];
  comingSoon?: boolean;
  newTab?: boolean;
  isNew?: boolean;
}

export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}

export const sidebarItems: NavGroup[] = [
  {
    id: 1,
    label: "监控",
    items: [
      { title: "监控大盘", url: "/dashboard/monitor", icon: Activity },
      { title: "流量监控", url: "/dashboard/traffic", icon: Gauge },
    ],
  },
  {
    id: 2,
    label: "客户与渠道",
    items: [
      { title: "客户", url: "/dashboard/customers", icon: Users },
      { title: "分组", url: "/dashboard/groups", icon: Layers },
      { title: "账号", url: "/dashboard/accounts", icon: Server },
      { title: "智能调度", url: "/dashboard/sched", icon: Workflow },
      { title: "账单", url: "/dashboard/billing", icon: Receipt },
    ],
  },
  {
    id: 3,
    label: "供应商",
    items: [
      { title: "供应商管理", url: "/dashboard/suppliers", icon: Truck },
      { title: "接口监测", url: "/dashboard/suppliers/monitor", icon: Radar },
    ],
  },
];
