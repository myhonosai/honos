(function(){
  // offer banner start
  // A promo or referral discount for the banner, e.g. {by:"A partner school",pct:20}.
  // Keep null: no billing path applies promo or referral discounts yet (Champions Club records referrals only),
  // so showing one would promise a discount checkout does not give. Turning it on needs David's decision.
  var OFFER=null;
  var OFFER_TEXT={
    en:"{by} has applied a {pct}% discount on your first year of HON OS.",
    ko:"{by}님이 HON OS 첫해 {pct}% 할인을 적용했습니다.",
    es:"{by} aplicó un descuento del {pct}% en tu primer año de HON OS."
  };
  function offerText(o,lang){
    if(!o||typeof o.by!=="string"||!o.by||!(o.pct>0&&o.pct<100))return null;
    return (OFFER_TEXT[lang]||OFFER_TEXT.en).replace("{pct}",String(o.pct)).replace("{by}",function(){return o.by});
  }
  // offer banner end

  // billing period switch: shows the yearly or monthly prices already on the page
  var sw=document.querySelectorAll(".seg button[data-period]"),plans=document.querySelector(".plans[data-period]");
  sw.forEach(function(b){b.addEventListener("click",function(){
    sw.forEach(function(o){o.setAttribute("aria-pressed",o===b?"true":"false")});
    if(plans)plans.setAttribute("data-period",b.getAttribute("data-period"))})});

  // promo or referral discount: replaces the founder line in the banner when switched on
  var shown=offerText(OFFER,document.documentElement.lang),slot=document.querySelector("[data-offer]");
  if(shown&&slot)slot.textContent=shown;

  // chapter dots: highlight the chapter in view
  var links=document.querySelectorAll("[data-nav] a[href^='#']");
  if(links.length&&"IntersectionObserver" in window){
    var map={};links.forEach(function(a){map[a.getAttribute("href").slice(1)]=a});
    var spy=new IntersectionObserver(function(es){es.forEach(function(e){
      if(!e.isIntersecting)return;
      links.forEach(function(a){a.classList.remove("on")});
      if(map[e.target.id])map[e.target.id].classList.add("on")})},{rootMargin:"-45% 0px -50% 0px"});
    Object.keys(map).forEach(function(id){var el=document.getElementById(id);if(el)spy.observe(el)});
  }
})();
