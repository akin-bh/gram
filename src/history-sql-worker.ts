/** Runs one read-only query over a company's imported AR history in a throwaway
 * process. The parent kills it on timeout, so a runaway join cannot block the
 * service. Input arrives on stdin; the database exists only in memory. */
import {Database} from 'bun:sqlite';
import {validateHistorySql} from './history-sql.ts';

const input=JSON.parse(await Bun.stdin.text()) as {tables:Record<string,Record<string,unknown>[]>;sql:string;limit:number};
const db=new Database(':memory:',{strict:true});
const identifier=(name:string)=>{if(!/^[a-z_][a-z0-9_]{0,63}$/.test(name))throw new Error(`Invalid identifier ${name}`);return name;};
for(const [table,rows] of Object.entries(input.tables)){
  const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))].map(identifier);
  if(!columns.length)continue;
  const types=columns.map(column=>rows.some(row=>row[column]!==null&&row[column]!==undefined&&typeof row[column]!=='number')?'TEXT':'INTEGER');
  db.exec(`CREATE TABLE ${identifier(table)} (${columns.map((column,index)=>`${column} ${types[index]}`).join(', ')})`);
  const insert=db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(column=>`$${column}`).join(', ')})`);
  db.transaction(()=>{for(const row of rows)insert.run(Object.fromEntries(columns.map(column=>[column,row[column]===undefined?null:typeof row[column]==='object'&&row[column]!==null?JSON.stringify(row[column]):row[column] as any])));})();
}
db.exec(`CREATE VIEW applied_lines AS
  SELECT r.id AS receipt_id, r.bank_reference, r.posted_at, r.channel, r.payer_name, r.memo, r.amount_minor AS receipt_amount_minor,
    a.invoice_id, i.customer_id, i.customer_name, i.amount_minor AS invoice_amount_minor, i.issued_at AS invoice_issued_at,
    CAST(julianday(r.posted_at) - julianday(i.issued_at) AS INTEGER) AS days_after_invoice,
    a.applied_minor, a.adjustment_minor, a.adjustment_account, a.applied_by, a.note, a.source
  FROM applications a JOIN receipts r ON r.id = a.receipt_id LEFT JOIN invoices i ON i.id = a.invoice_id`);
db.exec('PRAGMA query_only=ON');
const statement=db.prepare(validateHistorySql(input.sql));
const columns=statement.columnNames,rows:unknown[]=[];let count=0;
for(const row of statement.iterate() as Iterable<Record<string,unknown>>){count++;if(rows.length<input.limit)rows.push(row);if(count>=input.limit*20)break;}
process.stdout.write(JSON.stringify({columns,rows,row_count:count,truncated:count>rows.length}));
