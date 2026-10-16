import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { computeOverview } from "./lib/overview";
import type { Id } from "./_generated/dataModel";

// From research/review-2026-10-16/codex-probes/backend.test.ts (issue #7). Changes from the original:
// the two approval controls call decide as the signed-in owner (since #6 anyone else is refused
// before expiry or cancellation is even checked), and task ids are typed.

// Only the external relayer queue is stubbed. Production DB handlers and schema run unchanged.
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
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

it("CONTROL anonymous user cannot import",async()=>{const f=await fixture();await expect(f.t.mutation(api.imports.commit,{accountId:f.account,kind:"csv",rows:[]})).rejects.toThrow("Not signed in");});
it("CONTROL foreign account import is rejected",async()=>{const f=await fixture();await expect(f.b.mutation(api.imports.commit,{accountId:f.account,kind:"csv",rows:[]})).rejects.toThrow("Not found");});
it("CONTROL foreign transaction list is empty",async()=>{const f=await fixture();await importRows(f,f.account,[{at:NOW,amountMinor:-100,description:"Coffee"}]);expect((await f.b.query(api.money.transactions,{accountId:f.account,paginationOpts:{numItems:10,cursor:null}})).page).toEqual([]);});
it("CONTROL foreign transaction detail and edit are denied",async()=>{const f=await fixture();await importRows(f,f.account,[{at:NOW,amountMinor:-100,description:"Coffee"}]);const tx=await f.t.run(ctx=>ctx.db.query("transactions").first());expect(await f.b.query(api.money.transaction,{id:tx!._id})).toBeNull();await expect(f.b.mutation(api.money.recategorize,{id:tx!._id,category:"Other",always:false})).rejects.toThrow();});
it("CONTROL foreign agent control is denied",async()=>{const f=await fixture();await expect(f.b.mutation(api.agents.setStatus,{agentId:f.agent,status:"frozen"})).rejects.toThrow();});
it("CONTROL foreign payee cannot be paid",async()=>{const f=await fixture();const r=await f.t.mutation(internal.gateway.proposePayment,{agentId:f.agent,contactId:f.bobPayee,amount:3,reason:"x"});expect(r.outcome).toBe("refused");});
it("CONTROL same-agent request-id retry returns same task",async()=>{const f=await fixture();const x=await proposal(f);const y=await proposal(f);expect(y.outcome).toBe("duplicate");expect(y.taskId).toBe(x.taskId);});
it("CONTROL frozen agent cannot propose",async()=>{const f=await fixture();await f.a.mutation(api.agents.setStatus,{agentId:f.agent,status:"frozen"});await expect(proposal(f)).rejects.toThrow();});
it("CONTROL duplicate statement import is idempotent",async()=>{const f=await fixture();const rows=[{at:NOW,amountMinor:-100,description:"Coffee"}];await importRows(f,f.account,rows);const r=await importRows(f,f.account,rows);expect(r.added).toBe(0);expect(await f.t.run(ctx=>ctx.db.query("transactions").collect())).toHaveLength(1);});
it("CONTROL 2001-row import is rejected",async()=>{const f=await fixture();await expect(importRows(f,f.account,Array.from({length:2001},()=>({at:NOW,amountMinor:-100,description:"Coffee"})))).rejects.toThrow("2000");});
it("CONTROL cancelled approval cannot be approved later",async()=>{const f=await fixture();const r=await proposal(f,f.agent,"over",12);const task=await f.t.run(ctx=>ctx.db.get(r.taskId as Id<"tasks">));await f.a.mutation(api.tasks.cancel,{taskId:r.taskId});await expect(f.a.mutation(api.approvals.decide,{token:task!.approvalToken!,approve:true})).rejects.toThrow();});
it("CONTROL expired approval is not executed",async()=>{const f=await fixture();const id=await f.t.run(ctx=>ctx.db.insert("tasks",{userId:f.alice,title:"Expired",channel:"app",state:"awaiting_approval",rail:"simulator",approvalToken:"abcdefghijklmnopqrstuvwx",expiresAt:NOW-1,updatedAt:NOW}));expect(await f.a.mutation(api.approvals.decide,{token:"abcdefghijklmnopqrstuvwx",approve:true})).toBe("expired");expect((await f.t.run(ctx=>ctx.db.get(id)))!.state).toBe("expired");});

