"use client";

import { persist } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

export type Tab = {
  url: string;
  title: string;
  pinned?: boolean;
};

export type TabsState = {
  tabs: Tab[];
  activeUrl: string;
  addTab: (tab: Tab) => void;
  removeTab: (url: string) => void;
  setActiveTab: (url: string) => void;
  reorderTabs: (tabs: Tab[]) => void;
  renameTab: (url: string, title: string) => void;
};

const DEFAULT_TAB: Tab = {
  url: "/dashboard/monitor",
  title: "监控大盘",
  pinned: true,
};

export const createTabsStore = () =>
  createStore<TabsState>()(
    persist(
      (set, get) => ({
        tabs: [DEFAULT_TAB],
        activeUrl: DEFAULT_TAB.url,

        addTab: (tab) => {
          const { tabs } = get();
          const exists = tabs.find((t) => t.url === tab.url);
          if (exists) {
            set({ activeUrl: tab.url });
            return;
          }
          set({ tabs: [...tabs, tab], activeUrl: tab.url });
        },

        removeTab: (url) => {
          const { tabs, activeUrl } = get();
          if (tabs.length <= 1) return;
          const tab = tabs.find((t) => t.url === url);
          if (tab?.pinned) return;

          const newTabs = tabs.filter((t) => t.url !== url);
          if (activeUrl === url) {
            const closedIndex = tabs.findIndex((t) => t.url === url);
            const newActive = newTabs[Math.min(closedIndex, newTabs.length - 1)];
            if (newActive) set({ tabs: newTabs, activeUrl: newActive.url });
          } else {
            set({ tabs: newTabs });
          }
        },

        setActiveTab: (url) => {
          set({ activeUrl: url });
        },

        reorderTabs: (tabs) => {
          set({ tabs });
        },

        renameTab: (url, title) => {
          const { tabs } = get();
          if (!tabs.some((t) => t.url === url && t.title !== title)) return;
          set({ tabs: tabs.map((t) => (t.url === url ? { ...t, title } : t)) });
        },
      }),
      {
        name: "ops-tabs",
        partialize: (state) => ({
          tabs: state.tabs,
          activeUrl: state.activeUrl,
        }),
      },
    ),
  );
