import { SAAS_HON_OS_OFFER_PUBLISH_APPROVAL, type SaasHonOsOfferKind, type SaasHonOsOfferSetDetail, type SaasHonOsOfferManagementView, type SaasHonOsOfferStopReason } from '@hon/contracts';
import { PricingError, pricingApi, preparePricingRequest, type PricingApi, type PricingReceipt, type PricingRequest } from './pricing-offers-http';
import { blankSet, blankOffer, formFromSet, formInput, formFingerprint, type OfferFields, type OfferSetForm } from './pricing-offers-model';

export type PricingScreen='overview'|'editor'|'preview'|'history';
type Intent={id:string|null;clone:boolean;fresh?:boolean;localKey?:string};
export type PricingState={ status:'loading'|'ready'|'failed';owner:boolean;concealed:boolean;management:SaasHonOsOfferManagementView|null;
  detail:SaasHonOsOfferSetDetail|null;form:OfferSetForm|null;baseline:string;selected:string|null;screen:PricingScreen;busy:boolean;
  pending:PricingRequest|null;error:{code:string;uncertain:boolean}|null;receipt:PricingReceipt|null;review:SaasHonOsOfferSetDetail|null;
  acknowledged:boolean;intent:Intent|null;stale:boolean;localRetained:boolean;localCopies:string[];customerDetail:SaasHonOsOfferSetDetail|null };
