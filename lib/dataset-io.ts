// @ts-expect-error Node's source runner resolves explicit TypeScript paths.
import { fieldAssertionErrors } from './output-expectations.ts';
import type { Dataset, DatasetRow } from './aegis-types';

const optionalColumns = ['category', 'note', 'expectedStage', 'expectedRuleId', 'expectedDecision', 'expectedRoute', 'expectedPolicyCode', 'messages', 'generationOptions', 'expectedPolicyFields'] as const;
const stages = ['pre', 'post', 'main', 'complete'];
const metadataLimits = { category: 80, note: 1000, expectedRuleId: 120, expectedDecision: 64, expectedPolicyCode: 64 } as const;
function metadataErrors(row: Record<string, unknown>, prefix: string): string[] {
  const errors: string[] = [];
  for (const [key, maximum] of Object.entries(metadataLimits)) {
    if (row[key] !== undefined && (typeof row[key] !== 'string' || row[key].length > maximum)) errors.push(`${prefix} ${key} 값은 ${maximum.toLocaleString()}자 이내의 문자열이어야 합니다.`);
  }
  if (row.expectedStage !== undefined && (typeof row.expectedStage !== 'string' || !stages.includes(row.expectedStage))) errors.push(`${prefix} expectedStage 값은 pre, post, main, complete 중 하나여야 합니다.`);
  if (row.expectedRoute !== undefined && !['main','respond','error'].includes(String(row.expectedRoute))) errors.push(`${prefix} expectedRoute 값은 main, respond, error 중 하나여야 합니다.`);
  for (const key of ['expectedDecision','expectedPolicyCode']) if (row[key] !== undefined && (typeof row[key] !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(row[key] as string))) errors.push(`${prefix} ${key} 값은 등록한 대문자 코드로 입력하세요.`);
  if(row.expectedPolicyFields!==undefined)errors.push(...fieldAssertionErrors(row.expectedPolicyFields).map(error=>`${prefix} ${error}`));
  errors.push(...requestSettingsErrors(row, prefix));
  return errors;
}

export function requestSettingsErrors(row: Record<string, unknown>, prefix = '요청'): string[] {
  const errors: string[] = [];
  if (row.messages !== undefined) {
    const messages = row.messages;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 32) errors.push(`${prefix} 대화는 메시지 1~32개로 구성하세요.`);
    else {
      if (messages.some(message => !message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).some(key => !['role','content'].includes(key)) || !['system','user','assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.length || message.content.length > 16000)) errors.push(`${prefix} 각 메시지는 role과 1~16,000자의 content로 구성하세요. 역할은 system, user, assistant를 사용할 수 있습니다.`);
      if (!messages.some(message => message?.role === 'user')) errors.push(`${prefix} 대화에 user 메시지가 하나 이상 필요합니다.`);
      if (messages.reduce((total, message) => total + (typeof message?.content === 'string' ? message.content.length : 0), 0) > 40000) errors.push(`${prefix} 대화 전체는 40,000자 이내로 입력하세요.`);
    }
  }
  if (row.generationOptions !== undefined) {
    const settings = row.generationOptions;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) errors.push(`${prefix} 생성 옵션은 JSON 객체로 입력하세요.`);
    else {
      const options = settings as Record<string, unknown>;
      if (Object.keys(options).some(key => !['temperature','max_tokens','top_p'].includes(key))) errors.push(`${prefix} 생성 옵션에는 temperature, max_tokens, top_p만 사용할 수 있습니다.`);
      for (const [key, maximum] of [['temperature',2],['top_p',1]] as const) if (options[key] !== undefined && (typeof options[key] !== 'number' || !Number.isFinite(options[key]) || options[key] < 0 || options[key] > maximum)) errors.push(`${prefix} ${key} 값은 0~${maximum} 범위의 숫자로 입력하세요.`);
      if (options.max_tokens !== undefined && (typeof options.max_tokens !== 'number' || !Number.isInteger(options.max_tokens) || options.max_tokens < 1 || options.max_tokens > 8192)) errors.push(`${prefix} max_tokens 값은 1~8,192 범위의 정수로 입력하세요.`);
    }
  }
  return errors;
}

