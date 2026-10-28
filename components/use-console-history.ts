'use client';
import {useCallback,useEffect,useRef} from 'react';
import {compactConsoleRoute,consoleRouteIdentity,consoleRouteSearch,readConsoleRoute,type ConsoleRoute} from '@/lib/console-navigation';

/** History contains IDs and scroll only. Working forms remain in their existing in-memory stores. */
export function useConsoleHistory(ready:boolean,restore:(route:ConsoleRoute,isCurrent:()=>boolean)=>Promise<void>|void){
  const handler=useRef(restore);handler.current=restore;
  const booted=useRef(false),applying=useRef(false),generation=useRef(0);
  const current=useRef<ConsoleRoute>({page:'workflows'});
  const scrollTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const scrollTo=useCallback((top:number)=>{
    clearTimeout(scrollTimer.current);
    scrollTimer.current=setTimeout(()=>window.scrollTo({top,behavior:'instant'}),80);
  },[]);
  const apply=useCallback(async(route:ConsoleRoute,scroll:number)=>{
    const ticket=++generation.current;applying.current=true;current.current=route;
    try{await handler.current(route,()=>ticket===generation.current);}finally{if(ticket===generation.current){applying.current=false;scrollTo(scroll);}}
  },[scrollTo]);
  useEffect(()=>{
    if(!ready||booted.current)return;
    booted.current=true;
    const route=readConsoleRoute(window.location.search);
    window.history.replaceState({...window.history.state,aegisConsole:true,aegisScroll:window.history.state?.aegisScroll??0},'',consoleRouteSearch(route));
    void apply(route,Number(window.history.state?.aegisScroll)||0);
  },[ready,apply]);
  useEffect(()=>{
    const pop=()=>{if(booted.current)void apply(readConsoleRoute(window.location.search),Number(window.history.state?.aegisScroll)||0);};
    const scroll=()=>{if(booted.current&&!applying.current)window.history.replaceState({...window.history.state,aegisConsole:true,aegisScroll:window.scrollY},'');};
    window.addEventListener('popstate',pop);window.addEventListener('scroll',scroll,{passive:true});
    const previous=window.history.scrollRestoration;window.history.scrollRestoration='manual';
    return()=>{booted.current=false;++generation.current;clearTimeout(scrollTimer.current);window.removeEventListener('popstate',pop);window.removeEventListener('scroll',scroll);window.history.scrollRestoration=previous;};
  },[apply]);
  const visit=useCallback((route:ConsoleRoute,replace?:boolean)=>{
    if(!booted.current||applying.current)return;
    const next=compactConsoleRoute(route),search=consoleRouteSearch(next);
    if(search===consoleRouteSearch(current.current))return;
    const replacing=replace??consoleRouteIdentity(next)===consoleRouteIdentity(current.current);
    window.history.replaceState({...window.history.state,aegisConsole:true,aegisScroll:window.scrollY},'');
    window.history[replacing?'replaceState':'pushState']({aegisConsole:true,aegisScroll:replacing?window.scrollY:0},'',search);
    current.current=next;
    if(!replacing)scrollTo(0);
  },[scrollTo]);
  const interrupt=useCallback(()=>{++generation.current;applying.current=false;clearTimeout(scrollTimer.current);},[]);
  return {visit,current,applying,interrupt};
}
