import {test,expect} from 'bun:test';
import {agentActionSchema,createNativeProviderRequester} from './agent.ts';
import {providerContracts} from './provider-contracts.ts';

test('Xero native calls derive tenant authority from the host and preserve pending native status',async()=>{
 const operation=providerContracts.find(row=>row.system==='xero'&&row.method==='PUT'&&row.access==='write')!;
 expect(operation).toBeDefined();
 const requests:RequestInit[]=[],events:any[]=[];
 const request=createNativeProviderRequester({worldId:'world-current',baseUrl:'http://127.0.0.1:9123',token:'host-only',onEvent:e=>{events.push(e);},transport:(async(_url:any,init:any)=>{requests.push(init);return Response.json({ManualJournals:[{Status:'DRAFT',finance_world:{status:'awaiting_approval'}}]},{status:202});}) as typeof fetch});
 const result=JSON.parse((await request({operation_id:operation.id,idempotency_key:'source-journal-1',body:{ManualJournals:[{}]}})).content[0]!.text);
 expect(new Headers(requests[0]!.headers).get('Xero-Tenant-Id')).toBe('world-current');
 expect(result.status).toBe(202);expect(result.body.ManualJournals[0].Status).toBe('DRAFT');
 expect(JSON.stringify(events)).not.toContain('host-only');
 const denied=await request({operation_id:operation.id,idempotency_key:'source-journal-1',headers:{'Xero-Tenant-Id':'world-foreign'}} as any);
 expect(denied.isError).toBe(true);expect(requests).toHaveLength(1);
});

test('SDK manual journal tools require source evidence and cannot claim controller authority',()=>{
 const draft={type:'prepare_manual_journal',description:'Recorded expense reclassification',source_document_ids:['source-a'],lines:[{account_id:'expenses',debit_minor:100},{account_id:'revenue',credit_minor:100}],submit:true};
 expect(agentActionSchema.safeParse(draft).success).toBe(true);
 for(const input of [{...draft,source_document_ids:[]},{...draft,approved:true},{...draft,lines:[{...draft.lines[0],override:true},draft.lines[1]]},{type:'approve_manual_journal',manual_journal_id:'journal-a'},{type:'submit_manual_journal',manual_journal_id:'journal-a',version:'invented'}])expect(agentActionSchema.safeParse(input).success).toBe(false);
 expect(agentActionSchema.safeParse({type:'submit_manual_journal',manual_journal_id:'journal-a',version:'a'.repeat(64)}).success).toBe(true);
});
