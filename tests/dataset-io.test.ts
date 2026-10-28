import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error The Node strip-types runner resolves explicit TypeScript paths.
import { datasetErrors, datasetToCsv, datasetToJson, parseDatasetFile, parseDatasetRequestSettings } from '../lib/dataset-io.ts';

test('CSV import preserves quoted commas, newlines, quotes and input whitespace',()=>{
  const dataset=parseDatasetFile('\uFEFFinput,expected\r\n"  첫 줄, 쉼표\n둘째 줄 ""인용""  ",BLOCK','cases.csv');
  assert.equal(dataset.rows[0].input,'  첫 줄, 쉼표\n둘째 줄 "인용"  ');
  assert.equal(dataset.rows[0].expected,'block');
});
test('JSON imports metadata while replacing external row IDs with independent IDs',()=>{
  const source=JSON.stringify({name:'검증 세트',description:'설명',rows:[{id:'external',input:' 배송 ',expected:'allow'}]});
  const first=parseDatasetFile(source,'a.json');const second=parseDatasetFile(source,'a.json');
  assert.equal(first.name,'검증 세트');assert.equal(first.description,'설명');
  assert.equal(first.rows[0].input,' 배송 ');assert.notEqual(first.rows[0].id,'external');assert.notEqual(first.rows[0].id,second.rows[0].id);
});
test('JSON and CSV export/import round trips retain case inputs and expectations',()=>{
  const original={name:'왕복 테스트',description:'설명',rows:[{id:'a',input:'  안녕, "고객"\n다음 줄  ',expected:'allow' as const},{id:'b',input:'customer@example.com',expected:'block' as const}]};
  const comparable=(rows:typeof original.rows)=>rows.map(({input,expected})=>({input,expected}));
  assert.deepEqual(comparable(parseDatasetFile(datasetToCsv(original),'cases.csv').rows),comparable(original.rows));
  assert.deepEqual(comparable(parseDatasetFile(datasetToJson(original),'cases.json').rows),comparable(original.rows));
});
test('CSV import rejects duplicate headers, mismatched columns and malformed quoting',()=>{
  for(const csv of ['input,expected,expected\na,allow,allow','input,expected\na,allow,extra','input,expected\n"abc,allow','input,expected\na"b,allow','input,expected\n"abc"oops,allow'])assert.throws(()=>parseDatasetFile(csv,'bad.csv'));
});
test('Import validation rejects blank, oversized, invalid expectation and over-limit cases',()=>{
  for(const rows of [[],[{input:'  ',expected:'allow'}],[{input:'a',expected:'unknown'}],[{input:'x'.repeat(16001),expected:'allow'}],Array.from({length:101},()=>({input:'a',expected:'allow'}))])assert.throws(()=>parseDatasetFile(JSON.stringify(rows),'bad.json'));
  assert.throws(()=>parseDatasetFile('[]','bad.txt'));
  assert.throws(()=>parseDatasetFile('x'.repeat(2_000_001),'bad.csv'));
});
test('Dataset validation detects duplicate IDs and invalid metadata before saving',()=>{
  const dataset={name:'name',description:'',rows:[{id:'duplicate',input:'hello',expected:'allow' as const},{id:'duplicate',input:'hello',expected:'block' as const}]};
  assert.ok(datasetErrors(dataset).some(message=>message.includes('ID')));
  assert.ok(datasetErrors({...dataset,name:' '.repeat(3)}).some(message=>message.includes('이름')));
  assert.ok(datasetErrors({...dataset,description:'x'.repeat(1001)}).some(message=>message.includes('설명')));
});

test('JSON and CSV preserve optional verification criteria with exact request whitespace',()=>{
  const original={name:'검사 기준',description:'',rows:[
    {id:'a',input:'  고객 메모\r\n다음 줄  ',expected:'block' as const,category:'개인정보',note:'응답에 "이메일"이 있습니다.\n응답 검사에서 차단합니다.',expectedStage:'post' as const,expectedRuleId:'historical-pii-rule'},
    {id:'b',input:'  일반 문의  ',expected:'allow' as const},
  ]};
  const comparable=(rows:{id:string}[])=>rows.map(value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='id')));
  for(const [source,filename] of [[datasetToJson(original),'criteria.json'],[datasetToCsv(original),'criteria.csv']]){
    const parsed=parseDatasetFile(source,filename);
    assert.deepEqual(comparable(parsed.rows),comparable(original.rows));
    assert.notEqual(parsed.rows[0].id,original.rows[0].id);
    assert.equal(Object.hasOwn(parsed.rows[1],'category'),false);
    assert.equal(Object.hasOwn(parsed.rows[1],'expectedStage'),false);
  }
  assert.equal(datasetToCsv(original).split('\r\n')[0],'input,expected,category,note,expectedStage,expectedRuleId');
});

test('CSV accepts snake case criteria headers and rejects duplicated aliases',()=>{
  const parsed=parseDatasetFile('input,expected,category,note,expected_stage,expected_rule_id\n"  request  ",BLOCK,개인정보,이메일 포함,PRE,rule-pii','criteria.csv');
  assert.deepEqual({...parsed.rows[0],id:'id'},{id:'id',input:'  request  ',expected:'block',category:'개인정보',note:'이메일 포함',expectedStage:'pre',expectedRuleId:'rule-pii'});
  assert.throws(()=>parseDatasetFile('input,expected,expectedStage,expected_stage\nrequest,block,pre,pre','bad.csv'),/중복/);
  assert.throws(()=>parseDatasetFile('input,expected,note,note\nrequest,block,a,b','bad.csv'),/중복/);
});

