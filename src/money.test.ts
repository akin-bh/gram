import {test,expect} from 'bun:test';
import {convertMinor,currencyScale,formatMinor,invertRate,MoneyError,mulDiv,normalizeRate,parseMajor,proportionalMinor} from './money.ts';
const rate=(base='EUR',quote='USD',n='11',d='10')=>normalizeRate({base_currency:base,quote_currency:quote,numerator:n,denominator:d});
test('rates normalize exact rationals and respect zero, two and three decimal currencies',()=>{
  expect(rate('EUR','USD','110','100')).toStrictEqual(rate());expect(currencyScale('JPY')).toBe(1);expect(currencyScale('KWD')).toBe(1000);
  expect(convertMinor(10000,rate()).amount_minor).toBe(11000);
  expect(convertMinor(150,rate('JPY','USD','1','150')).amount_minor).toBe(100);
  expect(convertMinor(1234,rate('KWD','USD','13','4')).amount_minor).toBe(401);
  expect(convertMinor(11000,invertRate(rate())).amount_minor).toBe(10000);
});
test('signed half ties and truncation carry exact JSON-safe rounding evidence',()=>{
  for(const sign of [-1,1]){const result=mulDiv(sign,'1','2');expect(result.amount_minor).toBe(sign);expect(result.rounding_delta_minor).toStrictEqual({numerator:String(sign),denominator:'2'});expect(mulDiv(sign,'1','2',{rounding:'toward_zero'}).amount_minor).toBe(0);expect(()=>JSON.stringify(result)).not.toThrow();}
  expect(mulDiv(0,'1','3').rounding_delta_minor.denominator).toBe('1');
  expect(()=>mulDiv(1,'1','2',{max_rounding_loss_minor:{numerator:'49',denominator:'100'}})).toThrowSatisfying((error:any)=>error.code==='rounding_loss_exceeded');
  expect(mulDiv(1,'1','2',{max_rounding_loss_minor:{numerator:'1',denominator:'2'}}).amount_minor).toBe(1);
  expect(()=>mulDiv(1,'1','3',{max_rounding_loss_minor:{numerator:'0',denominator:'1'}})).toThrow(MoneyError);
});
test('major amounts parse and format without floating point or implicit rounding',()=>{
  for(const [value,currency,minor] of [['123.45','USD',12345],['-0.001','KWD',-1],['12','JPY',12],['0.00','EUR',0]] as const){expect(parseMajor(value,currency)).toBe(minor);expect(formatMinor(minor,currency)).toBe(value);}
  for(const value of ['1e2',' 1','01.00','NaN','Infinity','1,000.00','+1'])expect(()=>parseMajor(value,'USD')).toThrow(MoneyError);
  expect(()=>parseMajor('1.001','USD')).toThrow(MoneyError);expect(()=>parseMajor('1.0','JPY')).toThrow(MoneyError);expect(parseMajor('-0','JPY')).toBe(0);
});
test('BigInt intermediate multiplication stays exact near safe storage limits',()=>{
  const amount=Number.MAX_SAFE_INTEGER;expect(mulDiv(amount,'999999999999999999999999999999999999','999999999999999999999999999999999999',{max_abs_minor:amount}).amount_minor).toBe(amount);
  expect(()=>mulDiv(amount,'2','1',{max_abs_minor:amount})).toThrow(MoneyError);expect(()=>mulDiv(amount+1,'1','1')).toThrow(MoneyError);
  expect(()=>convertMinor(1e12,rate())).toThrow(MoneyError);expect(convertMinor(1e12,rate('USD','USD','1','1')).amount_minor).toBe(1e12);
});
test('malformed or unbounded rational inputs reject before arithmetic',()=>{
  for(const n of ['0','-1','1.2','01','1e10','9'.repeat(37)])expect(()=>rate('EUR','USD',n)).toThrow(MoneyError);
  expect(()=>rate('EUR','USD','1','0')).toThrow(MoneyError);expect(()=>rate('USD','USD','2','1')).toThrow(MoneyError);expect(()=>rate('XYZ')).toThrow(MoneyError);
  expect(()=>mulDiv(1,'1','2',{rounding:'bankers' as any})).toThrow(MoneyError);expect(()=>mulDiv(1,'1','2',{max_abs_minor:NaN})).toThrow(MoneyError);
});
test('repeated proportional releases conserve basis and final-drain every cent',()=>{
  let units=7,basis=100;const releases:number[]=[];for(const take of [2,2,2,1]){const released=proportionalMinor(basis,take,units).amount_minor;releases.push(released);basis-=released;units-=take;}
  expect(releases).toStrictEqual([28,28,29,15]);expect(basis).toBe(0);expect(releases.reduce((sum,n)=>sum+n,0)).toBe(100);
  expect(()=>proportionalMinor(100,2,1)).toThrow(MoneyError);expect(()=>proportionalMinor(-1,1,1)).toThrow(MoneyError);
});
