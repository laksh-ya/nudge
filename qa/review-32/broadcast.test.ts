import { convexTest } from "convex-test";
import { expect,it,vi } from "vitest";
import { createServer } from "node:http";
import { readFileSync,writeFileSync } from "node:fs";
import { createPublicClient,createWalletClient,http,sha256,toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { harness } from "../../domain/src/e2e-harness";
import { actionDigest,encode,Op,keyIdOf } from "../../domain/src/vault";
import { vaultFactoryAbi,testUsdAbi } from "../../domain/src/abi";
import schema from "./schema";
import { api,internal } from "./_generated/api";
vi.mock("./lib/relayer",()=>({relayer:{enqueueAction:vi.fn(async()=>"queue")}}));
const modules=import.meta.glob(["./**/*.ts","./**/*.js","!./**/*.test.ts"]);
const local=JSON.parse(readFileSync(process.env.QA_DEPLOYMENT_FILE ?? "/tmp/agent-wallet-local-deployment.json","utf8"));
const chain={id:84532,name:"QA local",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:{default:{http:[local.rpc]}}};
const pk="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account=privateKeyToAccount(pk);
const pub=createPublicClient({chain,transport:http(),pollingInterval:50});
const wallet=createWalletClient({chain,account,transport:http()});

it("FAULT accepted transaction with lost broadcast response must remain reconcilable",async()=>{
 const t=convexTest(schema,modules);
 const owner=t.withIdentity({subject:"fault",issuer:"https://test.local",tokenIdentifier:"https://test.local|fault"});
 const userId=await owner.mutation(api.users.ensure,{});
 const h=harness("local-fault");
 const rp=sha256(toBytes("agent-wallet-approve.vercel.app"));
 const args=[local.TOKEN,h.x,h.y,rp,0n,100000000n,0n,sha256(toBytes(String(Date.now())))] as const;
 const vault=await pub.readContract({address:local.FACTORY,abi:vaultFactoryAbi,functionName:"predict",args});
 await pub.waitForTransactionReceipt({hash:await wallet.writeContract({address:local.FACTORY,abi:vaultFactoryAbi,functionName:"createVault",args})});
 await pub.waitForTransactionReceipt({hash:await wallet.writeContract({address:local.TOKEN,abi:testUsdAbi,functionName:"faucet",args:[vault,100000000n]})});
 const keyId=keyIdOf(h.x as any,h.y as any);
 const action={op:Op.Pay,data:encode.pay(account.address,3000000n,sha256(toBytes("fault-payment"))),nonce:773n,deadline:BigInt(Math.floor(Date.now()/1000)+600)};
 const auth=h.assertion(actionDigest(action,vault));
 const taskId=await t.run(async ctx=>{
  await ctx.db.insert("wallets",{userId:userId!,address:vault,chain:"base-sepolia",asset:"USDC",balanceMinor:10000,protectedMinor:0,dailyCeilingMinor:10000,frozen:false,status:"live",version:2,keyId});
  return ctx.db.insert("tasks",{userId:userId!,title:"Fault probe",channel:"app",rail:"base-sepolia",state:"reserved",amountMinor:300,currency:"USDC",action:{...action,nonce:String(action.nonce),deadline:Number(action.deadline)},updatedAt:Date.now()});
 });
 let acceptedHash:string|undefined;
 const proxy=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString();const call=JSON.parse(body);
  const upstream=await fetch(local.rpc,{method:"POST",headers:{"content-type":"application/json"},body});const result=await upstream.json();
  if(call.method==="eth_sendRawTransaction"){
   if(result.result)acceptedHash=result.result;
   res.setHeader("content-type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:call.id,error:{code:-32000,message:"QA: response lost after node accepted transaction"}}));
  }else{res.setHeader("content-type","application/json");res.end(JSON.stringify(result));}
 });
 await new Promise<void>(resolve=>proxy.listen(0,"127.0.0.1",resolve));
 const port=(proxy.address() as any).port;
 vi.stubEnv("CHAIN_RPC_URL",`http://127.0.0.1:${port}`);vi.stubEnv("RELAYER_PRIVATE_KEY",pk);
 try{
  const before=await pub.readContract({address:local.TOKEN,abi:testUsdAbi,functionName:"balanceOf",args:[account.address]});
  await t.action(internal.chain.relayOwner,{taskId,keyId,auth:{...auth,challengeIndex:Number(auth.challengeIndex),typeIndex:Number(auth.typeIndex)}});
  const receipt=acceptedHash?await pub.waitForTransactionReceipt({hash:acceptedHash as any,timeout:10000}):null;
  const after=await pub.readContract({address:local.TOKEN,abi:testUsdAbi,functionName:"balanceOf",args:[account.address]});
  const task=await t.run(ctx=>ctx.db.get(taskId));
  writeFileSync(process.env.QA_REPORT_DIR+"/broadcast-fault-evidence.json",JSON.stringify({mode:"local Anvil only",acceptedHash,receiptStatus:receipt?.status,transferredTokenUnits:String(after-before),backendState:task?.state,persistedTxHash:task?.txHash??null,reason:task?.reason},null,2));
  expect(after-before).toBe(3000000n);
  expect(task!.state).not.toBe("failed");
  expect(task!.txHash).toBe(acceptedHash);
 }finally{vi.unstubAllEnvs();proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
},30000);
