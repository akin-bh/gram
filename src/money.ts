/** Exact bounded monetary arithmetic. Rates are quote major units per base
 * major unit; persisted proofs use decimal strings, never JSON BigInts. */
export const currencyMinorUnits = Object.freeze({USD:2,EUR:2,GBP:2,JPY:0,KWD:3});
export type Currency = keyof typeof currencyMinorUnits;
export type Rational = {numerator:string;denominator:string};
export type FxRate = Rational & {base_currency:Currency;quote_currency:Currency};
export type Rounding = 'half_away_from_zero'|'toward_zero';
export type MoneyOptions = {rounding?:Rounding;max_abs_minor?:number;max_rounding_loss_minor?:Rational};
export type MoneyProof = {amount_minor:number;exact_minor:Rational;rounding_delta_minor:Rational;rounding:Rounding};
export class MoneyError extends Error {constructor(public code:string,message:string){super(message);this.name='MoneyError';}}
const fail=(code:string,message:string):never=>{throw new MoneyError(code,message);};
const abs=(n:bigint)=>n<0n?-n:n;
function gcd(a:bigint,b:bigint):bigint {a=abs(a);b=abs(b);while(b){const next=a%b;a=b;b=next;}return a;}
function fraction(n:bigint,d:bigint):Rational {if(d<=0n)fail('invalid_denominator','Denominator must be positive');const divisor=gcd(n,d);return {numerator:String(n/divisor),denominator:String(d/divisor)};}
function digits(value:unknown,label:string,allowZero=false):bigint {
  if(typeof value!=='string'||value.length>36||!/^(0|[1-9][0-9]*)$/.test(value))fail('invalid_rational',`${label} must be a canonical decimal integer string of at most 36 digits`);
  const n=BigInt(value as string);if(n<0n||(!allowZero&&n===0n))fail('invalid_rational',`${label} must be positive`);return n;
}
function integer(value:number,label:string,min=-Number.MAX_SAFE_INTEGER,max=Number.MAX_SAFE_INTEGER):bigint {if(!Number.isSafeInteger(value)||value<min||value>max)fail('invalid_money_integer',`${label} must be an exact integer in range`);return BigInt(value);}
export function currencyScale(currency:string):number {if(!Object.hasOwn(currencyMinorUnits,currency))fail('unsupported_currency',`Unsupported currency ${currency}`);return 10**currencyMinorUnits[currency as Currency];}
export function normalizeRate(rate:{base_currency:string;quote_currency:string;numerator:string;denominator:string}):FxRate {
  currencyScale(rate.base_currency);currencyScale(rate.quote_currency);
  const n=digits(rate.numerator,'Rate numerator'),d=digits(rate.denominator,'Rate denominator');
  if(rate.base_currency===rate.quote_currency&&n!==d)fail('invalid_fx_rate','A same-currency rate must be exactly one');
  return {base_currency:rate.base_currency as Currency,quote_currency:rate.quote_currency as Currency,...fraction(n,d)};
}
export function invertRate(rate:FxRate):FxRate {const normalized=normalizeRate(rate);return {...normalized,base_currency:normalized.quote_currency,quote_currency:normalized.base_currency,numerator:normalized.denominator,denominator:normalized.numerator};}
function rounded(n:bigint,d:bigint,options:MoneyOptions):MoneyProof {
  const mode=options.rounding??'half_away_from_zero';if(!['half_away_from_zero','toward_zero'].includes(mode))fail('invalid_rounding','Unsupported rounding policy');
  const limit=integer(options.max_abs_minor??1_000_000_000_000,'Maximum amount',0),magnitude=abs(n),q=magnitude/d,r=magnitude%d;
  const value=(n<0n?-1n:1n)*(q+(mode==='half_away_from_zero'&&r*2n>=d?1n:0n));
  if(abs(value)>limit)fail('money_overflow','Converted amount exceeds the supported exact bound');
  const delta=value*d-n;
  if(options.max_rounding_loss_minor){const allowed=options.max_rounding_loss_minor,an=digits(allowed.numerator,'Rounding loss numerator',true),ad=digits(allowed.denominator,'Rounding loss denominator');if(abs(delta)*ad>an*d)fail('rounding_loss_exceeded','Exact rounding loss exceeds the permitted target minor units');}
  return {amount_minor:Number(value),exact_minor:fraction(n,d),rounding_delta_minor:fraction(delta,d),rounding:mode};
}
export function mulDiv(amount:number,numerator:string,denominator:string,options:MoneyOptions={}):MoneyProof {return rounded(integer(amount,'Amount')*digits(numerator,'Multiplier numerator',true),digits(denominator,'Multiplier denominator'),options);}
export function convertMinor(amount:number,rate:FxRate,options:MoneyOptions={}):MoneyProof & {currency:Currency;rate:FxRate} {
  const normalized=normalizeRate(rate),n=integer(amount,'Amount')*BigInt(normalized.numerator)*BigInt(currencyScale(normalized.quote_currency)),d=BigInt(normalized.denominator)*BigInt(currencyScale(normalized.base_currency));
  return {...rounded(n,d,options),currency:normalized.quote_currency,rate:normalized};
}
export function parseMajor(value:string,currency:string,maxAbsMinor=1_000_000_000_000):number {
  const scale=currencyScale(currency),places=currencyMinorUnits[currency as Currency];
  if(typeof value!=='string'||value.length>40||! /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))fail('invalid_money_decimal','Amount must be a plain decimal string');
  const negative=value.startsWith('-'),[whole,decimal='']=(negative?value.slice(1):value).split('.');if(decimal.length>places)fail('invalid_money_precision',`${currency} supports ${places} fractional digits`);
  const amount=(BigInt(whole)*BigInt(scale)+BigInt(decimal.padEnd(places,'0')||'0'))*(negative?-1n:1n),limit=integer(maxAbsMinor,'Maximum amount',0);if(abs(amount)>limit)fail('money_overflow','Amount exceeds the supported exact bound');return Number(amount);
}
export function formatMinor(value:number,currency:string):string {const scale=BigInt(currencyScale(currency)),n=integer(value,'Amount'),magnitude=abs(n),places=currencyMinorUnits[currency as Currency];return `${n<0n?'-':''}${magnitude/scale}${places?'.'+String(magnitude%scale).padStart(places,'0'):''}`;}
/** Release rounded-down proportional basis; releasing all remaining units
 * returns every remaining cent, preventing a stranded carrying balance. */
export function proportionalMinor(totalMinor:number,partUnits:number,totalUnits:number):MoneyProof {
  integer(totalMinor,'Total basis',0);integer(totalUnits,'Total units',1);integer(partUnits,'Released units',0,totalUnits);
  return mulDiv(totalMinor,String(partUnits),String(totalUnits),{rounding:'toward_zero',max_abs_minor:Number.MAX_SAFE_INTEGER});
}
