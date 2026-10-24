import {z} from 'zod';
import {DomainError,type World} from './world.ts';
import {blueprintRef as ref,blueprintName as name,blueprintTimestamp as timestamp} from './blueprint-support.ts';
import type {BlueprintValidationHooks,BlueprintMaterializationHooks} from './blueprint-support.ts';

const quantity=z.number().int().min(1).max(1_000_000);
const allocation=z.object({receipt_ref:ref,po_line_ref:ref,quantity}).strict();
const disposalBase={ref,asset_ref:ref,reason:z.string().trim().min(1).max(2000)};
/** These sources name existing procurement evidence. Cost, depreciation,
 * approvals, native IDs and settlement status are never model-supplied fields. */
export const assetBlueprintShape={
  asset_policies:z.array(z.object({ref,name,useful_life_months:z.number().int().min(1).max(600),salvage_bps:z.number().int().min(0).max(9999)}).strict()).max(100).optional(),
  asset_acquisitions:z.array(z.object({ref,name,policy_ref:ref,supplier_invoice_ref:ref,allocations:z.array(allocation).min(1).max(50)}).strict()).max(100).optional(),
  asset_capitalizations:z.array(z.object({ref,acquisition_ref:ref,capitalized_at:timestamp,in_service_at:timestamp.optional()}).strict()).max(100).optional(),
  asset_disposal_terms:z.array(z.discriminatedUnion('kind',[
    z.object({...disposalBase,kind:z.literal('sale'),buyer_ref:ref,proceeds_minor:z.number().int().min(1).max(1e12)}).strict(),
    z.object({...disposalBase,kind:z.literal('retirement'),proceeds_minor:z.literal(0)}).strict(),
  ])).max(100).optional(),
};
const assetSchema=z.object(assetBlueprintShape).strict();
export type AssetBlueprint=z.infer<typeof assetSchema>;
type PurchaseSource={
  ref:string;approval:string;
  lines:{ref:string;item_ref:string;quantity:number;unit_price_minor:number}[];
  receipts:{ref:string;lines:{line_ref:string;quantity:number}[]}[];
  invoices:{ref:string;lines:{line_ref:string;quantity:number;unit_price_minor:number}[]}[];
};
type AssetInput=AssetBlueprint&{
  purchase_orders?:PurchaseSource[];
  service_contracts?:{ref:string;counterparty_kind:string;counterparty_ref:string;signed_at:string}[];
};
const tuple=(...parts:string[])=>JSON.stringify(parts);

export function registerBlueprintAssetRefs(input:AssetInput,h:BlueprintValidationHooks){
  for(const row of input.asset_policies??[])h.add(row,'asset_policy');
  for(const row of input.asset_acquisitions??[]){h.add(row,'asset_acquisition');h.countLines(row.allocations.length);}
  for(const row of input.asset_capitalizations??[])h.add(row,'asset');
  for(const row of input.asset_disposal_terms??[])h.add(row,'asset_disposal_authority');
}

/** Preflight topology and cumulative source quantities; actual matching remains
 * the authority for FIFO receipt allocation, price and recognized liability. */
export function validateBlueprintAssets(input:AssetInput,h:BlueprintValidationHooks){
  const orders=input.purchase_orders??[],receiptUse=new Map<string,bigint>(),invoiceUse=new Map<string,bigint>();
  for(const row of input.asset_acquisitions??[]){
    h.use(row.policy_ref,'asset_policy',`${row.ref}.policy_ref`);
    const invoice=h.use(row.supplier_invoice_ref,'supplier_invoice',`${row.ref}.supplier_invoice_ref`);
    const order=orders.find(po=>po.invoices.some(source=>source.ref===row.supplier_invoice_ref));
    if(!order||order.approval!=='approved')h.fail('invalid_blueprint_asset_source','Asset acquisition requires a supplier invoice on an independently approved purchase order',{ref:row.ref});
    const seen=new Set<string>();let value=0n;
    for(const source of row.allocations){
      const receipt=h.use(source.receipt_ref,'receipt',`${row.ref}.allocations.receipt_ref`);
      h.use(source.po_line_ref,'po_line',`${row.ref}.allocations.po_line_ref`);
      const key=tuple(source.receipt_ref,source.po_line_ref);
      if(seen.has(key))h.fail('duplicate_blueprint_asset_allocation','An acquisition may name each receipt line only once',{ref:row.ref,receipt_ref:source.receipt_ref,po_line_ref:source.po_line_ref});
      seen.add(key);
      const line=order!.lines.find(line=>line.ref===source.po_line_ref);
      if(!line||!order!.receipts.some(record=>record.ref===source.receipt_ref))h.fail('invalid_blueprint_asset_source','Asset invoice, receipt and line must belong to the same purchase order',{ref:row.ref,receipt_ref:source.receipt_ref,po_line_ref:source.po_line_ref});
      const received=receipt.lines.filter((item:any)=>item.line_ref===source.po_line_ref);
      const invoiced=invoice.lines.filter((item:any)=>item.line_ref===source.po_line_ref);
      if(received.length!==1||invoiced.length!==1)h.fail('invalid_blueprint_asset_source','Asset allocation requires one matching line in both the receipt and supplier invoice',{ref:row.ref,po_line_ref:source.po_line_ref});
      const used=(receiptUse.get(key)??0n)+BigInt(source.quantity),invoiceKey=tuple(row.supplier_invoice_ref,source.po_line_ref),billed=(invoiceUse.get(invoiceKey)??0n)+BigInt(source.quantity);
      if(used>BigInt(received[0].quantity)||billed>BigInt(invoiced[0].quantity))h.fail('blueprint_asset_source_exceeded','Cumulative asset allocations exceed their receipt or supplier invoice quantity',{ref:row.ref,receipt_ref:source.receipt_ref,po_line_ref:source.po_line_ref});
      receiptUse.set(key,used);invoiceUse.set(invoiceKey,billed);
      value+=BigInt(source.quantity)*BigInt(line!.unit_price_minor);
    }
    if(value<1n||value>1_000_000_000_000n)h.fail('blueprint_asset_value_exceeded','An asset acquisition must have source cost in 1..1000000000000 USD cents',{ref:row.ref});
  }
  const capitalized=new Set<string>();
  for(const row of input.asset_capitalizations??[]){
    h.use(row.acquisition_ref,'asset_acquisition',`${row.ref}.acquisition_ref`);
    if(capitalized.has(row.acquisition_ref))h.fail('duplicate_blueprint_asset_capitalization','An acquisition may create only one historical asset',{ref:row.ref,acquisition_ref:row.acquisition_ref});
    capitalized.add(row.acquisition_ref);
    if(row.capitalized_at<h.openingAt||row.capitalized_at>h.asOf||row.in_service_at!==undefined&&(row.in_service_at<row.capitalized_at||row.in_service_at>h.asOf))h.fail('invalid_blueprint_asset_time','Asset history requires opening <= capitalization <= service <= as_of',{ref:row.ref});
  }
  const disposalClaims=new Set<string>();
  for(const row of input.asset_disposal_terms??[]){
    h.use(row.asset_ref,'asset',`${row.ref}.asset_ref`);
    if(disposalClaims.has(row.asset_ref))h.fail('duplicate_blueprint_asset_disposal','Only one initial disposal authority may claim an asset',{ref:row.ref,asset_ref:row.asset_ref});
    disposalClaims.add(row.asset_ref);
    if(row.kind==='sale'){
      h.use(row.buyer_ref,'customer',`${row.ref}.buyer_ref`);
      if(!(input.service_contracts??[]).some(contract=>contract.counterparty_kind==='customer'&&contract.counterparty_ref===row.buyer_ref&&contract.signed_at<=h.asOf))h.fail('blueprint_asset_buyer_authority_required','Asset sale terms require the existing buyer and a signed customer contract',{ref:row.ref,buyer_ref:row.buyer_ref});
    }
  }
}

