"use client";

import { FormEvent, useState } from "react";

export function LoginForm({ initialError = "" }: { initialError?: string }) {
  const [error, setError] = useState(initialError); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget); const response = await fetch("/api/v1/auth/login", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ email:form.get("email"), password:form.get("password") }) }); const data = await response.json(); if (response.ok) window.location.replace("/"); else { setError(data.error?.message ?? "登录失败"); setBusy(false); } }
  return <main className="login"><form className="card login-card" onSubmit={submit}><div className="brand"><span className="brand-mark">寸</span>寸金</div><p className="eyebrow" style={{marginTop:34}}>PRIVATE LEDGER</p><h1 className="entry-title">欢迎回来</h1><p className="muted-copy">只有白名单中的账户可以进入这本账。</p><label className="field">邮箱<input className="control" type="email" name="email" autoComplete="email" required /></label><label className="field field-space">密码<input className="control" type="password" name="password" autoComplete="current-password" required /></label>{error&&<div className="notice error">{error}</div>}<button className="btn primary full-button" disabled={busy}>{busy?"正在登录…":"登录"}</button></form></main>;
}
