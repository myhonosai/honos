/** Deterministic no-I/O fake. Test fixture only; never production DI or environment selected. */
class DeterministicScheduleProvider {
  identity='DETERMINISTIC_FAKE'; mode='TEST'; calls=0;
  async inspectSchedule(requirements){
    this.calls++;
    return {identity:this.identity,mode:this.mode,evidenceKind:'DETERMINISTIC_FAKE',outcome:'OBSERVED',
      accountReference:'fake_account',subscriptionReference:'fake_subscription_'+requirements.generationId,
      scheduleReference:'fake_schedule_'+requirements.generationId,requirements:structuredClone(requirements),
      phaseControl:requirements.introductoryPaidPeriods?'VERIFIED_PAID_PERIOD_GATE':'FIXED_PRICE',
      automaticCalendarTransition:false,automaticCollectionEnabled:false};
  }
}
module.exports={DeterministicScheduleProvider};
