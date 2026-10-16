import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { computeOverview } from "./lib/overview";

// Only the external relayer queue is stubbed. Production DB handlers and schema run unchanged.
vi.mock("./lib/relayer", () => ({ relayer: { enqueueAction: vi.fn(async () => "test-queue-id") } }));
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);
const NOW = Date.UTC(2026,9,16,6);
const DAY = 86400000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

async function fixture() {
 const t = convexTest(schema, modules);
 const a = t.withIdentity({subject:"alice",issuer:"https://test.local",tokenIdentifier:"https://test.local|alice"});
 const b = t.withIdentity({subject:"bob",issuer:"https://test.local",tokenIdentifier:"https://test.local|bob"});
 const alice = await a.mutation(api.users.ensure,{});
 const bob = await b.mutation(api.users.ensure,{});
 const ids = await t.run(async ctx => {
  const account = await ctx.db.insert("accounts",{userId:alice!,kind:"bank",name:"A",institution:"Test",currency:"USD",balanceMinor:100000,syncedAt:NOW,source:"manual",can:["read"],status:"ok"});
  const second = await ctx.db.insert("accounts",{userId:alice!,kind:"payment_app",name:"B",institution:"Test",currency:"USD",balanceMinor:100000,syncedAt:NOW,source:"manual",can:["read"],status:"ok"});
  const agentBase = {userId:alice!,status:"active" as const,scopes:["read","prepare","spend","request"] as const,dailyCapMinor:1500,perPaymentMinor:1000,spentTodayMinor:0,hidesBalances:false,connectedAt:NOW,expiresAt:NOW+DAY};
  const agent = await ctx.db.insert("agents",{...agentBase,scopes:[...agentBase.scopes],name:"A",provider:"claude"});
  const agent2 = await ctx.db.insert("agents",{...agentBase,scopes:[...agentBase.scopes],name:"B",provider:"chatgpt"});
  const payee = await ctx.db.insert("payees",{userId:alice!,name:"Shop",handle:"shop",kind:"merchant",trusted:true});
  const bobPayee = await ctx.db.insert("payees",{userId:bob!,name:"Private",handle:"private",kind:"merchant",trusted:true});
  const wallet = await ctx.db.insert("wallets",{userId:alice!,balanceMinor:10000,protectedMinor:5000,dailyCeilingMinor:2000,perPaymentMinor:1000,frozen:false,chain:"base-sepolia",address:"",asset:"USDC"});
  await ctx.db.patch(alice!,{currency:"USD",emergencyMinor:0,nextIncomeAt:NOW+30*DAY});
  return {account,second,agent,agent2,payee,bobPayee,wallet};
 });
 return {t,a,b,alice:alice!,bob:bob!,...ids};
}
async function importRows(f:any, accountId:any, rows:any[]) {
 return f.a.mutation(api.imports.commit,{accountId,kind:"csv",fileName:"fixture.csv",rows});
}
async function proposal(f:any, agentId=f.agent, requestId:string|undefined="invoice-1", amount=3) {
 return f.t.mutation(internal.gateway.proposePayment,{agentId,contactId:f.payee,amount,reason:"invoice",...(requestId===undefined?{}:{requestId})});
}


it("REVIEW callback retry cannot downgrade a confirmed agent payment",async()=>{const f=await fixture();const r=await proposal(f);await f.t.mutation(internal.vault.onAgentResult,{taskId:r.taskId,ok:true,txHash:"0xsuccess"});await f.t.mutation(internal.vault.onAgentResult,{taskId:r.taskId,ok:false,code:2007,txHash:"0xretry"});const t=await f.t.run(ctx=>ctx.db.get(r.taskId));expect(t!.state).toBe("confirmed");expect(t!.txHash).toBe("0xsuccess");});
it("REVIEW repeated success callback produces one payment activity",async()=>{const f=await fixture();const r=await proposal(f);for(let i=0;i<2;i++)await f.t.mutation(internal.vault.onAgentResult,{taskId:r.taskId,ok:true,txHash:"0xsuccess"});const rows=await f.t.run(ctx=>ctx.db.query("activity").collect());expect(rows.filter(x=>x.title.includes(" paid "))).toHaveLength(1);});
it("REVIEW delayed unknown callback cannot downgrade confirmed payment",async()=>{const f=await fixture();const r=await proposal(f);await f.t.mutation(internal.vault.onOwnerResult,{taskId:r.taskId,ok:true,txHash:"0xsuccess"});await f.t.mutation(internal.vault.onUnknown,{taskId:r.taskId,txHash:"0xold",note:"late timeout"});expect((await f.t.run(ctx=>ctx.db.get(r.taskId)))!.state).toBe("confirmed");});
it("REVIEW one statement row cannot deduplicate two real purchases",async()=>{const f=await fixture();await importRows(f,f.account,[{at:NOW,amountMinor:-300,description:"Coffee"}]);await importRows(f,f.second,[{at:NOW,amountMinor:-300,description:"Coffee"},{at:NOW+3600000,amountMinor:-300,description:"Coffee"}]);const rows=await f.t.run(ctx=>ctx.db.query("transactions").collect());expect(rows.filter(x=>!x.duplicateOf)).toHaveLength(2);});
it("REVIEW obligation 501 is counted or total is explicitly incomplete",async()=>{const f=await fixture();await f.t.run(async ctx=>{for(let i=0;i<501;i++)await ctx.db.insert("obligations",{userId:f.alice,name:`Bill ${i}`,kind:"bill",amountMinor:100,currency:"USD",cadence:"monthly",nextDueAt:NOW+DAY,status:"active"});});const o=await f.t.run(async ctx=>computeOverview(ctx,(await ctx.db.get(f.alice))!));expect(o.commitments===50100 || o.partial===true).toBe(true);});
it("REVIEW another agent cannot read an unshared task just because it has a requestId",async()=>{const f=await fixture();const r=await proposal(f);await expect(f.t.query(internal.gateway.taskStatus,{agentId:f.agent2,taskId:r.taskId})).rejects.toThrow();});
it("REVIEW same requestId with different payment terms is a conflict",async()=>{const f=await fixture();await proposal(f,f.agent,"invoice",3);const changed=await proposal(f,f.agent2,"invoice",7);expect(changed.outcome).toBe("refused");});
