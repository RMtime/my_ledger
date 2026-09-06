import { LoginForm } from "@/components/login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const reason = (await searchParams).error;
  const initialError = reason === "invalid_invite" ? "邀请链接无效或已经过期" : reason === "not_allowed" ? "受邀邮箱不在服务器允许名单中" : "";
  return <LoginForm initialError={initialError} />;
}
