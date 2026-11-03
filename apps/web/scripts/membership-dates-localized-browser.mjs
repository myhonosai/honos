/** Mounted production UI with private synthetic localhost fixtures; never a database/provider proof. */
import assert from 'node:assert/strict';
import { loadMembershipBrowserCopy } from './school-membership-journey-browser.mjs';

export async function runLocalizedDateBrowserChecks({fixture,open,check,visual,origin,setLanguage,report}) {
  const {dateText:t}=await loadMembershipBrowserCopy('membership-dates-copy');
  for(const language of ['en','ko','es'])for(const [mode,viewport] of [['modern',{width:1440,height:1000}],['classic',{width:834,height:1000}],['big',{width:390,height:844}]]) {
    await check(`membership dates: ${language}/${mode} authorized history, inclusive extension, explicit confirmation and localized receipt`,async()=>{
      fixture.reset();setLanguage(language);const {context,page}=await open(viewport);
      try {
        await page.goto(origin+'/staff/billing/membership-dates');await page.waitForFunction(lang=>document.documentElement.lang===lang,language);
        const root=page.locator('[data-membership-dates]'),button=key=>root.getByRole('button',{name:t(language,key),exact:true});
        await root.getByRole('heading',{name:t(language,'Membership dates and history'),exact:true}).waitFor();
        await root.getByRole('combobox',{name:t(language,'Presentation'),exact:true}).selectOption(mode);assert.equal(fixture.reads.length,0);assert.equal(fixture.commands.length,0);
        for(const [label,value] of [['Organization ID',fixture.scope.organizationId],['School ID',fixture.scope.schoolId],['Already-known membership ID',fixture.membershipId]])await root.getByLabel(t(language,label),{exact:true}).fill(value);
        await button('Load membership dates').focus();await page.keyboard.press('Enter');await root.getByRole('heading',{name:t(language,'Verified current membership'),exact:true}).waitFor();
        await button('Extend').click();await page.waitForFunction(()=>document.querySelectorAll('[data-membership-dates] input[type=date]')[1]?.value==='2026-11-30');await root.getByRole('heading',{name:t(language,'Step 1 · Review date change'),exact:true}).waitFor();
        assert.equal(await root.getByLabel(t(language,'Last valid day (inclusive)'),{exact:true}).inputValue(),'2026-11-30');
        assert.equal(await root.getByLabel(t(language,'Start date'),{exact:true}).inputValue(),'2026-10-01');
        const screenshot=async suffix=>{const name=`membership-dates-${language}-${mode}-${suffix}`;await visual(page,name);assert.equal(report.accessibility.findLast(item=>item.name===name)?.violations.length,0);};
        await screenshot('localized-preview');
        await root.getByLabel(t(language,'Reason category'),{exact:true}).selectOption('MEMBER_REQUESTED');
        const reason=language==='ko'?'직원이 학교 현지 날짜와 회원 요청을 검토했습니다.':language==='es'?'El personal verificó las fechas y la solicitud del miembro.':'Staff verified the school-local dates and the member request.';
        await root.getByLabel(t(language,'Reason for this change (10–500 characters)'),{exact:true}).fill(reason);
        await button('Review final date confirmation').focus();await page.keyboard.press('Enter');
        await root.getByRole('heading',{name:t(language,'Step 2 · Confirm date change'),exact:true}).waitFor();assert.equal(fixture.commands.length,0);assert(await button('Confirm membership date change').isDisabled());
        await root.getByRole('checkbox',{name:t(language,'I confirm this exact date change. No payment, invoice, refund, credit, schedule or agreement change is authorized.'),exact:true}).check();
        await button('Confirm membership date change').focus();await page.keyboard.press('Enter');await root.getByRole('heading',{name:t(language,'Membership date revision receipt'),exact:true}).waitFor();
        assert.equal(fixture.commands.length,1);const sent=JSON.parse(fixture.commands[0].raw);assert.equal(sent.reasonText,reason);assert.equal(sent.startDate,'2026-10-01');assert.equal(sent.endDate,'2026-11-30');assert.equal(sent.expectedPeriodVersion,1);await screenshot('localized-receipt');
        await button('Refresh verified current dates and history').click();await root.getByRole('heading',{name:t(language,'Date history · newest first'),exact:true}).waitFor();assert((await root.innerText()).includes(reason));
        assert.equal(fixture.commands.length,1);assert.equal(await root.getByRole('link',{name:t(language,'Attendance'),exact:true}).getAttribute('href'),'/staff/attendance');await screenshot('localized-history');
        if(mode==='big')assert(await button('Load membership dates').evaluate(e=>e.getBoundingClientRect().height>=52));
      } finally {await context.close();setLanguage('en');}
    });
  }
}
