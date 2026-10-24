/** The seam between systems of record and the system of work.
 *
 * The work layer (src/work.ts) knows about work items, transitions, roles, policies,
 * precedents, confidence bars and the gateway. It does not know what a bank receipt,
 * a venue settlement or an invoice is. Everything that does is a SeatDomain: one per
 * seat, registered here, holding the records' shape, the hard checks, the policy rule
 * kinds the gateway can verify, the backtest, the evidence next to an item, the posting
 * the gateway makes, the history the seat learns from, and the answer key that scores it.
 */
import type {z} from 'zod';
import type {Action,Actor,World} from './world.ts';
import type {ProcurementHooks} from './procurement.ts';

/** The world's side effects a domain may use: ids, validation, failures, events, mail,
 * documents, economic effects, journals, and work-item creation. */
export type WorkHooks=Omit<ProcurementHooks,'effect'>&{
  effect:(type:string,targetId:string,amount:number,lines:any[],externalId:string,bankDelta:number)=>any;
  post:(lines:any[],sourceType:string,sourceId:string,description:string)=>any;
  createWork:(item:any)=>any;
};
export type Backtest={covered:number;support:number;contrary:number;support_examples:string[];contrary_examples:string[];outside_examples:string[];note:string;bound:null|{rule:number;unit:'cents'|'bps';largest_supporting:number|null;headroom_pct:number|null}};
export type FollowUp={kind:string;state?:string;title:string;subject_id:string;refs:string[];amount_minor?:number;due_at?:string;reason?:string};
/** What the gateway wrote for an approved item: its id, the journal if any, the records it
 * touched, follow-ups to schedule and follow-ups that this posting settles. */
export type Posting={id:string;journal_id?:string|null;refs:string[];evidence:string[];follow_ups?:FollowUp[];close_follow_ups_for?:string[];follow_up_item_id?:string;[key:string]:any};
/** The domain-neutral shape of a resolution, for precedents, the score and the console:
 * what it puts money on, the treatments it applies, whether it holds cash, what it chases. */
export type ResolutionSummary={allocations:string[];adjustment_kinds:string[];hold_on_account:boolean;chase:string|null};
export type Confidence={score:number;evidence:number;agent:number;basis:{factor:string;score:number;why:string}[]};
export type Coverage={covered:boolean;policies:any[];gaps:string[];[key:string]:any};

export interface SeatDomain{
  kind:string;
  label:string;
  /** Extra general-ledger accounts this seat posts to: [id, name, type]. */
  accounts:[string,string,string][];
  /** Connections the seat must have before the dispatcher starts it, and what each read needs. */
  seatSystems:string[];
  readSystems:{item:string[];history:string[];post:string[]};
  /** World fields the console never receives (imported history, the answer key). */
  hidden:string[];
  /** Work-item kinds the seat may propose on; `follow_up` is handled by the work layer. */
  proposableKinds:string[];
  proposalKind:string;
  defaults:{name:string;count:number;maxCount:number;openingMinor:number;currency:string};
  // Policies: what the gateway can verify.
  ruleSchema:z.ZodTypeAny;
  describeRule(rule:any):string;
  ruleKey(rule:any):string;
  validateRule(w:World,rule:any,h:WorkHooks):void;
  backtest(w:World,rule:any,precedents:any[]):Backtest;
  // Resolutions: hard checks, evidence, coverage, confidence, posting.
  normalize(w:World,item:any,input:any,h:Pick<WorkHooks,'fail'|'find'|'integer'|'text'>):any;
  features(w:World,item:any):any;
  coverage(w:World,item:any,resolution:any,features:any,policies:any[]):Coverage;
  confidence(w:World,item:any,resolution:any,features:any,coverage:Coverage,precedents:any[],agentConfidence:number):Confidence;
  describeResolution(w:World,resolution:any):string[];
  summarizeResolution(resolution:any):ResolutionSummary;
  fingerprint(resolution:any):unknown;
  resolutionRefs(resolution:any):string[];
  post(w:World,item:any,resolution:any,meta:{approved_by:string;approval:'human'|'policy';policies:any[]},h:WorkHooks):Posting;
  /** Reverse a posting a person decided was wrong: a reversing entry, the records put back, the reversal linked to the original. */
  reverse?(w:World,item:any,posting:any,reason:string,actor:Actor,h:WorkHooks):{id:string;journal_id?:string|null;refs:string[];evidence:string[]};
  reminder(w:World,item:any,h:WorkHooks):{message_id:string;follow_up?:FollowUp};
  followUpOpen(w:World,item:any):{open:boolean;reason:string};
  // Precedents and evidence.
  precedentFeatures(w:World,item:any):any;
  precedentMatches(precedent:any,query:{subject_id?:string;counterparty?:string}):boolean;
  similarPrecedents(w:World,item:any,precedents:any[]):any[];
  itemView(w:World,item:any,h:Pick<WorkHooks,'find'>):Record<string,unknown>;
  // History the seat learns from, as read-only SQL.
  historyTables(w:World):Record<string,Record<string,unknown>[]>;
  historyViews:string[];
  historySchema:Record<string,string>;
  historySummary(w:World):{records:number;from:string|null;to:string|null;note:string;[key:string]:any};
  // What the gateway has written.
  postings(w:World):any[];
  postingFor(w:World,item:any):any|undefined;
  postingTouches(posting:any,subject:string):boolean;
  summary(w:World):Record<string,unknown>;
  // Records: delivery, controller facts, seeding.
  normalizeWorld?(w:World):void;
  deliver(w:World,h:WorkHooks):void;
  requirements:Record<string,{role:'controller'|'operator';system:string;external?:boolean}>;
  action(w:World,action:Action,actor:Actor,h:WorkHooks):{handled:boolean;result?:any};
  seed(w:World,count:number,random:()=>number,h:WorkHooks,controls?:any):void;
  validateControls?(input:unknown,fail:(code:string,message:string)=>never):any;
  // The answer key and the people who know it.
  answerKey(w:World):any[];
  caseFor(w:World,item:any):any|undefined;
  caseItem(w:World,entry:any):any|undefined;
  score:{expected(w:World,entry:any):any;posted(w:World,posting:any):any;match(posted:any,expected:any):boolean;correction(entry:any):Record<string,unknown>;proposalMatches(proposal:any,entry:any):boolean};
  // The seat: its prompt and the shape of its tools.
  prompt(company:string):string;
  tools:{item:string;precedents:string;precedentKinds:string[];propose:string;proposeSchema:Record<string,z.ZodTypeAny>;policy:string};
  bench:{days:string[];recordLine(line:any):Action;recordExpectation(line:any,expectation:any):Action};
}

const registry=new Map<string,SeatDomain>();
export function registerDomain(domain:SeatDomain){registry.set(domain.kind,domain);return domain;}
export function domainByKind(kind:string|undefined):SeatDomain|undefined{return kind?registry.get(kind):undefined;}
export function domainFor(w:World):SeatDomain{const domain=domainByKind(w.kind);if(!domain)throw new Error(`No seat domain is registered for ${w.kind}`);return domain;}
export function seatKinds(){return [...registry.keys()];}
export function allDomains(){return [...registry.values()];}
export const dollars=(minor:number)=>`$${(minor/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
