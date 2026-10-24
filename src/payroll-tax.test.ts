import {test} from 'bun:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {calculateFederalPayrollTax,federalPayrollRuleset,payrollPayPeriods,PayrollTaxError,validateFederalW4,validatePriorYtd} from './payroll-tax.ts';
import type {FederalPayrollTaxInput,FederalW4,PriorYtd} from './payroll-tax.ts';

const zeroYtd:PriorYtd={social_security_wages_minor:0,medicare_wages_minor:0,futa_wages_minor:0};
const plainW4:FederalW4={form_year:2026,filing_status:'single_or_married_filing_separately',step2_checked:false,annual_credits_minor:0,other_income_minor:0,deductions_minor:0,extra_withholding_minor:0};
function input(gross=300000):FederalPayrollTaxInput{return {tax_year:2026,jurisdiction:'US-federal',wage_kind:'regular',pay_frequency:'biweekly',gross_wages_minor:gross,federal_taxable_wages_minor:gross,social_security_wages_minor:gross,medicare_wages_minor:gross,futa_wages_minor:gross,w4:{...plainW4},prior_ytd:{...zeroYtd}};}
const fails=(value:any,code:string)=>assert.throws(()=>calculateFederalPayrollTax(value),(e:any)=>e instanceof PayrollTaxError&&e.code===code);
const decimal=(value:string)=>{const cleaned=value.replace(/[$,]/g,'');const [whole,fraction='']=cleaned.split('.');return Number(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')));};

test('every annual withholding bracket is transcribed exactly from the archived official IRS table, including checkbox boundaries',()=>{
  const bytes=readFileSync(new URL('./tax-rules/irs-2026-payroll-source.json',import.meta.url)),source=JSON.parse(bytes.toString()),published=source.worksheet_and_tables.split('2026 Percentage Method Tables for Automated Payroll Systems')[1];assert.ok(published);let status:any;const parsed:any={standard:{},step2_checkbox:{}};
  for(const line of published.split('\n')){
    if(line==='| Married Filing Jointly | Married Filing Jointly |')status='married_filing_jointly';if(line==='| Single or Married Filing Separately | Single or Married Filing Separately |')status='single_or_married_filing_separately';if(line==='| Head of Household | Head of Household |')status='head_of_household';if(!status||!line.startsWith('| $'))continue;
    const columns=line.split('|').slice(1,-1).map((s:string)=>s.trim());if(columns.length!==10)continue;for(const [table,offset] of [['standard',0],['step2_checkbox',5]] as const){parsed[table][status]??=[];parsed[table][status].push({lower_minor:decimal(columns[offset]),base_tax_minor:decimal(columns[offset+2]),rate_bps:Number(columns[offset+3].replace('%',''))*100});}
  }
  assert.deepEqual(federalPayrollRuleset.withholding_tables,parsed);assert.equal(federalPayrollRuleset.source_snapshot_sha256,createHash('sha256').update(bytes).digest('hex'));assert.match(federalPayrollRuleset.ruleset_sha256,/^[0-9a-f]{64}$/);assert.equal(federalPayrollRuleset.futa.state_credit_bps,0);assert.equal(federalPayrollRuleset.sources.length,2);assert.throws(()=>{(federalPayrollRuleset.withholding_tables.standard.married_filing_jointly[0] as any).rate_bps=5000;},TypeError);
});

test('biweekly regular wages follow Worksheet 1A and independent FICA/FUTA cents with an explicit no-credit FUTA rate',()=>{
  const result=calculateFederalPayrollTax(input());assert.equal(result.worksheet_1a.adjusted_annual_wages_minor,6_940_000);assert.equal(result.federal_income_tax_minor,32038);assert.equal(result.employee_social_security_minor,18600);assert.equal(result.employer_social_security_minor,18600);assert.equal(result.employee_medicare_minor,4350);assert.equal(result.employer_medicare_minor,4350);assert.equal(result.employee_additional_medicare_minor,0);assert.equal(result.employer_futa_minor,18000);assert.equal(result.employee_withholding_minor,54988);assert.equal(result.employer_tax_minor,40950);assert.equal(result.net_wages_minor,245012);assert.equal(result.total_tax_liability_minor,95938);assert.deepEqual(result.next_ytd,{social_security_wages_minor:300000,medicare_wages_minor:300000,futa_wages_minor:300000});
  const tentative=result.worksheet_1a.lines.find(line=>line.line==='2h');assert.deepEqual(tentative?.minor,{numerator:'416500',denominator:'13'});assert.equal(result.ruleset.ruleset_sha256,federalPayrollRuleset.ruleset_sha256);assert.doesNotThrow(()=>JSON.stringify(result));
});

test('filing status and Step 2 select their own published schedules rather than approximating a tax bracket',()=>{
  const cases:[FederalW4['filing_status'],boolean,number,number][]=[['married_filing_jointly',false,500000,23667],['married_filing_jointly',true,500000,41833],['head_of_household',false,500000,32900],['single_or_married_filing_separately',true,300000,50335]];
  for(const [status,checked,gross,expected] of cases){const request=input(gross);request.pay_frequency=gross===300000?'biweekly':'monthly';request.w4.filing_status=status;request.w4.step2_checked=checked;const result=calculateFederalPayrollTax(request);assert.equal(result.federal_income_tax_minor,expected);assert.equal(result.worksheet_1a.table,checked?'step2_checkbox':'standard');assert.equal(result.worksheet_1a.filing_status,status);}
});

test('W-4 annual other income, deductions, credits and extra period withholding retain exact worksheet fractions',()=>{
  const request=input();Object.assign(request.w4,{other_income_minor:1200000,deductions_minor:200000,annual_credits_minor:200000,extra_withholding_minor:2500});const result=calculateFederalPayrollTax(request);assert.equal(result.worksheet_1a.adjusted_annual_wages_minor,7940000);assert.equal(result.federal_income_tax_minor,35308);assert.deepEqual(result.worksheet_1a.lines.find(line=>line.line==='3b')?.minor,{numerator:'100000',denominator:'13'});assert.deepEqual(result.worksheet_1a.lines.find(line=>line.line==='4b')?.minor,{numerator:'459000',denominator:'13'});
  request.w4.annual_credits_minor=10_000_000;assert.equal(calculateFederalPayrollTax(request).federal_income_tax_minor,2500);request.w4.annual_credits_minor=0;request.w4.deductions_minor=100_000_000;assert.equal(calculateFederalPayrollTax(request).federal_income_tax_minor,2500);assert.equal(calculateFederalPayrollTax(request).worksheet_1a.adjusted_annual_wages_minor,0);
});

test('annualization follows each explicit IRS Table 3 pay frequency and never assumes biweekly',()=>{
  for(const [frequency,periods] of Object.entries(payrollPayPeriods)){const request=input(200000);request.pay_frequency=frequency as any;request.w4.extra_withholding_minor=17;request.w4.annual_credits_minor=1e10;const result=calculateFederalPayrollTax(request);assert.equal(result.pay_periods_per_year,periods);assert.equal(result.federal_income_tax_minor,17);assert.deepEqual(result.worksheet_1a.lines.find(line=>line.line==='1c')?.minor,{numerator:String(200000*periods),denominator:'1'});}
});

test('social-security and FUTA ceilings cross only remaining source wage bases; Additional Medicare begins within the crossing payment',()=>{
  const request=input(10000);request.pay_frequency='weekly';request.prior_ytd={social_security_wages_minor:18_449_950,medicare_wages_minor:19_999_950,futa_wages_minor:699_950};const result=calculateFederalPayrollTax(request);assert.deepEqual(result.taxable_bases,{social_security_minor:50,medicare_minor:10000,additional_medicare_minor:9950,futa_minor:50});assert.equal(result.employee_social_security_minor,3);assert.equal(result.employee_medicare_minor,145);assert.equal(result.employee_additional_medicare_minor,90);assert.equal(result.employer_futa_minor,3);assert.equal(result.employer_tax_minor,151);assert.equal(result.net_wages_minor,9762);assert.equal(result.federal_income_tax_minor,0);
  request.prior_ytd={social_security_wages_minor:18_450_000,medicare_wages_minor:20_000_000,futa_wages_minor:700_000};const capped=calculateFederalPayrollTax(request);assert.equal(capped.employee_social_security_minor,0);assert.equal(capped.employer_social_security_minor,0);assert.equal(capped.employee_additional_medicare_minor,90);assert.equal(capped.employer_futa_minor,0);assert.equal(capped.employer_tax_minor,145);assert.equal(capped.taxable_bases.additional_medicare_minor,10000);
});

test('source wage bases remain distinct and prior actual payment YTD governs each separate ceiling',()=>{
  const request=input(100000);request.federal_taxable_wages_minor=50000;request.social_security_wages_minor=80000;request.medicare_wages_minor=90000;request.futa_wages_minor=60000;request.prior_ytd={social_security_wages_minor:18_400_000,medicare_wages_minor:20_100_000,futa_wages_minor:680000};const result=calculateFederalPayrollTax(request);assert.equal(result.employee_social_security_minor,3100);assert.equal(result.employee_medicare_minor,1305);assert.equal(result.employee_additional_medicare_minor,810);assert.equal(result.employer_futa_minor,1200);assert.deepEqual(result.next_ytd,{social_security_wages_minor:18_480_000,medicare_wages_minor:20_190_000,futa_wages_minor:740000});assert.equal(request.prior_ytd.social_security_wages_minor,18_400_000);
});

test('half-cent tax values round half up independently and zero wages have no invented taxes',()=>{
  const request=input(50);request.federal_taxable_wages_minor=0;request.social_security_wages_minor=0;request.futa_wages_minor=0;request.prior_ytd.medicare_wages_minor=20_000_000;const result=calculateFederalPayrollTax(request);assert.equal(result.employee_medicare_minor,1);assert.deepEqual(result.tax_components.medicare.exact_minor,{numerator:'29',denominator:'40'});assert.equal(result.employee_additional_medicare_minor,0);assert.deepEqual(result.tax_components.additional_medicare.exact_minor,{numerator:'9',denominator:'20'});
  const exactlyHalf=input(1000);exactlyHalf.federal_taxable_wages_minor=0;exactlyHalf.social_security_wages_minor=0;exactlyHalf.futa_wages_minor=0;const med=calculateFederalPayrollTax(exactlyHalf);assert.equal(med.employee_medicare_minor,15);assert.equal(med.employer_medicare_minor,15);assert.deepEqual(med.tax_components.medicare.exact_minor,{numerator:'29',denominator:'2'});
  const zero=calculateFederalPayrollTax(input(0));assert.equal(zero.net_wages_minor,0);assert.equal(zero.total_tax_liability_minor,0);assert.equal(zero.federal_income_tax_minor,0);
});

test('pure W-4 and YTD validation accepts explicit zeroes and extra withholding without a fake zero-wage calculation',()=>{
  const w4={...plainW4,extra_withholding_minor:1_000_000};assert.deepEqual(validateFederalW4(w4),w4);assert.notEqual(validateFederalW4(w4),w4);assert.deepEqual(validatePriorYtd(zeroYtd),zeroYtd);assert.throws(()=>validateFederalW4({...w4,form_year:2019}),(e:any)=>e.code==='unsupported_w4');assert.throws(()=>validatePriorYtd({social_security_wages_minor:0,medicare_wages_minor:0}),(e:any)=>e.code==='invalid_payroll_tax_input');const request=input(100);request.w4=w4;fails(request,'payroll_tax_exceeds_wages');
});

test('unsupported jurisdictions, years, wage categories, field injections and implicit source assumptions reject explicitly',()=>{
  for(const extra of [{tax_year:2025},{tax_year:2027},{jurisdiction:'US-CA'}])fails({...input(),...extra},'unsupported_payroll_tax_ruleset');fails({...input(),wage_kind:'bonus'},'unsupported_wage_kind');fails({...input(),pay_frequency:'annual'},'unsupported_pay_frequency');fails({...input(),state_credit_bps:540},'invalid_payroll_tax_input');fails({...input(),w4:{...plainW4,exempt:true}},'invalid_payroll_tax_input');fails({...input(),prior_ytd:undefined},'invalid_payroll_tax_input');fails({...input(),w4:{...plainW4,step2_checked:undefined}},'invalid_payroll_tax_input');fails({...input(),w4:{...plainW4,annual_credits_minor:-1}},'invalid_payroll_tax_amount');fails({...input(),gross_wages_minor:0.5},'invalid_payroll_tax_amount');fails({...input(),social_security_wages_minor:300001},'taxable_wages_exceed_gross');fails({...input(),w4:{...plainW4,filing_status:'married'}},'unsupported_filing_status');
});

test('exact arithmetic survives large annualization and refuses next-YTD overflow without mutation',()=>{
  const request=input(1e12);request.pay_frequency='daily';request.prior_ytd={...zeroYtd};request.social_security_wages_minor=0;request.medicare_wages_minor=0;request.futa_wages_minor=0;const copy=structuredClone(request),result=calculateFederalPayrollTax(request);assert.equal(result.worksheet_1a.adjusted_annual_wages_minor,259_999_999_140_000);assert.ok(Number.isSafeInteger(result.federal_income_tax_minor));assert.ok(result.net_wages_minor>0);assert.deepEqual(request,copy);assert.doesNotThrow(()=>JSON.stringify(result));const overflow=input(1);overflow.prior_ytd.social_security_wages_minor=1e12;fails(overflow,'payroll_tax_overflow');
});
