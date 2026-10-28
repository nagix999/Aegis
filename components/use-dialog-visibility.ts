'use client';
import {useEffect,useRef,type RefObject} from 'react';

/** Native modal dialogs must close when authentication hides their owning page. */
export function useDialogVisibility(dialog:RefObject<HTMLDialogElement|null>,onClose:()=>void){
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const check=()=>{const element=dialog.current;if(element?.open&&element.closest('[hidden],[inert]')){element.close();close.current();}};
    const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['hidden','inert']});check();
    return()=>observer.disconnect();
  },[dialog]);
}