/** Empty fields deliberately restore the legacy single-question/default-option form. */
export function parseDatasetRequestSettings(messagesSource: string, optionsSource: string): Pick<DatasetRow,'messages'|'generationOptions'> {
  const values: Record<string, unknown> = {};
  for (const [key, source, label] of [['messages',messagesSource,'대화 메시지'],['generationOptions',optionsSource,'생성 옵션']] as const) {
    if (!source.trim()) continue;
    try { values[key] = JSON.parse(source); } catch { throw new Error(`${label}의 JSON 형식을 확인하세요.`); }
  }
  const errors = requestSettingsErrors(values); if (errors.length) throw new Error(errors[0]);
  return {messages: values.messages as DatasetRow['messages'], generationOptions: values.generationOptions as DatasetRow['generationOptions']};
}
function rowMetadata(row: DatasetRow): Partial<DatasetRow> {
  return Object.fromEntries(optionalColumns.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}

export function datasetErrors(dataset: Pick<Dataset,'name'|'description'|'rows'>): string[] {
  const errors: string[]=[];
  if(!dataset.name.trim()||dataset.name.trim().length>120)errors.push('데이터셋 이름은 1~120자로 입력하세요.');
  if(dataset.description.length>1000)errors.push('설명은 1,000자 이내로 입력하세요.');
  if(dataset.rows.length<1||dataset.rows.length>100)errors.push('검증 항목을 1~100개 등록하세요.');
  for(const [index,row] of dataset.rows.entries()){
    if(!row.input.trim()||row.input.length>16000)errors.push(`${index+1}번 항목의 요청 내용은 1~16,000자로 입력하세요. 공백만 입력할 수는 없습니다.`);
    if(!['allow','block'].includes(row.expected))errors.push(`${index+1}번 항목의 예상 결과를 허용 또는 차단으로 선택하세요.`);
    errors.push(...metadataErrors(row, `${index+1}번 항목의`));
  }
  if(new Set(dataset.rows.map(row=>row.id)).size!==dataset.rows.length)errors.push('검증 항목의 ID가 중복되었습니다.');
  return errors;
}

function csvRows(source:string):string[][] {
  const rows:string[][]=[];let row:string[]=[];let cell='';let quoted=false;let closed=false;
  const finishCell=()=>{row.push(cell);cell='';closed=false;};
  const finishRow=()=>{if(row.length||cell.length||closed){finishCell();rows.push(row);}row=[];cell='';closed=false;};
  for(let i=0;i<source.length;i++){
    const char=source[i];
    if(quoted){if(char==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=char;continue;}
    if(char===','){finishCell();continue;}
    if(char==='\n'||char==='\r'){if(char==='\r'&&source[i+1]==='\n')i++;finishRow();continue;}
    if(closed){if(char===' '||char==='\t')continue;throw new Error('CSV에서 닫는 따옴표 다음에는 쉼표나 줄바꿈이 와야 합니다.');}
    if(char==='"'){if(cell.length)throw new Error('CSV 따옴표는 각 값의 시작에 있어야 합니다.');quoted=true;continue;}
    cell+=char;
  }
  if(quoted)throw new Error('CSV 따옴표가 닫히지 않았습니다.');
  finishRow();return rows;
}

export function parseDatasetFile(source:string,filename:string):Pick<Dataset,'name'|'description'|'rows'> {
  if(new TextEncoder().encode(source).length>2_000_000)throw new Error('2MB 이하의 파일을 선택하세요.');
  const text=source.replace(/^\uFEFF/,'');let name=filename.replace(/\.[^.]+$/,'').slice(0,120);let description='파일에서 가져온 검증 데이터셋';let values:unknown;
  if(filename.toLowerCase().endsWith('.csv')){
    const normalizeHeader = (value: string) => {
      const key = value.trim().toLowerCase().replace(/_/g, '');
      return key === 'expectedstage' ? 'expectedStage' : key === 'expectedruleid' ? 'expectedRuleId' : key === 'expecteddecision' ? 'expectedDecision' : key === 'expectedroute' ? 'expectedRoute' : key === 'expectedpolicycode' ? 'expectedPolicyCode' : key === 'generationoptions' ? 'generationOptions' : key === 'expectedpolicyfields' ? 'expectedPolicyFields' : key;
    };
    const rows=csvRows(text);const headers=rows.shift()?.map(normalizeHeader)||[];
    if(headers.filter(header=>header==='input').length!==1||headers.filter(header=>header==='expected').length!==1)throw new Error('CSV에는 input, expected 열이 각각 하나씩 필요합니다.');
    if(optionalColumns.some(key=>headers.filter(header=>header===key).length>1))throw new Error('CSV의 선택 열 이름은 중복될 수 없습니다.');
    const input=headers.indexOf('input');const expected=headers.indexOf('expected');
    values=rows.map((row,index)=>{
      if(row.length!==headers.length)throw new Error(`CSV ${index+2}행의 열 개수가 헤더와 다릅니다.`);
      const metadata: Record<string, unknown> = {};
      for(const key of optionalColumns){const column=headers.indexOf(key);if(column>=0&&row[column]!==''){
        if(key==='messages'||key==='generationOptions'||key==='expectedPolicyFields'){try{metadata[key]=JSON.parse(row[column]);}catch{throw new Error(`CSV ${index+2}행 ${key} 값의 JSON 형식을 확인하세요.`);}}
        else metadata[key]=key==='expectedStage'?row[column].trim().toLowerCase():row[column];
      }}
      return {input:row[input],expected:row[expected].trim().toLowerCase(),...metadata};
    });
  }else if(filename.toLowerCase().endsWith('.json')){
    let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw new Error('올바른 JSON 파일이 아닙니다.');}
    if(Array.isArray(parsed))values=parsed;
    else if(parsed&&typeof parsed==='object'&&'rows' in parsed){
      const object=parsed as Record<string,unknown>;values=object.rows;
      if(object.name!==undefined){if(typeof object.name!=='string')throw new Error('JSON의 name 값은 문자열이어야 합니다.');name=object.name;}
      if(object.description!==undefined){if(typeof object.description!=='string')throw new Error('JSON의 description 값은 문자열이어야 합니다.');description=object.description;}
    }else throw new Error('JSON 배열 또는 rows 배열을 가진 객체가 필요합니다.');
  }else throw new Error('CSV 또는 JSON 파일을 선택하세요.');
  if(!Array.isArray(values)||values.length<1||values.length>100)throw new Error('파일에는 검증 항목이 1~100개 있어야 합니다.');
  const rows:DatasetRow[]=values.map((value,index)=>{
    if(!value||typeof value!=='object')throw new Error(`${index+1}행 형식이 올바르지 않습니다.`);
    const record=value as Record<string,unknown>;
    if(typeof record.input!=='string'||!record.input.trim()||record.input.length>16000)throw new Error(`${index+1}행 input 값은 공백이 아닌 내용이 포함된 1~16,000자의 문자열이어야 합니다.`);
    if(record.expected!=='allow'&&record.expected!=='block')throw new Error(`${index+1}행 expected 값은 allow(허용) 또는 block(차단)이어야 합니다.`);
    const errors=metadataErrors(record,`${index+1}행`);if(errors.length)throw new Error(errors[0]);
    const metadata=Object.fromEntries(optionalColumns.filter(key=>record[key]!==undefined).map(key=>[key,record[key]]));
    return {id:`row-${crypto.randomUUID()}`,input:record.input,expected:record.expected,...metadata};
  });
  const result={name:name.trim(),description,rows};const errors=datasetErrors(result);if(errors.length)throw new Error(errors[0]);return result;
}

export function datasetToJson(dataset:Pick<Dataset,'name'|'description'|'rows'>):string {
  return JSON.stringify({name:dataset.name,description:dataset.description,rows:dataset.rows.map(row=>({input:row.input,expected:row.expected,...rowMetadata(row)}))},null,2);
}
export function datasetToCsv(dataset:Pick<Dataset,'rows'>):string {
  const quote=(value:string)=>'"'+value.replace(/"/g,'""')+'"';
  const columns=optionalColumns.filter(key=>dataset.rows.some(row=>row[key]!==undefined));
  return ['input','expected',...columns].join(',')+'\r\n'+dataset.rows.map(row=>[quote(row.input),row.expected,...columns.map(key=>quote(row[key]===undefined?'':typeof row[key]==='string'?row[key] as string:JSON.stringify(row[key])))].join(',')).join('\r\n');
}
