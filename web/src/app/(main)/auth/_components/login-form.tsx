"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { get, post } from "@/modules/ops/api";

// 管理密码 + 可选 Google Authenticator TOTP 2FA 登录
export function LoginForm() {
  const [pw, setPw] = useState("");
  const [totp, setTotp] = useState("");
  const [totpRequired, setTotpRequired] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    get<{ totp_required: boolean }>("/login/config")
      .then((d) => {
        if (active) setTotpRequired(Boolean(d.totp_required));
      })
      .catch(() => {
        // 默认保留验证码输入框，避免配置加载失败时误隐藏 2FA
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw) return setError("请输入管理密码");
    if (totpRequired && !/^\d{6}$/.test(totp)) return setError("请输入 6 位动态验证码");
    setBusy(true);
    setError(null);
    try {
      await post("/login", totpRequired ? { password: pw, totp } : { password: pw });
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard/monitor";
    } catch (ex) {
      setError((ex as Error).message);
      if (totpRequired) setTotp("");
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
      {totpRequired ? (
        <div className="space-y-2">
          <Label htmlFor="totp">Google Authenticator 验证码</Label>
          <Input
            id="totp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 位数字验证码"
            maxLength={6}
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
        </div>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      <Button className="w-full" type="submit" disabled={busy}>
        登录
      </Button>
    </form>
  );
}
