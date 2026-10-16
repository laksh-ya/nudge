import fs from 'node:fs';
import { createPublicClient,createWalletClient,http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const chain={id:84532,name:'QA local',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:['http://127.0.0.1:18546']}}};
const account=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const pub=createPublicClient({chain,transport:http(),pollingInterval:50}); const wallet=createWalletClient({chain,transport:http(),pollingInterval:50,account});
const out={rpc:'http://127.0.0.1:18546',chainId:84532};
for(const [key,name,args] of [['TOKEN','TestUSD',[]],['FACTORY','VaultFactory',[account.address]]]) {
 const artifact=JSON.parse(fs.readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`,import.meta.url)));
 const hash=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args});
 const receipt=await pub.waitForTransactionReceipt({hash});out[key]=receipt.contractAddress;
}
fs.writeFileSync(process.env.QA_DEPLOYMENT_FILE,JSON.stringify(out,null,2));console.log(out);