function sourceError(code:string,message:string):never{throw new DomainError(400,code,message);}
export function materializeBlueprintAssets(w:World,input:AssetInput,h:BlueprintMaterializationHooks){
  for(const row of input.asset_policies??[]){
    const result=h.source(row.ref,{type:'record_asset_policy',name:row.name,useful_life_months:row.useful_life_months,salvage_bps:row.salvage_bps});
    h.bind(row.ref,result.policy,'asset_policy');
  }
  const matched=new Map<string,string>();
  for(const row of input.asset_acquisitions??[]){
    let billId=matched.get(row.supplier_invoice_ref);
    if(!billId){
      const result=h.perform(row.ref,{type:'match_supplier_invoice',supplier_invoice_id:h.id(row.supplier_invoice_ref)},h.operator);
      if(result.status!=='matched'||!result.bill?.id)sourceError('blueprint_asset_invoice_unmatched',`Asset acquisition ${row.ref} requires its supplier invoice to match actual approved receipt evidence`);
      billId=result.bill.id;matched.set(row.supplier_invoice_ref,billId!);
    }
    const allocations=row.allocations.map(source=>{
      const receipt=w.goodsReceipts.find((record:any)=>record.id===h.id(source.receipt_ref));
      const lines=receipt?.lines.filter((line:any)=>line.po_line_id===h.id(source.po_line_ref));
      if(!lines||lines.length!==1)sourceError('blueprint_asset_receipt_missing',`Asset acquisition ${row.ref} has no unique canonical receipt line`);
      return {receipt_line_id:lines[0].id,quantity:source.quantity};
    });
    const result=h.source(row.ref,{type:'authorize_asset_acquisition',name:row.name,bill_id:billId,policy_id:h.id(row.policy_ref),allocations});
    h.bind(row.ref,result.authorization,'asset_acquisition');
  }
  for(const row of input.asset_capitalizations??[]){
    h.schedule(row.capitalized_at,row.ref,()=>{
      if(w.now!==row.capitalized_at)sourceError('blueprint_asset_clock_mismatch','Historical capitalization must execute at its declared time');
      const result=h.perform(row.ref,{type:'capitalize_asset',authorization_id:h.id(row.acquisition_ref)},h.operator);
      h.bind(row.ref,result.asset,'asset');
    },30);
    if(row.in_service_at!==undefined)h.schedule(row.in_service_at,row.ref,()=>{
      if(w.now!==row.in_service_at)sourceError('blueprint_asset_clock_mismatch','Historical service must execute at its declared time');
      h.source(row.ref,{type:'place_asset_in_service',asset_id:h.id(row.ref),in_service_at:row.in_service_at});
    },40);
  }
}

/** Terms are a present controller mandate. Review, physical completion, book
 * disposal and customer collection remain separate future domain transitions. */
export function materializeBlueprintAssetDisposalTerms(w:World,input:AssetInput,h:BlueprintMaterializationHooks){
  if((input.asset_disposal_terms??[]).length&&w.now!==h.asOf)sourceError('blueprint_asset_clock_mismatch','Disposal terms must be recorded at the final as_of time');
  for(const row of input.asset_disposal_terms??[]){
    const result=h.source(row.ref,{type:'authorize_asset_disposal',asset_id:h.id(row.asset_ref),kind:row.kind,proceeds_minor:row.proceeds_minor,reason:row.reason,...(row.kind==='sale'?{buyer_id:h.id(row.buyer_ref)}:{})});
    h.bind(row.ref,result.authorization,'asset_disposal_authority');
  }
}
