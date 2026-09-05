import { sqlite } from "@/db/client";
export const dynamic = "force-dynamic";
export async function GET() { try { const value=sqlite.prepare("SELECT 1 ok").get() as {ok:bigint}; return Response.json({status:value.ok===1n?"ok":"error",database:"reachable",schema_version:Number(sqlite.pragma("user_version",{simple:true}))},{headers:{"cache-control":"no-store"}}); } catch { return Response.json({status:"error",database:"unreachable"},{status:503,headers:{"cache-control":"no-store"}}); } }
