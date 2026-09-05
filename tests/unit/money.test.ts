import { describe,expect,it } from "vitest";
import { convertHalfUp,formatMinor,parseMajorAmount } from "@/modules/ledger/money";
describe("money",()=>{it("parses decimal money without floating point",()=>{expect(parseMajorAmount("100.10","HKD")).toBe("10010");expect(parseMajorAmount("0.20","HKD")).toBe("20");expect(10010n+20n).toBe(10030n)});it("rejects unsupported precision",()=>expect(()=>parseMajorAmount("1.001","HKD")).toThrow("最多 2 位"));it("uses half-up conversion",()=>{expect(convertHalfUp(101n,"1.005")).toBe(102n);expect(formatMinor(10030n,"HKD")).toBe("HKD 100.30")})});
