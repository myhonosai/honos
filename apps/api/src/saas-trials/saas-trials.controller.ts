import { Body,Controller,ForbiddenException,Get,Headers,HttpCode,Param,Post,Req,UseGuards } from '@nestjs/common';
import { SAAS_COMMANDS } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SaasCommandGuard,SaasCommandName,SaasReadGuard } from '../saas-billing/saas-billing.guards.js';
import { SaasTrialsService } from './saas-trials.service.js';
const subject=(req:HonRequest)=>{if(!req.honIdentity)throw new ForbiddenException({code:'SAAS_FORBIDDEN'});return req.honIdentity.externalSubject;};
/** HQ governance only. No public discovery, links, redemption, enrollment or activation routes. */
@Controller('hq/saas/trials')
@UseGuards(HonIdentityGuard)
export class SaasTrialsHqController {
 constructor(private readonly trials:SaasTrialsService){}
 @Get('governance') @UseGuards(SaasReadGuard)
 read(@Req() req:HonRequest){return this.trials.read(subject(req)).then(data=>({data}));}
 @Get('campaigns/:campaignId') @UseGuards(SaasReadGuard)
 campaign(@Req() req:HonRequest,@Param('campaignId') id:string){return this.trials.campaign(subject(req),id).then(data=>({data}));}
 @Get('campaign-versions/:versionId/publication-preview') @UseGuards(SaasReadGuard)
 preview(@Req() req:HonRequest,@Param('versionId') id:string){return this.trials.preview(subject(req),id).then(data=>({data}));}
 @Post('policy-versions') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.proposeTrialPolicy)
 propose(@Req() req:HonRequest,@Body() body:unknown,@Headers('idempotency-key') key:string|undefined){return this.trials.propose(subject(req),body,key).then(data=>({data}));}
 @Post('policy-decisions') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.decideTrialPolicy)
 decide(@Req() req:HonRequest,@Body() body:unknown,@Headers('idempotency-key') key:string|undefined){return this.trials.decide(subject(req),body,key).then(data=>({data}));}
 @Post('campaign-versions') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.draftTrialCampaign)
 draft(@Req() req:HonRequest,@Body() body:unknown,@Headers('idempotency-key') key:string|undefined){return this.trials.draft(subject(req),body,key).then(data=>({data}));}
 @Post('campaigns/:campaignId/publish') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.publishTrialCampaign)
 publish(@Req() req:HonRequest,@Param('campaignId') id:string,@Body() body:unknown,@Headers('idempotency-key') key:string|undefined){return this.trials.publish(subject(req),id,body,key).then(data=>({data}));}
 @Post('campaigns/:campaignId/withdraw') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.withdrawTrialCampaign)
 withdraw(@Req() req:HonRequest,@Param('campaignId') id:string,@Body() body:unknown,@Headers('idempotency-key') key:string|undefined){return this.trials.withdraw(subject(req),id,body,key).then(data=>({data}));}
}
