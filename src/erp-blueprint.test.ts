import {test,expect} from 'bun:test';
import {createWorld} from './world.ts';
import {validateBlueprint} from './blueprint.ts';
import {erpNativeKey} from './erp-identities.ts';
const opening='2026-10-24T09:00:00.000Z';
const blueprint={version:1,opening_at:opening,erp_configurations:[{ref:'sap',system:'sap-b1'}],journal_registers:[{ref:'general',accounting_system:'sage-intacct',code:'GJ',name:'General'}],vendors:[{ref:'bank',name:'Treasury',email:'billing@treasury.test'}],service_contracts:[{ref:'contract',counterparty_kind:'vendor',counterparty_ref:'bank',amount_minor:12525,description:'Completed treasury services',signed_at:opening}],service_bills:[{ref:'bill',contract_ref:'contract',invoice_number:'T-1',amount_minor:12525,issued_at:opening,due_at:opening,service_completed_at:opening,completion_reference:'complete'}]};
test('typed ERP configuration sources generate portable registers, native keys and real unchanged source liabilities',()=>{
 const input={kind:'saas-collections',name:'Close',seed:1,startingCashMinor:2000000,cancelEvent:false,blueprint:blueprint as any};
 const a=createWorld(input,'world-a'),b=createWorld(input,'world-b');
 expect(a.erpConfigurations).toHaveLength(1);expect(a.manualJournalRegisters).toHaveLength(1);expect(a.bills[0].amount_minor).toBe(12525);expect(a.bills[0].amount_paid_minor).toBe(0);expect(a.manualJournals).toHaveLength(0);
 expect(a.erpIdentityRegistry).toEqual(b.erpIdentityRegistry);expect(a.blueprintManifest).toEqual(b.blueprintManifest);
 expect(erpNativeKey(a,'PurchaseInvoices','bills',a.bills[0].id)).toBe(1);
 expect(a.generationHistory[0].action.type).toBe('configure_erp');expect(a.generationHistory[1].action.type).toBe('record_journal_register');
 expect(a.blueprintManifest.refs.sap.id).toBe(a.erpConfigurations[0].id);expect(a.blueprintManifest.refs.general.id).toBe(a.manualJournalRegisters[0].id);
 expect(a.accounts.find(x=>x.id==='cash-bank').balance_minor).toBe(2000000);expect(a.accounts.find(x=>x.id==='payables').balance_minor).toBe(-12525);
});
test('unsupported or duplicate ERP source configuration fails before any saved-world fallback',()=>{
 expect(()=>validateBlueprint({...blueprint,erp_configurations:[{ref:'sap',system:'unrecognized'}]})).toThrow();
 expect(()=>validateBlueprint({...blueprint,journal_registers:[{ref:'bank',accounting_system:'sage-intacct',code:'GJ',name:'General'}]})).toThrow();
 expect(()=>createWorld({kind:'saas-collections',startingCashMinor:0,blueprint:{...blueprint,journal_registers:[...blueprint.journal_registers,{ref:'duplicate',accounting_system:'sage-intacct',code:'GJ',name:'Second'}]} as any})).toThrow();
 const old=validateBlueprint({version:1,opening_at:opening,vendors:blueprint.vendors});expect(Object.hasOwn(old,'erp_configurations')).toBe(false);expect(Object.hasOwn(old,'journal_registers')).toBe(false);
});
