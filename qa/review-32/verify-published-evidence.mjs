// Read-only: public Base Sepolia RPC, no wallet or signing key.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(root,'packages/domain/package.json'));
const {createPublicClient,http,parseEventLogs}=require('viem');
const {policyVaultAbi,vaultFactoryAbi,testUsdAbi}=await import(pathToFileURL(path.join(root,'packages/domain/src/abi.ts')));
const rpc=process.env.EVIDENCE_RPC_URL||'https://sepolia.base.org';
const pub=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:1})});
const sources=['README.md'];
const walk=d=>{if(!fs.existsSync(d))return;for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);if(f.isDirectory())walk(p);else if(/\.md$/.test(p))sources.push(path.relative(root,p));}};
walk(path.join(root,'docs/submission'));
const refs=new Map();for(const file of sources){const lines=fs.readFileSync(path.join(root,file),'utf8').split('\n');lines.forEach((line,i)=>{for(const m of line.matchAll(/sepolia\.basescan\.org\/tx\/(0x[a-fA-F0-9]{64})/g)){const hash=m[1];refs.set(hash,[...(refs.get(hash)||[]),{file,line:i+1,claim:line.replace(/\[[^\]]*\]\([^)]*\)/g,'[transaction]')}]);}});}
const out={checkedAt:new Date().toISOString(),rpc,chainId:await pub.getChainId(),scope:'Receipt and decoded events; does not establish phone/MCP/Telegram provenance or compare every prose claim.',rows:[]};
if(out.chainId!==84532)throw new Error('Wrong chain');
for(const [hash,references] of refs){try{const r=await pub.getTransactionReceipt({hash});const events=parseEventLogs({abi:[...policyVaultAbi,...vaultFactoryAbi,...testUsdAbi],logs:r.logs,strict:false}).map(x=>({address:x.address,event:x.eventName,args:x.args}));out.rows.push({hash,references,status:r.status,blockNumber:r.blockNumber,events});console.log(`${r.status} ${hash} ${events.map(x=>x.event).join(',')}`);}catch(e){out.rows.push({hash,references,status:'UNVERIFIED',error:e.shortMessage||e.message});console.log(`UNVERIFIED ${hash}`);}}
const output=process.env.EVIDENCE_OUTPUT||path.join(root,'qa/review-32/evidence/published-receipts.json');fs.writeFileSync(output,JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(`Checked ${out.rows.length}: ${out.rows.filter(x=>x.status==='success').length} successful receipts, ${out.rows.filter(x=>x.status==='reverted').length} reverted, ${out.rows.filter(x=>x.status==='UNVERIFIED').length} unverified`);
