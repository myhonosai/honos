/** Deterministic no-I/O fake. Test fixture only; never production DI or environment selected. */
const {createHash}=require('node:crypto');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
class DeterministicScheduleProvider {
  identity='DETERMINISTIC_FAKE'; mode='TEST'; calls=0; bindings=new Map();
  async inspectSchedule(requirements){
    this.calls++;
    return {identity:this.identity,mode:this.mode,evidenceKind:'DETERMINISTIC_FAKE',outcome:'OBSERVED',
      accountReference:'fake_account',subscriptionReference:'fake_subscription_'+requirements.generationId,
      scheduleReference:'fake_schedule_'+requirements.generationId,requirements:structuredClone(requirements),
      phaseControl:requirements.introductoryPaidPeriods?'VERIFIED_PAID_PERIOD_GATE':'FIXED_PRICE',
      automaticCalendarTransition:false,automaticCollectionEnabled:false};
  }
  async bindOrFindSchedule({bindingId,bindingKey,requirementsDigest,requirements}){
    this.calls++;
    const existing=this.bindings.get(bindingKey);
    if(existing) return {...existing,outcome:'ALREADY_BOUND'};
    const observation={identity:this.identity,mode:this.mode,outcome:'BOUND',bindingId,bindingKey,
      requirementsDigest,
      accountReference:'fake_account_'+bindingId,subscriptionReference:'fake_subscription_'+bindingId,
      scheduleReference:'fake_schedule_'+bindingId,automaticCalendarTransition:false,automaticCollectionEnabled:false};
    this.bindings.set(bindingKey,observation);return observation;
  }
  async findByBindingKey({bindingId,bindingKey,requirementsDigest}){
    this.calls++;
    const existing=this.bindings.get(bindingKey);
    if(!existing) return {identity:this.identity,mode:this.mode,outcome:'NOT_FOUND',bindingId,bindingKey,requirementsDigest};
    if(existing.requirementsDigest!==requirementsDigest) return {identity:this.identity,mode:this.mode,outcome:'TERMS_MISMATCH',bindingId,bindingKey,requirementsDigest};
    return {...existing,outcome:'ALREADY_BOUND'};
  }
  collected=new Set();
  async cancelUnpaidSchedule({bindingId,accountReference,subscriptionReference,scheduleReference}){
    this.calls++;
    return {identity:this.identity,mode:this.mode,outcome:this.collected.has(bindingId)?'COLLECTED':'CANCELLED_NOTHING_COLLECTED',
      bindingId,accountReference,subscriptionReference,scheduleReference};
  }
  /** 0325: customer balance credits, idempotent on creditKey; failNextCredit simulates a provider outage. */
  balances=new Map(); credits=new Map(); failNextCredit=false;
  async creditCustomerBalance({accountReference,amountMinor,currency,creditKey}){
    this.calls++;
    if(this.failNextCredit){this.failNextCredit=false;throw new Error('network');}
    if(currency!=='USD'||!Number.isInteger(amountMinor)||amountMinor<1) throw new Error('INVALID');
    if(!this.credits.has(creditKey)){this.credits.set(creditKey,amountMinor);this.balances.set(accountReference,(this.balances.get(accountReference)||0)+amountMinor);}
    return {outcome:'CREDITED',creditKey,amountMinor:this.credits.get(creditKey)};
  }
  /** 0341: stop a switched plan's schedule with no proration and no refund; idempotent; failNextStop simulates an outage. */
  stopped=new Set(); failNextStop=false;
  async stopScheduleNoRefund({bindingId,scheduleReference}){
    this.calls++;
    if(this.failNextStop){this.failNextStop=false;throw new Error('network');}
    this.stopped.add(bindingId);
    return {outcome:'STOPPED_NO_REFUND',bindingId,scheduleReference,refundSent:false};
  }
}
module.exports={DeterministicScheduleProvider};