test('Exports keep the original two-field shape when verification criteria are absent',()=>{
  const original={name:'기본 항목',description:'',rows:[{id:'id',input:'  request  ',expected:'allow' as const}]};
  assert.equal(datasetToCsv(original),'input,expected\r\n"  request  ",allow');
  assert.deepEqual(JSON.parse(datasetToJson(original)),{name:'기본 항목',description:'',rows:[{input:'  request  ',expected:'allow'}]});
});

test('Invalid criteria types, lengths and stages cannot be imported or saved',()=>{
  const row={id:'row',input:'request',expected:'block' as const};
  const invalid=[{category:'x'.repeat(81)},{note:'x'.repeat(1001)},{expectedRuleId:'x'.repeat(121)},{category:42},{note:null},{expectedRuleId:[]},{expectedStage:'unknown'},{expectedStage:''}];
  for(const metadata of invalid){
    assert.throws(()=>parseDatasetFile(JSON.stringify([{...row,...metadata}]),'invalid.json'));
    assert.ok(datasetErrors({name:'name',description:'',rows:[{...row,...metadata} as typeof row]}).length>0);
  }
  assert.throws(()=>parseDatasetFile('input,expected,expectedStage\nrequest,block,unknown','invalid.csv'),/expectedStage/);
  const boundaries={...row,category:'x'.repeat(80),note:'x'.repeat(1000),expectedRuleId:'x'.repeat(120),expectedStage:'pre' as const};
  assert.deepEqual(datasetErrors({name:'name',description:'',rows:[boundaries]}),[]);
});

test('structured conversation and generation options survive JSON and CSV round trips without altering whitespace',()=>{
  const original={name:'대화 검증',description:'대화와 설정 보존',rows:[{id:'a',input:'배송 대화',expected:'allow' as const,messages:[{role:'system' as const,content:'  상담 지침\n유지  '},{role:'user' as const,content:'  배송 기간? "인용"\n '},{role:'assistant' as const,content:'확인하겠습니다.'},{role:'user' as const,content:'해외도 가능한가요?'}],generationOptions:{temperature:0,max_tokens:8192,top_p:0}},{id:'b',input:'기본 질문',expected:'block' as const}]};
  const comparable=(rows:{id:string}[])=>rows.map(value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='id')));
  for(const [source,filename] of [[datasetToJson(original),'conversation.json'],[datasetToCsv(original),'conversation.csv']]){
    assert.deepEqual(comparable(parseDatasetFile(source,filename).rows),comparable(original.rows));
  }
  assert.equal(datasetToCsv(original).split('\r\n')[0],'input,expected,messages,generationOptions');
});

test('advanced input rejects malformed roles, missing user, message and option limits before import or save',()=>{
  const invalid=[{messages:[]},{messages:[{role:'tool',content:'x'}]},{messages:[{role:'system',content:'x'}]},{messages:[{role:'user',content:''}]},{messages:[{role:'user',content:'x'.repeat(16001)}]},{messages:Array.from({length:33},()=>({role:'user',content:'a'}))},{messages:Array.from({length:3},()=>({role:'user',content:'x'.repeat(14000)}))},{messages:[{role:'user',content:'a',unexpected:true}]},{generationOptions:[]},{generationOptions:{temperature:2.01}},{generationOptions:{top_p:-0.1}},{generationOptions:{max_tokens:0}},{generationOptions:{max_tokens:1.1}},{generationOptions:{max_tokens:8193}},{generationOptions:{stream:true}}];
  for(const fields of invalid){
    const row={id:'a',input:'request',expected:'allow' as const,...fields};
    assert.ok(datasetErrors({name:'검증',description:'',rows:[row] as never}).length>0,JSON.stringify(fields).slice(0,100));
    assert.throws(()=>parseDatasetFile(JSON.stringify([row]),'invalid.json'));
  }
  assert.throws(()=>parseDatasetFile('input,expected,messages\nquestion,allow,invalid-json','invalid.csv'),/JSON/);
  assert.throws(()=>parseDatasetFile('input,expected,generation_options,generationOptions\nq,allow,{},{}','duplicate.csv'),/중복/);
});

test('blank advanced editors restore single-question defaults and valid edits keep strict option boundaries',()=>{
  assert.deepEqual(parseDatasetRequestSettings('  ','\n'),{messages:undefined,generationOptions:undefined});
  assert.deepEqual(parseDatasetRequestSettings('[{"role":"user","content":"  질문  "}]','{"temperature":2,"max_tokens":1,"top_p":1}'),{messages:[{role:'user',content:'  질문  '}],generationOptions:{temperature:2,max_tokens:1,top_p:1}});
  assert.throws(()=>parseDatasetRequestSettings('[','{}'),/JSON/);
  assert.throws(()=>parseDatasetRequestSettings('[]','{}'),/메시지/);
  assert.throws(()=>parseDatasetRequestSettings('','{"temperature":"1"}'),/temperature/);
});
