'use client';

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import './result-drawer.css';

/** Native modal semantics keep keyboard focus in the visible detail and restore its trigger. */
export function ResultDrawer({title,itemKey,index,count,onPrevious,onNext,onClose,children}:{title:string;itemKey:string;index:number;count:number;onPrevious:()=>void;onNext:()=>void;onClose:()=>void;children:ReactNode}) {
  const dialog=useRef<HTMLDialogElement>(null),body=useRef<HTMLDivElement>(null),close=useRef<HTMLButtonElement>(null);
  const titleId=useId(),onCloseRef=useRef(onClose);onCloseRef.current=onClose;
  useEffect(()=>{
    const element=dialog.current,trigger=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    const ancestors:HTMLElement[]=[];for(let parent=element?.parentElement;parent;parent=parent.parentElement)ancestors.push(parent);
    if(!element||ancestors.some(parent=>parent.hidden||parent.inert)){onCloseRef.current();return;}
    const originalOverflow=document.body.style.overflow;
    element?.showModal();document.body.style.overflow='hidden';close.current?.focus({preventScroll:true});
    // Authentication keeps private pages mounted but marks their ancestor hidden/inert.
    // A native top-layer dialog must close with that boundary as well.
    const observer=new MutationObserver(()=>{if(ancestors.some(parent=>parent.hidden||parent.inert)){element?.close();onCloseRef.current();}});
    for(const parent of ancestors)observer.observe(parent,{attributes:true,attributeFilter:['hidden','inert']});
    return()=>{observer.disconnect();element?.close();document.body.style.overflow=originalOverflow;if(trigger?.isConnected&&!trigger.closest('[hidden],[inert]'))trigger.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{body.current?.scrollTo({top:0,behavior:'instant'});},[itemKey]);
  function keepKeyboardFocus(event:KeyboardEvent<HTMLDialogElement>){
    if(event.key!=='Tab')return;
    const element=dialog.current;if(!element)return;
    const focusable=[...element.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]')].filter(item=>item.tabIndex>=0&&!item.matches(':disabled')&&item.getClientRects().length>0&&getComputedStyle(item).visibility!=='hidden');
    const first=focusable[0],last=focusable.at(-1);
    if(!first){event.preventDefault();element.focus();return;}
    if(event.shiftKey&&(document.activeElement===first||!element.contains(document.activeElement))){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
  return <dialog ref={dialog} className="ev-detail-drawer" aria-labelledby={titleId} onKeyDown={keepKeyboardFocus} onCancel={event=>{event.preventDefault();onCloseRef.current();}} onClick={event=>{if(event.target===event.currentTarget)onCloseRef.current();}}>
    <div className="ev-detail-drawer-shell"><header className="ev-detail-drawer-header"><h2 id={titleId}>{title}</h2><button ref={close} className="btn small" aria-label={`${title} 닫기`} onClick={onClose}><X size={16}/> 닫기</button></header>
    <div className="ev-detail-drawer-navigation" aria-label="현재 조회 결과 안에서 이동"><span aria-live="polite" aria-atomic="true">{index>=0?`${index+1} / ${count}건`:'현재 필터 밖의 항목'}</span><button className="btn small" disabled={index<=0} onClick={onPrevious}><ChevronLeft size={14}/> 이전 항목</button><button className="btn small" disabled={index<0||index>=count-1} onClick={onNext}>다음 항목 <ChevronRight size={14}/></button></div>
    <div ref={body} className="ev-detail-drawer-body">{children}</div></div>
  </dialog>;
}
