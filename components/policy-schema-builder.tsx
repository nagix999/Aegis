'use client';

import { useEffect, useMemo, useState } from 'react';
import { Braces, Hash, List, LockKeyhole, Plus, ToggleLeft, Trash2, Type } from 'lucide-react';
import { addSchemaProperty, getSchemaNode, removeSchemaProperty, renameSchemaProperty, schemaBuilderTree, schemaEditable, setSchemaPropertyRequired, setSchemaType, updateSchemaNode, type SchemaPath, type SchemaType } from '@/lib/policy-schema-builder';
import './policy-schema-builder.css';

const typeLabels: Record<SchemaType, string> = { object: '객체', array: '목록', string: '텍스트', integer: '정수', number: '숫자', boolean: '참 또는 거짓', null: 'null' };
const samePath = (left: SchemaPath, right: SchemaPath) => JSON.stringify(left) === JSON.stringify(right);
function fieldPath(path: SchemaPath): string {
  if (!path.length) return '출력 전체';
  const parts: string[] = [];
  for (let index = 0; index < path.length; index++) {
    if (path[index] === 'properties' && index + 1 < path.length) parts.push(path[++index].replace(/~/g, '~0').replace(/\//g, '~1'));
    else if (path[index] === 'items') parts.push('*');
    else parts.push(path[index]);
  }
  return '/' + parts.join('/');
}
function FieldIcon({ type }: { type: string }) {
  return type === 'object' ? <Braces size={14}/> : type === 'array' ? <List size={14}/> : type === 'number' || type === 'integer' ? <Hash size={14}/> : type === 'boolean' ? <ToggleLeft size={14}/> : <Type size={14}/>;
}

export type PolicySchemaBuilderProps = { schema: Record<string, unknown>; disabled: boolean; onChange: (schema: Record<string, unknown>) => void; onEditJson?: () => void };
export function PolicySchemaBuilder({ schema, disabled, onChange, onEditJson }: PolicySchemaBuilderProps) {
  const [selected, setSelected] = useState<SchemaPath>([]);
  const [fieldName, setFieldName] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<SchemaType>('string');
  const [newRequired, setNewRequired] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [enumText, setEnumText] = useState('');
  const rows = useMemo(() => schemaBuilderTree(schema), [schema]);
  const active = rows.find(row => samePath(row.path, selected)) ?? rows[0];
  const path = active?.path ?? [];
  const key = JSON.stringify(path);
  const node = getSchemaNode(schema, path);
  const descriptor = node ? schemaEditable(node) : { editable: false, type: 'complex' as const, warning: '이 형식은 JSON에서 편집하세요.' };
  const editable = !disabled && descriptor.editable;
  const property = path.length >= 2 && path.at(-2) === 'properties';
  const propertyName = property ? path.at(-1)! : '';
  const parentPath = property ? path.slice(0, -2) : [];
  const parent = property ? getSchemaNode(schema, parentPath) : undefined;
  const parentEditable = Boolean(parent && schemaEditable(parent).editable);
  const required = Boolean(property && Array.isArray(parent?.required) && parent.required.includes(propertyName));
  const nullable = node?.type === 'null' || Array.isArray(node?.type) && node.type.includes('null');
  const enumKey = JSON.stringify(node?.enum);

  useEffect(() => { setFieldName(propertyName); setError(''); setConfirmDelete(false); setNewName(''); }, [key, propertyName]);
  useEffect(() => { setEnumText(Array.isArray(node?.enum) ? node.enum.filter(value => typeof value === 'string').join('\n') : ''); }, [key, enumKey]);

  function apply(operation: () => Record<string, unknown>, nextPath?: SchemaPath): boolean {
    if (disabled) return false;
    try { const next = operation(); onChange(next); if (nextPath) setSelected(nextPath); setError(''); setConfirmDelete(false); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : '변경 내용을 적용하지 못했습니다.'); return false; }
  }
  function patch(values: Record<string, unknown>): boolean { return editable && apply(() => updateSchemaNode(schema, path, values)); }
  function rename() {
    if (!editable || !property || !parentEditable || fieldName === propertyName) return;
    const name = fieldName;
    apply(() => renameSchemaProperty(schema, parentPath, propertyName, name), [...parentPath, 'properties', name]);
  }
  function addField() {
    if (!editable || descriptor.type !== 'object') return;
    const name = newName;
    if (apply(() => {
      const added = addSchemaProperty(schema, path, name, newType);
      return newRequired ? setSchemaPropertyRequired(added, path, name, true) : added;
    }, [...path, 'properties', name])) setNewName('');
  }
  function numberField(label: string, keyword: string, whole = false) {
    return <label className="field" key={keyword}>{label}<input aria-label={label} type="number" step={whole ? 1 : 'any'} min={whole ? 0 : undefined} disabled={!editable} value={typeof node?.[keyword] === 'number' ? node[keyword] as number : ''} placeholder="제한 없음" onChange={event => {
      const value = event.target.value;
      if (value === '') { patch({ [keyword]: undefined }); return; }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || whole && (!Number.isInteger(parsed) || parsed < 0)) { setError(`${label}에 ${whole ? '0 이상의 정수' : '유한한 숫자'}를 입력하세요.`); return; }
      const pairs: Record<string, string> = { minimum:'maximum', maximum:'minimum', minLength:'maxLength', maxLength:'minLength', minItems:'maxItems', maxItems:'minItems' };
      const other = node?.[pairs[keyword]];
      if (typeof other === 'number' && (keyword.startsWith('min') ? parsed > other : parsed < other)) { setError('최솟값은 최댓값보다 클 수 없습니다. 기존 설정은 유지됩니다.'); return; }
      patch({ [keyword]: parsed });
    }}/></label>;
  }
  return <section className="policy-schema-builder" aria-label="필드로 출력 스키마 만들기">
    <p className="psb-help">왼쪽에서 필드를 선택해 형식과 조건을 정하세요. 객체 안에 필드를 추가하고 목록의 항목 형식도 설정할 수 있습니다.</p>
    <div className="psb-layout">
      <nav className="psb-tree" aria-label="출력 스키마 필드 목록">{rows.map(row => <button type="button" key={row.id} aria-label={`${fieldPath(row.path)} 필드 선택`} aria-pressed={samePath(row.path, path)} className={samePath(row.path, path) ? 'is-selected' : ''} data-schema-path={JSON.stringify(row.path)} onClick={() => setSelected(row.path)} style={{ paddingLeft: 10 + (row.depth ?? Math.floor(row.path.length / 2)) * 13 }}>
        <FieldIcon type={row.type}/><span><strong>{row.label}</strong><small>{row.type in typeLabels ? typeLabels[row.type as SchemaType] : '고급 JSON 형식'}{row.required ? ' / 필수' : ''}</small></span>{!row.editable && <LockKeyhole size={12} aria-label="JSON 편집 필요"/>}
      </button>)}{!rows.length && <p>이 스키마는 JSON에서 편집하세요.</p>}{rows.length >= 100 && <p>필드 목록은 최대 100개까지 표시합니다. 전체 구조는 JSON에서 확인하세요.</p>}</nav>
      <div className="psb-settings"><div className="psb-heading"><div><strong>{active?.label ?? '출력 스키마'}</strong><code>{fieldPath(path)}</code></div>{onEditJson && <button type="button" className="btn small" onClick={onEditJson}>JSON에서 편집</button>}</div>
        {error && <p className="psb-error" role="alert">{error}</p>}
        {!descriptor.editable ? <div className="psb-advanced" role="status"><LockKeyhole size={16}/><p>{descriptor.warning || '참조, 복합 조건 또는 이 화면에서 지원하지 않는 설정을 포함합니다.'}<br/>기존 내용은 보존됩니다. 이 필드는 JSON에서 편집하세요.</p></div> : node && <>
          {property && <div className="psb-rename"><label className="field">필드 이름<input aria-label="스키마 필드 이름" value={fieldName} maxLength={120} disabled={!editable || !parentEditable} onChange={event => setFieldName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); rename(); } }}/><small>새 이름을 입력한 뒤 이름 변경을 누르세요.</small></label><button type="button" className="btn small" disabled={!editable || !parentEditable || fieldName === propertyName} onClick={rename}>이름 변경</button></div>}
          <div className="psb-two-columns"><label className="field">자료형<select aria-label="스키마 필드 자료형" value={descriptor.type} disabled={!editable} onChange={event => apply(() => setSchemaType(schema, path, event.target.value as SchemaType, nullable && event.target.value !== 'null'))}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <div className="psb-options">{property && <label><input aria-label="스키마 필드 필수" type="checkbox" checked={required} disabled={!editable || !parentEditable} onChange={event => apply(() => setSchemaPropertyRequired(schema, parentPath, propertyName, event.target.checked))}/>필수 필드</label>}<label><input aria-label="스키마 null 허용" type="checkbox" checked={nullable} disabled={!editable || descriptor.type === 'null'} onChange={event => apply(() => setSchemaType(schema, path, descriptor.type as SchemaType, event.target.checked))}/>null 허용</label></div>
          </div>
          <label className="field">설명<textarea aria-label="스키마 필드 설명" rows={2} maxLength={1000} value={typeof node.description === 'string' ? node.description : ''} disabled={!editable} onChange={event => patch({ description: event.target.value || undefined })}/><small>모델이 이 필드의 의미를 이해할 수 있도록 설명하세요.</small></label>
          {descriptor.type === 'object' && <>
            <label className="psb-check"><input aria-label="정의하지 않은 필드 허용" type="checkbox" checked={node.additionalProperties !== false} disabled={!editable} onChange={event => patch({ additionalProperties: event.target.checked })}/>정의하지 않은 필드 허용</label>
            <fieldset className="psb-add-field" disabled={!editable}><legend>하위 필드 추가</legend><div className="psb-two-columns"><label className="field">필드 이름<input aria-label="추가할 필드 이름" value={newName} maxLength={120} onChange={event => setNewName(event.target.value)} placeholder="예: topic 또는 metadata" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addField(); } }}/></label><label className="field">자료형<select aria-label="추가할 필드 자료형" value={newType} onChange={event => setNewType(event.target.value as SchemaType)}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><div className="psb-add-actions"><label><input aria-label="추가할 필드 필수" type="checkbox" checked={newRequired} onChange={event => setNewRequired(event.target.checked)}/>필수 필드</label><button type="button" className="btn small" disabled={!editable || !newName.trim()} onClick={addField}><Plus size={13}/>필드 추가</button></div></fieldset>
          </>}
          {descriptor.type === 'array' && <>
            <div className="psb-two-columns">{numberField('최소 항목 수', 'minItems', true)}{numberField('최대 항목 수', 'maxItems', true)}</div>
            {node.items === undefined ? <button type="button" className="btn small" disabled={!editable} onClick={() => apply(() => updateSchemaNode(schema, path, {items:{type:'string'}}), [...path, 'items'])}><Plus size={13}/>항목 형식 추가</button> : <button type="button" className="btn small" onClick={() => setSelected([...path, 'items'])}>배열 항목 형식 설정</button>}
          </>}
          {descriptor.type === 'string' && <>
            <div className="psb-two-columns">{numberField('최소 글자 수', 'minLength', true)}{numberField('최대 글자 수', 'maxLength', true)}</div>
            <label className="field">허용 문자열 값<textarea aria-label="허용 문자열 값" rows={3} value={enumText} disabled={!editable} placeholder={'service\nother'} onChange={event => {
              const text = event.target.value, values = [...new Set(text.split(/\r?\n/).filter(value => value.length > 0))];
              if (values.length + (nullable && values.length ? 1 : 0) > 32) { setError('허용값은 null을 포함해 최대 32개까지 입력하세요. 기존 설정은 유지됩니다.'); return; }
              if (patch({ enum: values.length ? [...values, ...(nullable ? [null] : [])] : undefined })) setEnumText(text);
            }}/><small>한 줄에 값 하나씩 최대 32개 입력하세요. 비우면 값의 제한을 없앱니다. 공백도 값의 일부입니다.</small></label>
          </>}
          {(descriptor.type === 'number' || descriptor.type === 'integer') && <div className="psb-two-columns">{numberField('최솟값', 'minimum')}{numberField('최댓값', 'maximum')}</div>}
          {property && <div className="psb-remove-field">{confirmDelete ? <div className="psb-delete-confirm" role="alert"><p>이 필드와 모든 하위 설정을 삭제할까요?</p><button type="button" className="btn small" onClick={() => setConfirmDelete(false)}>취소</button><button type="button" className="btn small danger" aria-label="필드 삭제 확인" disabled={!editable || !parentEditable} onClick={() => apply(() => removeSchemaProperty(schema, parentPath, propertyName), parentPath)}>삭제</button></div> : <button type="button" className="btn small danger" aria-label="선택 필드 삭제" disabled={!editable || !parentEditable} onClick={() => setConfirmDelete(true)}><Trash2 size={13}/>선택 필드 삭제</button>}</div>}
        </>}
      </div>
    </div>
  </section>;
}
