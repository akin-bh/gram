/** query_history: the seat learns the job the way a new accountant would, by reading
 * last year's books. Queries are single read-only SELECT statements over an in-memory
 * copy of the imported history, run in a separate process with a hard time limit.
 */
import type {World} from './world.ts';
import {historyTables} from './cash-application.ts';

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
export const HISTORY_SCHEMA={
  customers:'id, name, segment, email, net_days, discount_bps, discount_days, customer_since',
  invoices:'id, customer_id, customer_name, amount_minor, keg_deposit_minor, issued_at, due_at, status, source',
  receipts:'id, bank_reference, posted_at, amount_minor, currency, channel (ach|wire|check), payer_name, memo, source',
  applications:'id, receipt_id, invoice_id (null when not applied), applied_minor, adjustment_minor, adjustment_account, applied_by, applied_at, note, source',
  keg_returns:'id, customer_id, kegs, deposit_minor, returned_at, reference, source',
  gl_accounts:'id, code, name, type',
  applied_lines:'view: receipt_id, bank_reference, posted_at, channel, payer_name, memo, receipt_amount_minor, invoice_id, customer_id, customer_name, invoice_amount_minor, invoice_issued_at, days_after_invoice, applied_minor, adjustment_minor, adjustment_account, applied_by, note, source',
  notes:'Money is integer USD cents. source is history (imported) or live. One receipt can have several application rows; a short-pay closed by policy has adjustment_minor and adjustment_account on the row for that invoice.',
};
const WORKER=Bun.fileURLToPath(new URL('./history-sql-worker.ts',import.meta.url));
export async function queryHistory(w:World,sql:unknown,options:{limit?:number;timeoutMs?:number}={}){
  const text=validateHistorySql(sql),limit=Math.min(Math.max(options.limit??100,1),200);
  const process=Bun.spawn({cmd:[Bun.which('bun')??'bun',WORKER],stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{PATH:Bun.env.PATH??''}});
  const timer=setTimeout(()=>process.kill(9),options.timeoutMs??3000);
  try{
    process.stdin.write(JSON.stringify({tables:historyTables(w),sql:text,limit}));process.stdin.end();
    const [stdout,stderr,code]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited]);
    if(process.signalCode)throw new HistoryQueryError('history_query_timeout','The query ran past its time limit. Narrow it with WHERE clauses or aggregate.',408);
    if(code!==0)throw new HistoryQueryError('history_query_failed',(stderr.match(/(?:SQLiteError|Error): ([^\n]+)/)?.[1]??'The query failed.').slice(0,500));
    return {...JSON.parse(stdout),limit};
  }finally{clearTimeout(timer);}
}
