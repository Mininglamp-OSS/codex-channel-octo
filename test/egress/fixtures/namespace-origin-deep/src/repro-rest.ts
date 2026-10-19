import * as api from './octo/api.js';
export function f(x:{a:typeof api}){const {...rest}=x as unknown as Record<string,unknown>; const y=rest as unknown as {a:{sendMessage:()=>void}}; y.a.sendMessage();}