it("REGRESSION same obligation through two agents settles once",async()=>{const f=await fixture();const x=await proposal(f,f.agent,"shared-invoice");const y=await proposal(f,f.agent2,"shared-invoice");expect(y.taskId).toBe(x.taskId);});
it("REGRESSION accepted request is not reported paid before settlement",async()=>{const f=await fixture();const r=await proposal(f);const task=await f.t.run(ctx=>ctx.db.get(r.taskId as Id<"tasks">));expect(task!.state).toBe("submitted");expect(r.outcome).not.toBe("paid");});
it("REGRESSION repeated manual purchases are not discarded as reimports",async()=>{const f=await fixture();await f.a.mutation(api.imports.addOne,{accountId:f.account,at:NOW,amountMinor:-300,merchant:"Coffee"});await f.a.mutation(api.imports.addOne,{accountId:f.account,at:NOW+3600000,amountMinor:-300,merchant:"Coffee"});expect(await f.t.run(ctx=>ctx.db.query("transactions").collect())).toHaveLength(2);});
it("REGRESSION different merchants at same amount are not cross-source duplicates",async()=>{const f=await fixture();await importRows(f,f.account,[{at:NOW,amountMinor:-300,description:"Coffee"}]);await importRows(f,f.second,[{at:NOW,amountMinor:-300,description:"Pharmacy"}]);const tx=await f.t.run(ctx=>ctx.db.query("transactions").collect());expect(tx.filter(x=>!x.duplicateOf)).toHaveLength(2);});
it("REGRESSION pending import is promoted when posted statement arrives",async()=>{const f=await fixture();await importRows(f,f.account,[{at:NOW,amountMinor:-300,description:"Coffee",pending:true}]);await importRows(f,f.account,[{at:NOW,amountMinor:-300,description:"Coffee",pending:false}]);const tx=await f.t.run(ctx=>ctx.db.query("transactions").collect());expect(tx).toHaveLength(1);expect(tx[0].status).toBe("posted");});
it("REGRESSION unrelated opposite amounts are not auto-classified transfers",async()=>{const f=await fixture();await importRows(f,f.account,[{at:NOW,amountMinor:-300,description:"Restaurant"}]);await importRows(f,f.second,[{at:NOW,amountMinor:300,description:"Gift from friend"}]);const tx=await f.t.run(ctx=>ctx.db.query("transactions").collect());expect(tx.every(x=>x.kind!=="transfer")).toBe(true);});
it("REGRESSION spend totals include transaction number 2001",async()=>{const f=await fixture();await f.t.run(async ctx=>{for(let i=0;i<2001;i++)await ctx.db.insert("transactions",{userId:f.alice,accountId:f.account,at:NOW-i,amountMinor:-100,currency:"USD",merchant:"Shop",category:"Food",status:"posted",kind:"spend"});});const o=await f.t.run(async ctx=>computeOverview(ctx, (await ctx.db.get(f.alice))!));expect(o.spentThisMonth).toBe(200100);});
it("REGRESSION account totals include account number 101",async()=>{const f=await fixture();await f.t.run(async ctx=>{await ctx.db.delete(f.second);for(let i=0;i<100;i++)await ctx.db.insert("accounts",{userId:f.alice,kind:"bank",name:`Account ${i}`,institution:"Test",currency:"USD",balanceMinor:100,syncedAt:NOW,source:"manual",can:["read"],status:"ok"});});const o=await f.t.run(async ctx=>computeOverview(ctx,(await ctx.db.get(f.alice))!));expect(o.accountCount).toBe(101);expect(o.cash).toBe(110000);});
it("REGRESSION overdue unpaid bills still reduce safe-to-spend",async()=>{const f=await fixture();await f.t.run(ctx=>ctx.db.insert("obligations",{userId:f.alice,name:"Overdue rent",kind:"bill",amountMinor:10000,currency:"USD",cadence:"monthly",nextDueAt:NOW-2*DAY,status:"active"}));const o=await f.t.run(async ctx=>computeOverview(ctx,(await ctx.db.get(f.alice))!));expect(o.commitments).toBe(10000);});
it("REGRESSION hidden balance cannot be binary-searched through canAfford",async()=>{const f=await fixture();await f.t.run(ctx=>ctx.db.patch(f.agent,{hidesBalances:true}));const o=await f.t.query(internal.gateway.canAfford,{agentId:f.agent,amount:1999});expect(o).not.toHaveProperty("affordable");});
it("REGRESSION rejected signature cannot consume an approval request",async()=>{const f=await fixture();const token="abcdefghijklmnopqrstuvwx";await f.t.run(async ctx=>{await ctx.db.patch(f.wallet,{keyId:"0x"+"1".repeat(64)});await ctx.db.insert("tasks",{userId:f.alice,title:"Pay",channel:"app",state:"awaiting_approval",rail:"base-sepolia",approvalToken:token,action:{op:0,data:"0x",nonce:"1",deadline:Math.floor(NOW/1000)+600},updatedAt:NOW});});await expect(f.t.mutation(api.approvals.submit,{token,auth:{r:"0x00",s:"0x00",challengeIndex:0,typeIndex:0,authenticatorData:"0x",clientDataJSON:"garbage"}})).rejects.toThrow();});

