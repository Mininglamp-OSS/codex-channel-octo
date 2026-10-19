import * as api from './octo/api.js'; export function f(x:{a:typeof api},key:string){const y=x as unknown as Record<string,{sendMessage:()=>void}>; y[key]?.sendMessage();}
