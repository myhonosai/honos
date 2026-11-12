(function(){
  // example attendance heatmap
  var times=["16:00","17:00","18:00","19:00","20:00"],days=["mon","tue","wed","thu","fri","sat"];
  var v=[[.35,.42,.38,.45,.3,0],[.72,.8,.7,.84,.55,.9],[.95,.88,.97,.9,.62,.78],[.68,.74,.81,.7,.4,0],[.3,.5,.36,.55,.2,0]];
  var h=document.getElementById("heat"),html="<span></span>";
  days.forEach(function(d){html+='<span class="day">'+d+"</span>"});
  times.forEach(function(t,i){html+='<span class="lbl">'+t+"</span>";v[i].forEach(function(x,j){
    html+='<span class="c" title="'+(x?Math.round(x*100)+"% full, "+days[j]+" "+t:"no class")+'" style="background:'+(x?"color-mix(in srgb,var(--accent) "+Math.round(x*100)+"%,rgba(255,255,255,.04))":"rgba(255,255,255,.03)")+'"></span>'})});
  h.innerHTML=html;
  // example rank mix (belt colors are literal)
  var r=[["white","#f1f1ec",46],["yellow","#f2d14b",38],["orange","#f08a3c",31],["green","#4cae6a",29],["blue","#3d7be0",24],["purple","#8a5cd6",19],["brown","#8b5a3c",14],["black","#050505",11]];
  var tot=r.reduce(function(a,b){return a+b[2]},0),bar="",leg="";
  r.forEach(function(x){bar+='<span title="'+x[0]+" belt: "+x[2]+'" style="width:'+(x[2]/tot*100)+"%;background:"+x[1]+'"></span>';leg+='<div><i style="background:'+x[1]+'"></i>'+x[0]+"<b>"+x[2]+"</b></div>"});
  document.getElementById("ranks").innerHTML=bar;document.getElementById("legend").innerHTML=leg;

  // rotating preview of AI drafts
  var feed=[["chad / sales","Drafted a check-in for a family whose trial ends Friday","review"],["claire / performance","Summed up attendance by program for this month","read"],["marcus / marketing","Drafted a referral post for your Champions Club code","review"],["hon","Summarized what the team drafted today in three lines","read"],["kai / teaching","Suggested drills for students testing for green belt","review"]];
  var log=document.getElementById("log"),k=0;
  var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(!reduce)setInterval(function(){var f=feed[k++%feed.length],row=document.createElement("div");row.className="log-row new";
    row.innerHTML='<span><span class="who">'+f[0]+"</span>"+f[1]+'</span><span class="v'+(f[2]=="read"?" ok":"")+'">'+f[2]+"</span>";
    log.insertBefore(row,log.firstChild);if(log.children.length>4)log.removeChild(log.lastChild)},4200);

  // pricing toggle
  var pb=document.querySelectorAll(".toggle button");
  pb.forEach(function(b){b.addEventListener("click",function(){var p=b.dataset.p;
    pb.forEach(function(o){o.setAttribute("aria-pressed",o===b?"true":"false")});
    document.querySelectorAll(".price").forEach(function(el){el.querySelector(".amt").textContent=el.dataset[p];el.querySelector(".per").textContent=p=="m"?" /month":" /year"})})});

})();