// Review #32 (qa/review-32/backend-adversarial.test.ts), cases B3-B6, assertions unchanged.
it("REVIEW one statement row cannot deduplicate two real purchases",async()=>{const f=await fixture();await importRows(f,f.account,[{at:NOW,amountMinor:-300,description:"Coffee"}]);await importRows(f,f.second,[{at:NOW,amountMinor:-300,description:"Coffee"},{at:NOW+3600000,amountMinor:-300,description:"Coffee"}]);const rows=await f.t.run(ctx=>ctx.db.query("transactions").collect());expect(rows.filter(x=>!x.duplicateOf)).toHaveLength(2);});
it("REVIEW obligation 501 is counted or total is explicitly incomplete",async()=>{const f=await fixture();await f.t.run(async ctx=>{for(let i=0;i<501;i++)await ctx.db.insert("obligations",{userId:f.alice,name:`Bill ${i}`,kind:"bill",amountMinor:100,currency:"USD",cadence:"monthly",nextDueAt:NOW+DAY,status:"active"});});const o=await f.t.run(async ctx=>computeOverview(ctx,(await ctx.db.get(f.alice))!));expect(o.commitments===50100 || o.partial===true).toBe(true);});
it("REVIEW another agent cannot read an unshared task just because it has a requestId",async()=>{const f=await fixture();const r=await proposal(f);await expect(f.t.query(internal.gateway.taskStatus,{agentId:f.agent2,taskId:r.taskId as string})).rejects.toThrow();});
it("REVIEW same requestId with different payment terms is a conflict",async()=>{const f=await fixture();await proposal(f,f.agent,"invoice",3);const changed=await proposal(f,f.agent2,"invoice",7);expect(changed.outcome).toBe("refused");});

// Review #32 (qa/review-32/backend-adversarial.test.ts), cases B2 (#53), assertions unchanged.
it("REVIEW callback retry cannot downgrade a confirmed agent payment",async()=>{const f=await fixture();const r=await proposal(f);await f.t.mutation(internal.vault.onAgentResult,{taskId:r.taskId,ok:true,txHash:"0xsuccess"});await f.t.mutation(internal.vault.onAgentResult,{taskId:r.taskId,ok:false,code:2007,txHash:"0xretry"});const t=await f.t.run(ctx=>ctx.db.get(r.taskId as Id<"tasks">));expect(t!.state).toBe("confirmed");expect(t!.txHash).toBe("0xsuccess");});
it("REVIEW repeated success callback produces one payment activity",async()=>{const f=await fixture();const r=await proposal(f);for(let i=0;i<2;i++)await f.t.mutation(internal.vault.onAgentResult,{taskId:r.taskId,ok:true,txHash:"0xsuccess"});const rows=await f.t.run(ctx=>ctx.db.query("activity").collect());expect(rows.filter(x=>x.title.includes(" paid "))).toHaveLength(1);});
it("REVIEW delayed unknown callback cannot downgrade confirmed payment",async()=>{const f=await fixture();const r=await proposal(f);await f.t.mutation(internal.vault.onOwnerResult,{taskId:r.taskId,ok:true,txHash:"0xsuccess"});await f.t.mutation(internal.vault.onUnknown,{taskId:r.taskId,txHash:"0xold",note:"late timeout"});expect((await f.t.run(ctx=>ctx.db.get(r.taskId as Id<"tasks">)))!.state).toBe("confirmed");});
