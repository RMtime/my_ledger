"use client";

import { FormEvent, useState } from "react";

export default function OnboardingPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget); const password = String(form.get("password") ?? ""); const confirmation = String(form.get("confirmation") ?? "");
    if (password !== confirmation) { setError("两次输入的密码不一致"); setBusy(false); return; }
    const response = await fetch("/api/v1/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    const data = await response.json();
    if (response.ok) window.location.replace("/"); else { setError(data.error?.message ?? "初始化失败"); setBusy(false); }
  }
  return <main className="login"><form className="card login-card" onSubmit={submit}><div className="brand"><span className="brand-mark">寸</span>寸金</div><p className="eyebrow" style={{ marginTop: 34 }}>INVITED USER</p><h1 className="entry-title">设置登录密码</h1><p className="muted-copy">这是你的独立账户。密码不会与另一位用户共享。</p><label className="field">新密码<input className="control" type="password" name="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label><label className="field field-space">再次输入<input className="control" type="password" name="confirmation" autoComplete="new-password" minLength={12} maxLength={128} required /></label>{error && <div className="notice error">{error}</div>}<button className="btn primary full-button" disabled={busy}>{busy ? "正在设置…" : "完成初始化"}</button></form></main>;
}
