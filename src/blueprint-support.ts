import {z} from 'zod';
import type {Action,Actor} from './world.ts';

export const blueprintRef=z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const blueprintName=z.string().trim().min(1).max(120);
export const blueprintTimestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value&&Number(value.slice(0,4))>=2000&&Number(value.slice(0,4))<=2100,'Use an exact UTC timestamp in years 2000–2100');

/** Source modules share the constructor's reference and evidence budgets. */
export type BlueprintValidationHooks={
  openingAt:string;asOf:string;
  add:(row:{ref:string},kind:string,line?:boolean)=>void;
  countLines:(count:number)=>void;
  use:(ref:string,kind:string,path:string)=>any;
  fail:(code:string,message:string,details?:unknown)=>never;
};

/** Only actual domain actions may materialize a source. Scheduled callbacks
 * run at their declared simulation time, never by changing World.now directly. */
export type BlueprintMaterializationHooks={
  openingAt:string;asOf:string;operator:Actor;reviewer:Actor;
  id:(ref:string)=>string;
  bind:(ref:string,row:any,kind:string)=>any;
  source:(ref:string,action:Action)=>any;
  perform:(ref:string,action:Action,actor?:Actor)=>any;
  schedule:(at:string,ref:string,run:()=>void,priority?:number)=>void;
};