type LocalCopy={form:OfferSetForm;baseline:string;detail:SaasHonOsOfferSetDetail|null};
/** Instance lifetime owns command settlement. Read epochs only invalidate reads, never the in-flight command. */
export class PricingController {
  private state:PricingState={status:'loading',owner:false,concealed:false,management:null,detail:null,form:null,baseline:'',selected:null,
    screen:'overview',busy:false,pending:null,error:null,receipt:null,review:null,acknowledged:false,intent:null,stale:false,localRetained:false,localCopies:[],customerDetail:null};
  private listeners=new Set<()=>void>();private alive=true;private readEpoch=0;private command:PricingRequest|null=null;
  private subject:string|undefined;private locals=new Map<string,LocalCopy>();
  constructor(private api:PricingApi=pricingApi) {}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  snapshot=()=>this.state;
  private patch(update:Partial<PricingState>){if(!this.alive)return;this.state={...this.state,...update};this.listeners.forEach(f=>f());}
  dirty=()=>!!this.state.form&&formFingerprint(this.state.form)!==this.state.baseline;
  editable=()=>this.state.status==='ready'&&this.state.owner&&!this.state.concealed&&!this.state.busy&&!this.state.pending&&!this.state.stale
    &&!!this.state.form&&(!this.state.form.setId||this.state.detail?.set.status==='DRAFT');
  private fail(error:unknown){const e=error instanceof PricingError?error:new PricingError('UNAVAILABLE');this.patch({error:{code:e.code,uncertain:e.uncertain},review:null,acknowledged:false,
    ...([401,403].includes(e.status)?{concealed:true}:{} )});}
  start(){this.alive=true;void this.load();}
  destroy(){this.alive=false;++this.readEpoch;this.listeners.clear();}
  conceal=()=>{if(!this.state.management&&!this.state.form&&!this.state.pending)return;++this.readEpoch;
    this.patch({concealed:true,review:null,acknowledged:false,intent:null});};
  async load(restore=false){
    if(this.state.busy)return;const epoch=++this.readEpoch;this.patch({status:'loading',error:null});
    try{
      const access=await this.api.access(this.subject);if(epoch!==this.readEpoch||!this.alive)return;
      this.subject??=access.subject;
      let detail=this.state.detail;const id=this.state.form?.setId;
      if(id)detail=await this.api.detail(id);
      if(epoch!==this.readEpoch||!this.alive)return;
      const changed=!!id&&detail?.set.revision!==this.state.detail?.set.revision||!!id&&detail?.set.status!==this.state.detail?.set.status;
      const fresh=detail&&id&&!this.dirty()&&!this.state.pending;
      this.patch({status:'ready',owner:access.owner,management:access.management,error:null,
        ...(restore?{concealed:false}:{}),...(fresh?{detail,form:formFromSet(detail.set),baseline:formFingerprint(formFromSet(detail.set)),stale:false}:changed?{stale:true}:{} )});
    }catch(e){if(epoch===this.readEpoch){this.patch({status:'failed'});this.fail(e);}}
  }
  navigate=(screen:PricingScreen)=>{this.patch({screen});};
  async previewPublished(){
    if(this.state.busy||this.state.concealed)return;const epoch=++this.readEpoch;this.patch({screen:'preview',customerDetail:null,status:'loading',error:null});
    try{const access=await this.api.access(this.subject);const id=access.management.published?.setId;const detail=id?await this.api.detail(id):null;
      if(epoch!==this.readEpoch||!this.alive)return;
      if(detail&&(detail.set.status!=='PUBLISHED'||detail.set.setId!==id))throw new PricingError('SAAS_OFFER_PREVIEW_CHANGED',409);
      this.patch({status:'ready',owner:access.owner,management:access.management,customerDetail:detail});
    }catch(e){if(epoch===this.readEpoch){this.patch({status:'failed'});this.fail(e);}}
  }
  selectOffer=(key:string)=>{if(this.state.form?.offers.some(o=>o.key===key))this.patch({selected:key});};
  async open(id:string|null,clone=false,fresh=false,localKey?:string){
    if(this.state.busy||this.state.pending||this.state.concealed)return;
    if(this.dirty()){this.patch({intent:{id,clone,fresh,localKey}});return;}
    await this.openNow({id,clone,fresh,localKey});
  }
  private async openNow(intent:Intent){
    const epoch=++this.readEpoch;this.patch({status:'loading',intent:null,review:null,acknowledged:false,error:null});
    try{
      const access=await this.api.access(this.subject);this.subject??=access.subject;
      const detail=intent.id?await this.api.detail(intent.id):null;
      if(epoch!==this.readEpoch||!this.alive)return;
      const original=detail?formFromSet(detail.set,intent.clone):blankSet();
      const copy=!intent.clone&&!intent.fresh?this.locals.get(intent.localKey??intent.id??''):null;
      const form=copy?.form??original,baseline=copy?.baseline??formFingerprint(original);
      const stale=!!copy&&!!detail&&(copy.detail?.set.revision!==detail.set.revision||copy.detail?.set.status!==detail.set.status);
      this.patch({status:'ready',owner:access.owner,management:access.management,detail:intent.clone?null:detail,form,baseline,
        selected:form.offers[0]?.key??null,screen:'editor',stale,localRetained:!!copy,receipt:null});
    }catch(e){if(epoch===this.readEpoch){this.patch({status:'failed'});this.fail(e);}}
  }
  decide=async(choice:'save'|'discard'|'continue')=>{
    const intent=this.state.intent;if(!intent)return;
    if(choice==='continue'){this.patch({intent:null});return;}
    if(this.state.busy||this.state.pending)return;
    if(choice==='save'&&this.state.form)this.locals.set(this.state.form.key,{form:structuredClone(this.state.form),baseline:this.state.baseline,detail:this.state.detail});
    this.patch({intent:null,localCopies:[...this.locals.keys()]});await this.openNow(intent);
  };
  restoreLocal=async(key:string)=>{const copy=this.locals.get(key);if(copy)await this.open(copy.form.setId,false,false,key);};
  editSet=(field:'termsReference'|'founderTotalLimit',value:string)=>{if(!this.editable())return;this.patch({form:{...this.state.form!,[field]:value},review:null,acknowledged:false,receipt:null,error:null});};
  editOffer=(field:Exclude<keyof OfferFields,'key'|'offerKind'>,value:string)=>{
    if(!this.editable())return;const form=this.state.form!;
    this.patch({form:{...form,offers:form.offers.map(o=>o.key===this.state.selected?{...o,[field]:value}:o)},review:null,acknowledged:false,receipt:null,error:null});
  };
  addOffer=(kind:SaasHonOsOfferKind)=>{if(!this.editable()||this.state.form!.offers.length>=12)return;
    const form=this.state.form!,offer=blankOffer(kind,form.offers);this.patch({form:{...form,offers:[...form.offers,offer]},selected:offer.key,review:null,acknowledged:false,error:null});};
  removeOffer=()=>{if(!this.editable())return;const form=this.state.form!,offers=form.offers.filter(o=>o.key!==this.state.selected);
    this.patch({form:{...form,offers},selected:offers[0]?.key??null,review:null,acknowledged:false,error:null});};
  async save(){
    if(!this.editable())return;
    try{const form=this.state.form!,input=formInput(form);await this.run(preparePricingRequest(form.setId?'revise':'create',form.setId,input,crypto.randomUUID(),this.subject!));}
    catch(e){this.fail(e instanceof PricingError?e:new PricingError('INVALID_SAAS_INPUT'));}
  }
  async review(){
    if(!this.editable()||this.dirty()||!this.state.detail)return;
    const epoch=++this.readEpoch;const previous=this.state.detail;this.patch({status:'loading',error:null,review:null,acknowledged:false});
    try{
      const access=await this.api.access(this.subject);const detail=await this.api.detail(previous.set.setId);
      if(epoch!==this.readEpoch||!this.alive)return;
      this.patch({status:'ready',owner:access.owner,management:access.management});
      if(detail.set.status!=='DRAFT'||detail.set.revision!==previous.set.revision||detail.preview.previewDigest!==previous.preview.previewDigest){this.patch({stale:true});throw new PricingError('SAAS_OFFER_PREVIEW_CHANGED',422);}
      this.patch({detail,review:detail});
    }catch(e){if(epoch===this.readEpoch){this.patch({status:'ready'});this.fail(e);}}
  }
  acknowledge=(value:boolean)=>{if(this.state.review&&!this.dirty()&&!this.state.pending)this.patch({acknowledged:value});};
  async publish(){
    const {review,acknowledged}=this.state;
    if(!this.editable()||this.dirty()||!review?.preview.ready||!acknowledged)return;
    await this.run(preparePricingRequest('publish',review.set.setId,{expectedRevision:review.set.revision,previewDigest:review.preview.previewDigest,
      approval:SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},crypto.randomUUID(),this.subject!));
  }
  async discard(){
    const d=this.state.detail;if(!this.editable()||this.dirty()||!d)return;
    await this.run(preparePricingRequest('discard',d.set.setId,{expectedRevision:d.set.revision},crypto.randomUUID(),this.subject!));
  }
  async stop(offerId:string,reason:SaasHonOsOfferStopReason){
    const s=this.state;if(s.busy||s.pending||s.concealed||!s.owner||s.status!=='ready'||s.detail?.set.status!=='PUBLISHED'
      ||!s.detail.set.offers.some(o=>o.offerId===offerId&&o.salesStop===null))return;
    await this.run(preparePricingRequest('stop',offerId,{reasonCode:reason},crypto.randomUUID(),this.subject!));
  }
  retry=async()=>{if(this.state.pending&&!this.state.busy&&!this.state.concealed)await this.run(this.state.pending,true);};
  async abandon(){
    if(this.state.busy)return;if(this.state.form)this.locals.delete(this.state.form.key);this.patch({localCopies:[...this.locals.keys()],pending:null,error:null,form:null,detail:null,baseline:'',review:null,acknowledged:false,receipt:null,stale:false,screen:'overview'});
    await this.load();
  }
  private async run(request:PricingRequest,retry=false){
    if(this.command||this.state.concealed||(!retry&&this.state.pending))return;
    this.command=request;this.patch({busy:true,pending:request,error:null,review:null,acknowledged:false,receipt:null});
    try{
      const result=await this.api.send(request,retry);if(!this.alive||this.command!==request)return;
      this.patch({pending:null,receipt:result});
      if(result.kind!=='stop'){
        const form=formFromSet(result.data.set);if(this.state.form)this.locals.delete(this.state.form.key);this.locals.delete(form.key);
        this.patch({form,baseline:formFingerprint(form),selected:form.offers[0]?.key??null,
          detail:'preview' in result.data?{set:result.data.set,preview:result.data.preview}:null,stale:false,localCopies:[...this.locals.keys()],localRetained:false});
      }
      // Current facts are a separate read; a failed refresh never erases a verified command receipt.
      try{
        const access=await this.api.access(this.subject);const id=result.kind==='stop'?this.state.form?.setId:result.data.set.setId;
        const detail=id?await this.api.detail(id):null;
        if(this.alive&&this.command===request){const form=detail?formFromSet(detail.set):null;this.patch({management:access.management,owner:access.owner,...(detail&&form?{detail,form,baseline:formFingerprint(form),selected:form.offers[0]?.key??null}:{} )});}
      }catch(e){if(this.alive&&this.command===request){this.patch({stale:true});this.fail(e);}}
    }catch(e){if(this.alive&&this.command===request){this.fail(e);if(e instanceof PricingError&&['SAAS_VERSION_CONFLICT','SAAS_OFFER_PREVIEW_CHANGED','SAAS_OFFER_SET_NOT_DRAFT'].includes(e.code))this.patch({stale:true});}}
    finally{if(this.alive&&this.command===request){this.command=null;this.patch({busy:false});}}
  }
}
