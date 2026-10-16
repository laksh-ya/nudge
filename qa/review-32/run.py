#!/usr/bin/env python3
"""Run tests on an isolated git archive. No deployment credentials are loaded."""
import argparse,io,json,os,pathlib,shutil,socket,subprocess,tarfile,tempfile,time
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[1]
p=argparse.ArgumentParser();p.add_argument('--ref',default='HEAD');p.add_argument('--output');p.add_argument('--broadcast',action='store_true');a=p.parse_args()
sha=subprocess.check_output(['git','rev-parse',a.ref],cwd=ROOT,text=True).strip()
out=pathlib.Path(a.output).resolve() if a.output else pathlib.Path(tempfile.mkdtemp(prefix='agent-wallet-review-output-'))
out.mkdir(parents=True,exist_ok=True)
tmp=pathlib.Path(tempfile.mkdtemp(prefix='agent-wallet-review32-'))
archive=subprocess.check_output(['git','archive',sha],cwd=ROOT)
with tarfile.open(fileobj=io.BytesIO(archive)) as t:t.extractall(tmp,filter='data')
for rel in ['node_modules','packages/domain/node_modules','packages/backend/node_modules','contracts/node_modules']:
 src=ROOT/rel
 if not src.exists():raise SystemExit(f'Missing {src}; install pinned workspace dependencies first')
 (tmp/rel).symlink_to(src,target_is_directory=True)
for src,dest in [('V3AdversarialReview.t.sol','contracts/test/V3AdversarialReview.t.sol'),('backend-adversarial.test.ts','packages/backend/convex/codexReview32.test.ts')]:shutil.copy(HERE/src,tmp/dest)
if a.broadcast:shutil.copy(HERE/'broadcast.test.ts',tmp/'packages/backend/convex/broadcast.test.ts')
config={'resolve':{'alias':{'@agent-wallet/domain':str(tmp/'packages/domain/src/index.ts'),'convex-test':str(ROOT/'packages/backend/node_modules/convex-test/dist/index.js')}},'test':{'environment':'node','include':['packages/backend/convex/*.test.ts','packages/domain/src/{review.finance,approval-truth,webauthn,statements,vault}.test.ts'],'fileParallelism':False,'testTimeout':30000}}
(tmp/'review.config.mjs').write_text('export default '+json.dumps(config))
env=os.environ.copy()
# No inherited model, wallet or production RPC settings enter the test process.
for key in list(env):
 if key.startswith(('E2E_','ANTHROPIC_','CONVEX_','RELAYER_','CHAIN_','TOKEN_ADDRESS','FACTORY_ADDRESS','TELEGRAM_','AGENT_KEY_SECRET')):env.pop(key,None)
env.update(QA_REPORT_DIR=str(out),QA_DEPLOYMENT_FILE=str(tmp/'deployment.json'))
results=[];anvil=None

def run(name,args,cwd=tmp):
 with (out/name).open('w') as f:r=subprocess.run(args,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT)
 results.append({'log':name,'exitCode':r.returncode});print(name,r.returncode,flush=True)
 return r.returncode
try:
 run('contracts-baseline.txt',['forge','test','--no-match-contract','V3AdversarialReview','--summary'],tmp/'contracts')
 run('contracts-adversarial.txt',['forge','test','--match-contract','V3AdversarialReview','--match-test','test_review','-vv'],tmp/'contracts')
 if a.broadcast:
  with socket.socket() as s:
   if s.connect_ex(('127.0.0.1',18546))==0:raise SystemExit('Port 18546 in use; stop the other local test chain before using --broadcast')
  anvil=subprocess.Popen(['anvil','--chain-id','84532','--port','18546','--silent'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  for _ in range(100):
   with socket.socket() as s:
    if s.connect_ex(('127.0.0.1',18546))==0:break
   time.sleep(.05)
  shutil.copy(HERE/'deploy-local.mjs',tmp/'packages/domain/deploy-qa.mjs')
  if run('deployment-local.txt',['node','packages/domain/deploy-qa.mjs']):raise SystemExit('Local deploy failed')
 run('backend-domain.txt',['node',str(ROOT/'packages/backend/node_modules/vitest/vitest.mjs'),'run','--config','review.config.mjs','--reporter=verbose'])
finally:
 if anvil:anvil.terminate();anvil.wait(timeout=10)
 (out/'manifest.json').write_text(json.dumps({'commit':sha,'source':str(tmp),'broadcast':a.broadcast,'results':results},indent=2)+'\n')
 print('Evidence:',out)
# Red means desired security/correctness properties failed, not that the runner malfunctioned.
raise SystemExit(1 if any(x['exitCode'] for x in results) else 0)
