/** Runs one read-only query over a company's imported history in a throwaway
 * process. The parent kills it on timeout, so a runaway join cannot block the
 * service. Input arrives on stdin; the database exists only in memory. The seat's
 * domain supplies the tables and any views (our SQL, never the model's). */
import {Database} from 'bun:sqlite';
import {validateHistorySql} from './history-sql.ts';

const input=JSON.parse(await Bun.stdin.text()) as {tables:Record<string,Record<string,unknown>[]>;views?:string[];sql:string;limit:number};
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
for(const view of input.views??[])if(/^\s*CREATE VIEW\s/i.test(view))db.exec(view);
db.exec('PRAGMA query_only=ON');
const statement=db.prepare(validateHistorySql(input.sql));
const columns=statement.columnNames,rows:unknown[]=[];let count=0;
for(const row of statement.iterate() as Iterable<Record<string,unknown>>){count++;if(rows.length<input.limit)rows.push(row);if(count>=input.limit*20)break;}
process.stdout.write(JSON.stringify({columns,rows,row_count:count,truncated:count>rows.length}));
