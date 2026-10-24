import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {convertMinor,currencyScale,formatMinor,invertRate,MoneyError,mulDiv,normalizeRate,parseMajor,proportionalMinor} from './money.ts';
const rate=(base='EUR',quote='USD',n='11',d='10')=>normalizeRate({base_currency:base,quote_currency:quote,numerator:n,denominator:d});
test('rates normalize exact rationals and respect zero, two and three decimal currencies',()=>{
  assert.deepEqual(rate('EUR','USD','110','100'),rate());assert.equal(currencyScale('JPY'),1);assert.equal(currencyScale('KWD'),1000);
  assert.equal(convertMinor(10000,rate()).amount_minor,11000);
  assert.equal(convertMinor(150,rate('JPY','USD','1','150')).amount_minor,100);
  assert.equal(convertMinor(1234,rate('KWD','USD','13','4')).amount_minor,401);
  assert.equal(convertMinor(11000,invertRate(rate())).amount_minor,10000);
});
test('signed half ties and truncation carry exact JSON-safe rounding evidence',()=>{
  for(const sign of [-1,1]){const result=mulDiv(sign,'1','2');assert.equal(result.amount_minor,sign);assert.deepEqual(result.rounding_delta_minor,{numerator:String(sign),denominator:'2'});assert.equal(mulDiv(sign,'1','2',{rounding:'toward_zero'}).amount_minor,0);assert.doesNotThrow(()=>JSON.stringify(result));}
  assert.equal(mulDiv(0,'1','3').rounding_delta_minor.denominator,'1');
  assert.throws(()=>mulDiv(1,'1','2',{max_rounding_loss_minor:{numerator:'49',denominator:'100'}}),(error:any)=>error.code==='rounding_loss_exceeded');
  assert.equal(mulDiv(1,'1','2',{max_rounding_loss_minor:{numerator:'1',denominator:'2'}}).amount_minor,1);
  assert.throws(()=>mulDiv(1,'1','3',{max_rounding_loss_minor:{numerator:'0',denominator:'1'}}),MoneyError);
});
test('major amounts parse and format without floating point or implicit rounding',()=>{
  for(const [value,currency,minor] of [['123.45','USD',12345],['-0.001','KWD',-1],['12','JPY',12],['0.00','EUR',0]] as const){assert.equal(parseMajor(value,currency),minor);assert.equal(formatMinor(minor,currency),value);}
  for(const value of ['1e2',' 1','01.00','NaN','Infinity','1,000.00','+1'])assert.throws(()=>parseMajor(value,'USD'),MoneyError);
  assert.throws(()=>parseMajor('1.001','USD'),MoneyError);assert.throws(()=>parseMajor('1.0','JPY'),MoneyError);assert.equal(parseMajor('-0','JPY'),0);
});
test('BigInt intermediate multiplication stays exact near safe storage limits',()=>{
  const amount=Number.MAX_SAFE_INTEGER;assert.equal(mulDiv(amount,'999999999999999999999999999999999999','999999999999999999999999999999999999',{max_abs_minor:amount}).amount_minor,amount);
  assert.throws(()=>mulDiv(amount,'2','1',{max_abs_minor:amount}),MoneyError);assert.throws(()=>mulDiv(amount+1,'1','1'),MoneyError);
  assert.throws(()=>convertMinor(1e12,rate()),MoneyError);assert.equal(convertMinor(1e12,rate('USD','USD','1','1')).amount_minor,1e12);
});
test('malformed or unbounded rational inputs reject before arithmetic',()=>{
  for(const n of ['0','-1','1.2','01','1e10','9'.repeat(37)])assert.throws(()=>rate('EUR','USD',n),MoneyError);
  assert.throws(()=>rate('EUR','USD','1','0'),MoneyError);assert.throws(()=>rate('USD','USD','2','1'),MoneyError);assert.throws(()=>rate('XYZ'),MoneyError);
  assert.throws(()=>mulDiv(1,'1','2',{rounding:'bankers' as any}),MoneyError);assert.throws(()=>mulDiv(1,'1','2',{max_abs_minor:NaN}),MoneyError);
});
test('repeated proportional releases conserve basis and final-drain every cent',()=>{
  let units=7,basis=100;const releases:number[]=[];for(const take of [2,2,2,1]){const released=proportionalMinor(basis,take,units).amount_minor;releases.push(released);basis-=released;units-=take;}
  assert.deepEqual(releases,[28,28,29,15]);assert.equal(basis,0);assert.equal(releases.reduce((sum,n)=>sum+n,0),100);
  assert.throws(()=>proportionalMinor(100,2,1),MoneyError);assert.throws(()=>proportionalMinor(-1,1,1),MoneyError);
});
