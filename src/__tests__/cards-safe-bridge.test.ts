import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { ReducedItemFacts } from '../cards/redact.js';
let runs: Record<string,unknown>[][]=[];
vi.mock('@openai/codex-sdk',()=>({Codex:class {
  startThread(){return {async runStreamed(){const events=runs.shift()??[];return {events:(async function*(){yield* events;})()};}};}
  resumeThread(){return this.startThread();}
}}));
import { queryAgentEvents,summarizeItem } from '../agent-bridge.js';
import { reduceItem,safeNotice } from '../cards/redact.js';
import corpus from '../cards/__fixtures__/privacy-corpus.v1.json' with { type: 'json' };
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'wp05-'));runs=[];});
afterEach(()=>{rmSync(dir,{recursive:true,force:true});vi.restoreAllMocks();});
function cfg():Config {return {baseDir:dir,cwd:dir,cwdBase:dir,dataDir:dir,apiUrl:'https://example.com',botToken:'synthetic',sdk:{},rateLimit:{maxPerMinute:5},context:{maxContextChars:6000,historyLimit:40},maxResponseChars:524288,dispatchTimeoutMs:300000} as Config;}
const done={type:'turn.completed',usage:{}};
async function drain(onSafeItem?: (facts:ReducedItemFacts)=>void, legacy?: (name:string,input?:unknown)=>void){
  const out=[];for await(const e of queryAgentEvents('synthetic request',cfg(),undefined,legacy,undefined,onSafeItem))out.push(e);return out;
}
describe('WP-05 safe callback / legacy byte compatibility',()=>{
 it('start/completion cadence including completion-only files, activity only on start; events unchanged',async()=>{
  const command={id:'a',type:'command_execution',command:'TOKEN='+corpus.canary+' git '+corpus.canary,status:'completed',exit_code:0};
  const sequence=[{type:'item.started',item:command},{type:'item.updated',item:command},{type:'item.completed',item:command},
    {type:'item.completed',item:{id:'b',type:'file_change',changes:[{path:corpus.canary}],status:'completed'}},
    {type:'item.started',item:{id:'c',type:'reasoning',text:corpus.canary}},
    {type:'item.completed',item:{id:'c',type:'reasoning',text:corpus.canary}},
    {type:'item.started',item:{id:'d',type:'todo_list',items:[]}},
    {type:'item.completed',item:{id:'e',type:'agent_message',text:'final exact text'}},done];
  runs=[sequence,sequence]; const facts:ReducedItemFacts[]=[];
  const withSafe=await drain(f=>facts.push(f));const without=await drain();
  expect(withSafe).toEqual(without);
  expect(facts.map(safeNotice)).toEqual(['🔧 Running command…','🔧 Running command…','🔧 Editing files…','🔧 Thinking…','🔧 Planning…']);
  expect(JSON.stringify(facts).includes(corpus.canary)).toBe(false);
 });
 it('legacy exported summaries/assertions remain exact while safe callback omits detail',async()=>{
  const items=[{id:'a',type:'command_execution' as const,command:'/usr/bin/git --force',aggregated_output:'SECRET',status:'completed' as const},
    {id:'b',type:'file_change' as const,changes:[{path:'/tmp/keys.ts',kind:'update' as const}],status:'completed' as const},
    {id:'c',type:'mcp_tool_call' as const,server:'server',tool:'tool',arguments:{},result:{content:[],structured_content:null},status:'completed' as const},
    {id:'d',type:'web_search' as const,query:'legacy query'}];
  runs=[[...items.map(item=>({type:'item.completed',item})),done]];
  const legacy=vi.fn();const safe=vi.fn();await drain(safe,legacy);
  expect(legacy.mock.calls).toEqual([['command','git'],['file_change','keys.ts'],['mcp_tool_call','server.tool'],['web_search','legacy query']]);
  expect(items.map(summarizeItem)).toEqual([{name:'command',detail:'git'},{name:'file_change',detail:'keys.ts'},{name:'mcp_tool_call',detail:'server.tool'},{name:'web_search',detail:'legacy query'}]);
  expect(safe.mock.calls.map(c=>safeNotice(c[0]))).toEqual(['🔧 Running command…','🔧 Editing files…','🔧 Tool…','🔧 Searching…']);
 });
 it('safe sink exception cannot expose its error or change answer/events',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  runs=[[{type:'item.completed',item:{id:'a',type:'command_execution',command:'git',status:'completed'}},
    {type:'item.completed',item:{id:'b',type:'agent_message',text:'final exact text'}},done]];
  const out=await drain(()=>{throw new Error(corpus.canary);});
  expect(out.some(e=>e.kind==='message'&&e.text==='final exact text')).toBe(true);
  expect(log).toHaveBeenCalledWith('[codex-channel-octo] safe progress callback failed');
  expect(JSON.stringify(log.mock.calls).includes(corpus.canary)).toBe(false);
 });
 it('all recognized corpus items produce immutable reduced facts; no legacy sink needed',async()=>{
  const items=corpus.cases.filter(c=>['command_execution','file_change','web_search','mcp_tool_call'].includes(c.item.type));
  runs=[[...items.map((c,i)=>({type:'item.completed',item:{...c.item,id:String(i)}})),done]];
  const facts:ReducedItemFacts[]=[];await drain(f=>facts.push(f));
  expect(facts).toEqual(items.map(c=>reduceItem(c.item)));
  for(const f of facts){expect(Object.isFrozen(f)).toBe(true);for(const c of items)for(const marker of c.forbidden)expect(JSON.stringify(f).includes(marker)).toBe(false);}
 });
});
