import { Activity, Server, Settings, Truck, Users, type LucideIcon } from "lucide-react";

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
    items: [{ title: "监控大盘", url: "/dashboard/monitor", icon: Activity }],
  },
  {
    id: 2,
    label: "运营",
    items: [
      { title: "渠道配置", url: "/dashboard/channels", icon: Server },
      { title: "客户", url: "/dashboard/customers", icon: Users },
      { title: "供应商", url: "/dashboard/suppliers", icon: Truck },
    ],
  },
  {
    id: 3,
    label: "系统",
    items: [{ title: "设置", url: "/dashboard/settings", icon: Settings }],
  },
];
