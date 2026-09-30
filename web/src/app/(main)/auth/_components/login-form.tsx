"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { post } from "@/modules/ops/api";

// 单密码登录（APP_PASSWORD，同旧版客户中台）
export function LoginForm() {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw) return setError("请输入管理密码");
    setBusy(true);
    setError(null);
    try {
      await post("/login", { password: pw });
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard/monitor";
    } catch (ex) {
      setError((ex as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="pw">管理密码</Label>
        <Input
          id="pw"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <Button className="w-full" type="submit" disabled={busy}>
        登录
      </Button>
    </form>
  );
}
