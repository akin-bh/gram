import {test,expect} from 'bun:test';
import {calculateFederalPayrollTax,federalPayrollRuleset,payrollPayPeriods,PayrollTaxError,validateFederalW4,validatePriorYtd} from './payroll-tax.ts';
import type {FederalPayrollTaxInput,FederalW4,PriorYtd} from './payroll-tax.ts';

const zeroYtd:PriorYtd={social_security_wages_minor:0,medicare_wages_minor:0,futa_wages_minor:0};
const plainW4:FederalW4={form_year:2026,filing_status:'single_or_married_filing_separately',step2_checked:false,annual_credits_minor:0,other_income_minor:0,deductions_minor:0,extra_withholding_minor:0};
function input(gross=300000):FederalPayrollTaxInput{return {tax_year:2026,jurisdiction:'US-federal',wage_kind:'regular',pay_frequency:'biweekly',gross_wages_minor:gross,federal_taxable_wages_minor:gross,social_security_wages_minor:gross,medicare_wages_minor:gross,futa_wages_minor:gross,w4:{...plainW4},prior_ytd:{...zeroYtd}};}
const fails=(value:any,code:string)=>expect(()=>calculateFederalPayrollTax(value)).toThrowSatisfying((e:any)=>e instanceof PayrollTaxError&&e.code===code);
const decimal=(value:string)=>{const cleaned=value.replace(/[$,]/g,'');const [whole,fraction='']=cleaned.split('.');return Number(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')));};

test('every annual withholding bracket is transcribed exactly from the archived official IRS table, including checkbox boundaries',async()=>{
  const bytes=await Bun.file(new URL('./tax-rules/irs-2026-payroll-source.json',import.meta.url)).bytes(),source=JSON.parse(new TextDecoder().decode(bytes)),published=source.worksheet_and_tables.split('2026 Percentage Method Tables for Automated Payroll Systems')[1];expect(published).toBeTruthy();let status:any;const parsed:any={standard:{},step2_checkbox:{}};
  for(const line of published.split('\n')){
    if(line==='| Married Filing Jointly | Married Filing Jointly |')status='married_filing_jointly';if(line==='| Single or Married Filing Separately | Single or Married Filing Separately |')status='single_or_married_filing_separately';if(line==='| Head of Household | Head of Household |')status='head_of_household';if(!status||!line.startsWith('| $'))continue;
    const columns=line.split('|').slice(1,-1).map((s:string)=>s.trim());if(columns.length!==10)continue;for(const [table,offset] of [['standard',0],['step2_checkbox',5]] as const){parsed[table][status]??=[];parsed[table][status].push({lower_minor:decimal(columns[offset]),base_tax_minor:decimal(columns[offset+2]),rate_bps:Number(columns[offset+3].replace('%',''))*100});}
  }
  expect(federalPayrollRuleset.withholding_tables).toStrictEqual(parsed);expect(federalPayrollRuleset.source_snapshot_sha256).toBe(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));expect(federalPayrollRuleset.ruleset_sha256).toMatch(/^[0-9a-f]{64}$/);expect(federalPayrollRuleset.futa.state_credit_bps).toBe(0);expect(federalPayrollRuleset.sources.length).toBe(2);expect(()=>{(federalPayrollRuleset.withholding_tables.standard.married_filing_jointly[0] as any).rate_bps=5000;}).toThrow(TypeError);
});

test('biweekly regular wages follow Worksheet 1A and independent FICA/FUTA cents with an explicit no-credit FUTA rate',()=>{
  const result=calculateFederalPayrollTax(input());expect(result.worksheet_1a.adjusted_annual_wages_minor).toBe(6_940_000);expect(result.federal_income_tax_minor).toBe(32038);expect(result.employee_social_security_minor).toBe(18600);expect(result.employer_social_security_minor).toBe(18600);expect(result.employee_medicare_minor).toBe(4350);expect(result.employer_medicare_minor).toBe(4350);expect(result.employee_additional_medicare_minor).toBe(0);expect(result.employer_futa_minor).toBe(18000);expect(result.employee_withholding_minor).toBe(54988);expect(result.employer_tax_minor).toBe(40950);expect(result.net_wages_minor).toBe(245012);expect(result.total_tax_liability_minor).toBe(95938);expect(result.next_ytd).toStrictEqual({social_security_wages_minor:300000,medicare_wages_minor:300000,futa_wages_minor:300000});
  const tentative=result.worksheet_1a.lines.find(line=>line.line==='2h');expect(tentative?.minor).toStrictEqual({numerator:'416500',denominator:'13'});expect(result.ruleset.ruleset_sha256).toBe(federalPayrollRuleset.ruleset_sha256);expect(()=>JSON.stringify(result)).not.toThrow();
});

test('filing status and Step 2 select their own published schedules rather than approximating a tax bracket',()=>{
  const cases:[FederalW4['filing_status'],boolean,number,number][]=[['married_filing_jointly',false,500000,23667],['married_filing_jointly',true,500000,41833],['head_of_household',false,500000,32900],['single_or_married_filing_separately',true,300000,50335]];
  for(const [status,checked,gross,expected] of cases){const request=input(gross);request.pay_frequency=gross===300000?'biweekly':'monthly';request.w4.filing_status=status;request.w4.step2_checked=checked;const result=calculateFederalPayrollTax(request);expect(result.federal_income_tax_minor).toBe(expected);expect(result.worksheet_1a.table).toBe(checked?'step2_checkbox':'standard');expect(result.worksheet_1a.filing_status).toBe(status);}
});

test('W-4 annual other income, deductions, credits and extra period withholding retain exact worksheet fractions',()=>{
  const request=input();Object.assign(request.w4,{other_income_minor:1200000,deductions_minor:200000,annual_credits_minor:200000,extra_withholding_minor:2500});const result=calculateFederalPayrollTax(request);expect(result.worksheet_1a.adjusted_annual_wages_minor).toBe(7940000);expect(result.federal_income_tax_minor).toBe(35308);expect(result.worksheet_1a.lines.find(line=>line.line==='3b')?.minor).toStrictEqual({numerator:'100000',denominator:'13'});expect(result.worksheet_1a.lines.find(line=>line.line==='4b')?.minor).toStrictEqual({numerator:'459000',denominator:'13'});
  request.w4.annual_credits_minor=10_000_000;expect(calculateFederalPayrollTax(request).federal_income_tax_minor).toBe(2500);request.w4.annual_credits_minor=0;request.w4.deductions_minor=100_000_000;expect(calculateFederalPayrollTax(request).federal_income_tax_minor).toBe(2500);expect(calculateFederalPayrollTax(request).worksheet_1a.adjusted_annual_wages_minor).toBe(0);
});

test('annualization follows each explicit IRS Table 3 pay frequency and never assumes biweekly',()=>{
  for(const [frequency,periods] of Object.entries(payrollPayPeriods)){const request=input(200000);request.pay_frequency=frequency as any;request.w4.extra_withholding_minor=17;request.w4.annual_credits_minor=1e10;const result=calculateFederalPayrollTax(request);expect(result.pay_periods_per_year).toBe(periods);expect(result.federal_income_tax_minor).toBe(17);expect(result.worksheet_1a.lines.find(line=>line.line==='1c')?.minor).toStrictEqual({numerator:String(200000*periods),denominator:'1'});}
});

test('social-security and FUTA ceilings cross only remaining source wage bases; Additional Medicare begins within the crossing payment',()=>{
  const request=input(10000);request.pay_frequency='weekly';request.prior_ytd={social_security_wages_minor:18_449_950,medicare_wages_minor:19_999_950,futa_wages_minor:699_950};const result=calculateFederalPayrollTax(request);expect(result.taxable_bases).toStrictEqual({social_security_minor:50,medicare_minor:10000,additional_medicare_minor:9950,futa_minor:50});expect(result.employee_social_security_minor).toBe(3);expect(result.employee_medicare_minor).toBe(145);expect(result.employee_additional_medicare_minor).toBe(90);expect(result.employer_futa_minor).toBe(3);expect(result.employer_tax_minor).toBe(151);expect(result.net_wages_minor).toBe(9762);expect(result.federal_income_tax_minor).toBe(0);
  request.prior_ytd={social_security_wages_minor:18_450_000,medicare_wages_minor:20_000_000,futa_wages_minor:700_000};const capped=calculateFederalPayrollTax(request);expect(capped.employee_social_security_minor).toBe(0);expect(capped.employer_social_security_minor).toBe(0);expect(capped.employee_additional_medicare_minor).toBe(90);expect(capped.employer_futa_minor).toBe(0);expect(capped.employer_tax_minor).toBe(145);expect(capped.taxable_bases.additional_medicare_minor).toBe(10000);
});

test('source wage bases remain distinct and prior actual payment YTD governs each separate ceiling',()=>{
  const request=input(100000);request.federal_taxable_wages_minor=50000;request.social_security_wages_minor=80000;request.medicare_wages_minor=90000;request.futa_wages_minor=60000;request.prior_ytd={social_security_wages_minor:18_400_000,medicare_wages_minor:20_100_000,futa_wages_minor:680000};const result=calculateFederalPayrollTax(request);expect(result.employee_social_security_minor).toBe(3100);expect(result.employee_medicare_minor).toBe(1305);expect(result.employee_additional_medicare_minor).toBe(810);expect(result.employer_futa_minor).toBe(1200);expect(result.next_ytd).toStrictEqual({social_security_wages_minor:18_480_000,medicare_wages_minor:20_190_000,futa_wages_minor:740000});expect(request.prior_ytd.social_security_wages_minor).toBe(18_400_000);
});

test('half-cent tax values round half up independently and zero wages have no invented taxes',()=>{
  const request=input(50);request.federal_taxable_wages_minor=0;request.social_security_wages_minor=0;request.futa_wages_minor=0;request.prior_ytd.medicare_wages_minor=20_000_000;const result=calculateFederalPayrollTax(request);expect(result.employee_medicare_minor).toBe(1);expect(result.tax_components.medicare.exact_minor).toStrictEqual({numerator:'29',denominator:'40'});expect(result.employee_additional_medicare_minor).toBe(0);expect(result.tax_components.additional_medicare.exact_minor).toStrictEqual({numerator:'9',denominator:'20'});
  const exactlyHalf=input(1000);exactlyHalf.federal_taxable_wages_minor=0;exactlyHalf.social_security_wages_minor=0;exactlyHalf.futa_wages_minor=0;const med=calculateFederalPayrollTax(exactlyHalf);expect(med.employee_medicare_minor).toBe(15);expect(med.employer_medicare_minor).toBe(15);expect(med.tax_components.medicare.exact_minor).toStrictEqual({numerator:'29',denominator:'2'});
  const zero=calculateFederalPayrollTax(input(0));expect(zero.net_wages_minor).toBe(0);expect(zero.total_tax_liability_minor).toBe(0);expect(zero.federal_income_tax_minor).toBe(0);
});

test('pure W-4 and YTD validation accepts explicit zeroes and extra withholding without a fake zero-wage calculation',()=>{
  const w4={...plainW4,extra_withholding_minor:1_000_000};expect(validateFederalW4(w4)).toStrictEqual(w4);expect(validateFederalW4(w4)).not.toBe(w4);expect(validatePriorYtd(zeroYtd)).toStrictEqual(zeroYtd);expect(()=>validateFederalW4({...w4,form_year:2019})).toThrowSatisfying((e:any)=>e.code==='unsupported_w4');expect(()=>validatePriorYtd({social_security_wages_minor:0,medicare_wages_minor:0})).toThrowSatisfying((e:any)=>e.code==='invalid_payroll_tax_input');const request=input(100);request.w4=w4;fails(request,'payroll_tax_exceeds_wages');
});

test('unsupported jurisdictions, years, wage categories, field injections and implicit source assumptions reject explicitly',()=>{
  for(const extra of [{tax_year:2025},{tax_year:2027},{jurisdiction:'US-CA'}])fails({...input(),...extra},'unsupported_payroll_tax_ruleset');fails({...input(),wage_kind:'bonus'},'unsupported_wage_kind');fails({...input(),pay_frequency:'annual'},'unsupported_pay_frequency');fails({...input(),state_credit_bps:540},'invalid_payroll_tax_input');fails({...input(),w4:{...plainW4,exempt:true}},'invalid_payroll_tax_input');fails({...input(),prior_ytd:undefined},'invalid_payroll_tax_input');fails({...input(),w4:{...plainW4,step2_checked:undefined}},'invalid_payroll_tax_input');fails({...input(),w4:{...plainW4,annual_credits_minor:-1}},'invalid_payroll_tax_amount');fails({...input(),gross_wages_minor:0.5},'invalid_payroll_tax_amount');fails({...input(),social_security_wages_minor:300001},'taxable_wages_exceed_gross');fails({...input(),w4:{...plainW4,filing_status:'married'}},'unsupported_filing_status');
});

test('exact arithmetic survives large annualization and refuses next-YTD overflow without mutation',()=>{
  const request=input(1e12);request.pay_frequency='daily';request.prior_ytd={...zeroYtd};request.social_security_wages_minor=0;request.medicare_wages_minor=0;request.futa_wages_minor=0;const copy=structuredClone(request),result=calculateFederalPayrollTax(request);expect(result.worksheet_1a.adjusted_annual_wages_minor).toBe(259_999_999_140_000);expect(Number.isSafeInteger(result.federal_income_tax_minor)).toBeTruthy();expect(result.net_wages_minor>0).toBeTruthy();expect(request).toStrictEqual(copy);expect(()=>JSON.stringify(result)).not.toThrow();const overflow=input(1);overflow.prior_ytd.social_security_wages_minor=1e12;fails(overflow,'payroll_tax_overflow');
});
