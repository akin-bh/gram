/** query_history: the seat learns the job the way a new accountant would, by reading
 * last year's books. Queries are single read-only SELECT statements over an in-memory
 * copy of the imported history, run in a separate process with a hard time limit.
 * The tables and views come from the seat's domain; this module knows only SQL.
 */
import type {World} from './world.ts';
import {domainFor} from './seat-domain.ts';

export class HistoryQueryError extends Error{constructor(public code:string,message:string,public status=400){super(message);this.name='HistoryQueryError';}}
export function validateHistorySql(sql:unknown){
  if(typeof sql!=='string'||sql.trim().length<8||sql.length>4000)throw new HistoryQueryError('invalid_history_query','Provide one SQL SELECT statement of at most 4000 characters.');
  const text=sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,' ').trim().replace(/;\s*$/,'');
  if(!/^(select|with)\b/i.test(text))throw new HistoryQueryError('invalid_history_query','Only SELECT (or WITH … SELECT) queries are allowed.');
  const bare=text.replace(/'(?:''|[^'])*'/g,"''").replace(/"(?:""|[^"])*"/g,'""');
  if(bare.includes(';'))throw new HistoryQueryError('invalid_history_query','Run one statement at a time.');
  if(/\b(attach|detach|vacuum|insert|update|delete|create|drop|alter)\b/i.test(bare))throw new HistoryQueryError('invalid_history_query','The history is read-only.');
  return text;
}
const WORKER=Bun.fileURLToPath(new URL('./history-sql-worker.ts',import.meta.url));
export async function queryHistory(w:World,sql:unknown,options:{limit?:number;timeoutMs?:number}={}){
  const text=validateHistorySql(sql),limit=Math.min(Math.max(options.limit??100,1),200),domain=domainFor(w);
  const process=Bun.spawn({cmd:[Bun.which('bun')??'bun',WORKER],stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{PATH:Bun.env.PATH??''}});
  const timer=setTimeout(()=>process.kill(9),options.timeoutMs??3000);
  try{
    process.stdin.write(JSON.stringify({tables:domain.historyTables(w),views:domain.historyViews,sql:text,limit}));process.stdin.end();
    const [stdout,stderr,code]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited]);
    if(process.signalCode)throw new HistoryQueryError('history_query_timeout','The query ran past its time limit. Narrow it with WHERE clauses or aggregate.',408);
    if(code!==0)throw new HistoryQueryError('history_query_failed',(stderr.match(/(?:SQLiteError|Error): ([^\n]+)/)?.[1]??'The query failed.').slice(0,500));
    return {...JSON.parse(stdout),limit};
  }finally{clearTimeout(timer);}
}
