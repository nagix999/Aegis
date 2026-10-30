'use client';

import {useId,useMemo,useRef,useState} from 'react';
import {ChevronDown,Search} from 'lucide-react';
import {policyFieldOptions} from '@/lib/policy-field-options';
import {validPolicyPointer} from '@/lib/policy-graph';
import './policy-field-picker.css';

/** Search changes only the path. Value generation is an explicit parent edit. */
export function PolicyFieldPicker({schema,value,onChange,onSelect,disabled,label,invalid=false,fieldKey='path',scalarOnly=false}:{schema:Record<string,unknown>;value:string;onChange:(path:string)=>void;onSelect?:(path:string)=>void;disabled:boolean;label:string;invalid?:boolean;fieldKey?:string;scalarOnly?:boolean}) {
  const id=useId(),input=useRef<HTMLInputElement>(null),[open,setOpen]=useState(false),[active,setActive]=useState(0),[showAll,setShowAll]=useState(false);
  const pendingSelection=useRef(false);
  const options=useMemo(()=>policyFieldOptions(schema).filter(option=>!scalarOnly||!option.types.length||option.types.some(type=>type!=='object'&&type!=='array')),[schema,scalarOnly]);
  const query=value.toLocaleLowerCase();
  const filtered=options.filter(option=>showAll||!query||`${option.path} ${option.title??''} ${option.description??''} ${option.types.join(' ')}`.toLocaleLowerCase().includes(query)).slice(0,256);
  const choose=(path:string)=>{if(disabled)return;pendingSelection.current=false;onChange(path);onSelect?.(path);setOpen(false);input.current?.focus();};
  return <div className="policy-field-picker"><label className="field">{label}<div className="policy-field-picker-input"><Search size={13}/><input ref={input} data-field-key={fieldKey} aria-label={label} role="combobox" aria-autocomplete="list" aria-expanded={open&&!disabled} aria-controls={`${id}-options`} aria-activedescendant={open&&filtered[active]?`${id}-${active}`:undefined} aria-invalid={invalid} disabled={disabled} maxLength={512} value={value} placeholder="필드 검색 또는 /risk/level 입력" onFocus={()=>{setOpen(true);setActive(0);setShowAll(true);}} onBlur={()=>{setOpen(false);const pending=pendingSelection.current;pendingSelection.current=false;if(!disabled&&pending&&validPolicyPointer(value))onSelect?.(value);}} onChange={event=>{if(disabled)return;pendingSelection.current=true;onChange(event.target.value);setOpen(true);setActive(0);setShowAll(false);}} onKeyDown={event=>{if(event.key==='Escape'){pendingSelection.current=false;setOpen(false);return;}if(event.key==='ArrowDown'){event.preventDefault();setOpen(true);setActive(index=>open?Math.min(index+1,Math.max(0,filtered.length-1)):0);}else if(event.key==='ArrowUp'){event.preventDefault();setActive(index=>Math.max(0,index-1));}else if(event.key==='Enter'){event.preventDefault();if(open&&filtered[active])choose(filtered[active].path);else{pendingSelection.current=false;if(!disabled&&validPolicyPointer(value))onSelect?.(value);setOpen(false);}}}}/><button type="button" disabled={disabled} aria-label={`${label} 목록 보기`} onMouseDown={event=>event.preventDefault()} onClick={()=>{setOpen(value=>!value);setShowAll(true);input.current?.focus();}}><ChevronDown size={13}/></button></div></label>
    {open&&!disabled&&<div id={`${id}-options`} className="policy-field-picker-options" role="listbox" aria-label={`${label} 후보`}>{filtered.length?filtered.map((option,index)=><button id={`${id}-${index}`} key={option.path} type="button" role="option" aria-selected={option.path===value} className={active===index?'active':''} onMouseDown={event=>event.preventDefault()} onMouseEnter={()=>setActive(index)} onClick={()=>choose(option.path)}>{option.title&&<b>{option.title}</b>}<code>{option.path||'(전체 출력)'}</code><small>{option.types.join(' / ')||'JSON'}{option.required?' / 필수':''}</small>{option.description&&<small>{option.description}</small>}</button>):<p>일치하는 필드가 없습니다. JSON Pointer를 직접 입력할 수 있습니다.</p>}</div>}
  </div>;
}
