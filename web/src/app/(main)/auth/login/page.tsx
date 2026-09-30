import { AuthShell } from "../_components/auth-shell";
import { LoginForm } from "../_components/login-form";

export default function LoginPage() {
  return (
    <AuthShell title="登录" subtitle="juhecode.cn · sub2api 运维中台">
      <LoginForm />
    </AuthShell>
  );
}
