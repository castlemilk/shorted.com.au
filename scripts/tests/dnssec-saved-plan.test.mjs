import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const guard = join(root, 'scripts/ci/check-dnssec-plan.py');
const workflow = readFileSync(join(root, '.github/workflows/terraform-deploy.yml'), 'utf8');
const section = workflow.split('      - name: Terraform Apply\n')[1].split('      - name: Get Terraform Outputs')[0];
const run = section.split('        run: |\n')[1].split('\n').map(x => x.replace(/^          /, '')).join('\n');
const address = 'module.edge.cloudflare_zone_dnssec.shorted[0]';
function fixture() {
  const values = { id: 'zone-fixture', zone_id: 'zone-fixture', status: 'disabled' };
  const resource = { address, mode: 'managed', type: 'cloudflare_zone_dnssec' };
  return { format_version: '1.2', errored: false, complete: true,
    resource_changes: [{ ...resource, change: { actions: ['no-op'], before: values, after: structuredClone(values), after_unknown: {} } }],
    planned_values: { root_module: { child_modules: [{ resources: [{ ...resource, values }] }] } } };
}
function parse(raw) { return spawnSync('python3', [guard], { input: raw, encoding: 'utf8' }); }
test('accepts known status unchanged, including active and pending', () => {
  for (const status of ['disabled', 'active', 'pending', 'pending-disabled', 'error']) {
    const p=fixture(); p.resource_changes[0].change.before.status=status;p.resource_changes[0].change.after.status=status;
    assert.equal(parse(JSON.stringify(p)).status,0);
  }
});
const mutations = {
  missingID: p => delete p.resource_changes[0].change.before.id,
  invalidZone: p => p.resource_changes[0].change.before.zone_id='',
  duplicatePlanned: p => p.planned_values.root_module.child_modules[0].resources.push(p.planned_values.root_module.child_modules[0].resources[0]),
  malformedModule: p => p.planned_values.root_module.child_modules=[null],
  aliasMutation: p => p.resource_changes.push({...structuredClone(p.resource_changes[0]),address:'module.other.cloudflare_zone_dnssec.alias'}),
  missing: p => p.resource_changes=[], duplicate: p => p.resource_changes.push(p.resource_changes[0]),
  create: p => p.resource_changes[0].change.actions=['create'], update: p => p.resource_changes[0].change.actions=['update'],
  delete: p => p.resource_changes[0].change.actions=['delete'], replacement: p => p.resource_changes[0].change.actions=['delete','create'],
  unknown: p => p.resource_changes[0].change.after_unknown={ status:true },
  nullStatus: p => p.resource_changes[0].change.before.status=null,
  changedStatus: p => p.resource_changes[0].change.after.status='active',
  missingPlanned: p => p.planned_values.root_module={},
  changedPlanned: p => p.planned_values.root_module.child_modules[0].resources[0].values={status:'active'},
  incomplete: p => p.complete=false, errored: p => p.errored=true,
  version: p => p.format_version='2.0', deferred: p => p.deferred_changes=[{}],
  malformed: p => p.resource_changes=[null], deposed:p => p.resource_changes[0].deposed='old',
  moved:p => p.resource_changes[0].previous_address='old',
  wrongMode:p => p.resource_changes[0].mode='data',
  missingUnknown:p => delete p.resource_changes[0].change.after_unknown,
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`,()=>{
  const p=fixture();mutate(p);const result=parse(JSON.stringify(p));assert.notEqual(result.status,0);assert.ok(result.stderr.length<200);
});
test('malformed JSON, duplicate keys and injected log text never leak',()=>{
  for(const raw of ['SECRET-fixture\n::warning::injection', '{', '{"format_version":"1.2","format_version":"1.2"}', 'null','NaN']) {
    const result=parse(raw);assert.notEqual(result.status,0);assert.ok(!result.stderr.includes('SECRET-fixture'));assert.ok(result.stderr.length<200);
  }
});
function execute(mode='ok', mutateRun=x=>x) {
  const dir=mkdtempSync(join(tmpdir(),'dnssec-plan-test-'));const bin=join(dir,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'sha256sum'),'#!/bin/sh\necho checksum-tool-must-not-run >&2\nexit 99\n',{mode:0o755});
  const log=join(dir,'calls');const input=join(dir,'fixture');writeFileSync(input,JSON.stringify(fixture()));
  writeFileSync(join(bin,'terraform'),`#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
a=sys.argv[1:];m=os.environ['MODE'];log=Path(os.environ['CALLS'])
with log.open('a') as f:f.write(json.dumps(a)+'\\n')
if a[0]=='plan':
 if m=='plan-fail': print('SECRET-fixture');sys.exit(1)
 p=next(x[5:] for x in a if x.startswith('-out='));Path(p).write_bytes(b'SAVED-BYTES')
elif a[0]=='show':
 if m=='show-fail': print('SECRET-fixture',file=sys.stderr);sys.exit(1)
 if m=='valid-show-fail':print(Path(os.environ['FIXTURE']).read_text());sys.exit(1)
 p=json.loads(Path(os.environ['FIXTURE']).read_text())
 if m=='bad-plan':p['resource_changes'][0]['change']['actions']=['update']
 if m=='tamper':Path(a[-1]).write_bytes(b'CHANGED-BYTES')
 if m=='remove-plan':Path(a[-1]).unlink()
 print(json.dumps(p))
elif a[0]=='apply':
 assert Path(a[-1]).read_bytes()==b'SAVED-BYTES'
 sys.exit(1 if m=='apply-fail' else 0)
else:sys.exit(2)
`,{mode:0o755});
  try {
    const script=mutateRun(run.replace(/\$\{\{[^}]*\}\}/g,'fixture'));
    const result=spawnSync('/bin/bash',['--noprofile','--norc','-c',script],{encoding:'utf8',env:{BASH_ENV:'/dev/null',ENV:'/dev/null',PATH:`${bin}:${process.env.PATH}`,GITHUB_WORKSPACE:root,MODE:mode,CALLS:log,FIXTURE:input}});
    let calls=[];try{calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);}catch{}
    const plans=calls.filter(x=>x[0]=='plan');for(const p of plans)assert.equal(spawnSync('test',['-e',p.find(x=>x.startsWith('-out=')).slice(5)]).status,1,'temporary plan removed');
    return {...result,calls};
  }finally{rmSync(dir,{recursive:true,force:true});}
}
test('executes plan, guard then exact saved plan once with prior variable contract',()=>{
 const r=execute();assert.equal(r.status,0,r.stderr);assert.deepEqual(r.calls.map(x=>x[0]),['plan','show','apply']);
 const plan=r.calls[0];const output=plan.find(x=>x.startsWith('-out=')).slice(5);assert.deepEqual(r.calls[2],['apply','-input=false',output]);
 const names=plan.filter(x=>x.startsWith('-var=')).map(x=>x.slice(5).split('=')[0]);
 assert.deepEqual(names,['stock_price_ingestion_image','shorts_api_image','chat_service_image','asx_discovery_image','market_data_sync_image','market_data_image','enrichment_processor_image','weekly_report_generator_image','house_price_collector_image','shorted_jobs_image','shorted_jobs_browser_image','signals_collector_image','report_extractor_image','take_writer_image','image_tag']);
 assert.ok(!plan.some(x=>/-target|-refresh=false|-lock=false/.test(x)));
});
for(const mode of ['plan-fail','show-fail','valid-show-fail','bad-plan','tamper','remove-plan'])test(`${mode} blocks every apply without leaking private diagnostics`,()=>{
 const r=execute(mode);assert.notEqual(r.status,0);assert.deepEqual(r.calls.map(x=>x[0]),mode==='plan-fail'?['plan']:['plan','show'],r.stderr);assert.ok(!r.calls.some(x=>x[0]=='apply'));assert.ok(!(r.stdout+r.stderr).includes('SECRET-fixture'));
});
test('failed apply has no retry or fresh fallback',()=>{const r=execute('apply-fail');assert.notEqual(r.status,0);assert.deepEqual(r.calls.map(x=>x[0]),['plan','show','apply']);});
test('negative control removing gate allows forbidden update to apply',()=>{
 const r=execute('bad-plan',x=>x.replace('python3 "$GITHUB_WORKSPACE/scripts/ci/check-dnssec-plan.py"','cat >/dev/null'));
 assert.equal(r.status,0);assert.ok(r.calls.some(x=>x[0]=='apply'));
});
test('image values retain registry/project/image-tag provenance',()=>{
 const vars=[...run.matchAll(/-var="([^=]+)=([^"\n]+)"/g)].map(x=>[x[1],x[2]]);
 const images=['stock-price-ingestion','shorts','chat-service','asx-discovery','market-data-sync','market-data','enrichment-processor','weekly-report-generator','house-price-collector','shorted-jobs','shorted-jobs-browser','signals-collector','report-extractor','take-writer'];
 assert.equal(vars.length,15);
 for(let i=0;i<images.length;i++)assert.equal(vars[i][1], '${{ env.ARTIFACT_REGISTRY }}/${{ needs.determine-environment.outputs.project-id }}/shorted/'+images[i]+':${{ needs.determine-environment.outputs.image-tag }}');
 assert.deepEqual(vars[14],['image_tag','${{ needs.determine-environment.outputs.image-tag }}']);
});
test('test and job gates remain enforced, with no unguarded apply',()=>{
 assert.equal((run.match(/terraform apply /g)||[]).length,1);
 assert.doesNotMatch(run,/sha256sum/);assert.match(run,/hashlib.sha256/);
 assert.match(run,/set -euo pipefail/);assert.doesNotMatch(run,/-auto-approve|sleep 60|-target|-refresh=false/);
 assert.match(workflow,/needs: \[determine-environment, validate-secrets, terraform-plan, run-tests, housing-contract-tests\]/);
 for(const job of ['terraform-plan','run-tests','housing-contract-tests'])assert.ok(workflow.includes(`needs.${job}.result == 'success'`));
 assert.ok(workflow.includes('run: node --test scripts/tests/terraform-deploy-workflow.test.mjs scripts/tests/dnssec-saved-plan.test.mjs'));
});
