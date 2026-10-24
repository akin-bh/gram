/** Supported path grammar is deliberately explicit: literal segments, whole
 * parameters, and SAP OData integer/string keys. No caller supplies a template. */
type Segment={kind:'literal';text:string}|{kind:'segment'|'integer'|'identifier';name:string;prefix:string;suffix:string};
const safe=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&v!=='.'&&v!=='..'&&!/[\u0000-\u0020\u007f/\\?#%]/.test(v);
function segments(template:string):Segment[]{return template.replace(/\/$/,'').split('/').slice(1).map(text=>{
 let m=/^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);if(m)return {kind:'segment',name:m[1],prefix:'',suffix:''};
 m=/^([A-Za-z][A-Za-z0-9]*)\(':([A-Za-z_][A-Za-z0-9_]*)'\)$/.exec(text);if(m)return {kind:'identifier',name:m[2],prefix:m[1]+"('",suffix:"')"};
 m=/^([A-Za-z][A-Za-z0-9]*)\(:([A-Za-z_][A-Za-z0-9_]*)\)$/.exec(text);if(m)return {kind:'integer',name:m[2],prefix:m[1]+'(',suffix:')'};
 if(text.includes(':'))throw new Error('Unsupported provider path template');return {kind:'literal',text};
});}
function valid(segment:Exclude<Segment,{kind:'literal'}>,value:unknown):value is string{
 if(!safe(value))return false;
 if(segment.kind==='identifier')return /^[A-Za-z0-9_-]+$/.test(value);
 if(segment.kind==='integer')return /^[1-9][0-9]{0,9}$/.test(value)&&Number(value)<=2147483647;
 return true;
}
export function providerPathParameters(template:string){return segments(template).flatMap(segment=>segment.kind==='literal'?[]:[segment.name]);}
export function matchProviderPath(template:string,path:string){
 if(!path.startsWith('/')||path.includes('//')||/[?#\\\u0000-\u001f]/.test(path))return false;
 let actual:string[];try{actual=path.replace(/\/$/,'').split('/').slice(1).map(decodeURIComponent);}catch{return false;}
 const expected=segments(template);if(expected.length!==actual.length)return false;
 return expected.every((segment,index)=>{const value=actual[index];if(segment.kind==='literal')return value===segment.text;
  if(!value.startsWith(segment.prefix)||!value.endsWith(segment.suffix))return false;
  return valid(segment,value.slice(segment.prefix.length,segment.suffix? -segment.suffix.length:undefined));
 });
}
export function formatProviderPath(template:string,values:Record<string,string>){return '/'+segments(template).map(segment=>{
 if(segment.kind==='literal')return segment.text;const value=values[segment.name];
 if(!valid(segment,value))throw Object.assign(new Error(`Invalid or missing provider path parameter: ${segment.name}`),{code:'invalid_provider_parameter'});
 return segment.prefix+encodeURIComponent(value)+segment.suffix;
}).join('/');}
