(function(){
  // Strings drawn by this script, per page language (the page's own text is translated at build time).
  var L={
    en:{days:["mon","tue","wed","thu","fri","sat"],full:"% full",noClass:"no class",belt:" belt",
      belts:["white","yellow","orange","green","blue","purple","brown","black"],month:" /month",year:" /year",review:"review",read:"read",
      feed:[["chad / sales","Drafted a check-in for a family whose trial ends Friday","review"],["claire / performance","Summed up attendance by program for this month","read"],["marcus / marketing","Drafted a referral post for your Champions Club code","review"],["hon","Summarized what the team drafted today in three lines","read"],["kai / teaching","Suggested drills for students testing for green belt","review"]]},
    ko:{days:["월","화","수","목","금","토"],full:"% 참석",noClass:"수업 없음",belt:"",
      belts:["흰 띠","노란 띠","주황 띠","초록 띠","파란 띠","보라 띠","갈색 띠","검은 띠"],month:" /월",year:" /년",review:"검토",read:"읽음",
      feed:[["chad / 영업","체험이 금요일에 끝나는 가족에게 보낼 안부 메시지 초안","review"],["claire / 성과","이번 달 프로그램별 출석 요약","read"],["marcus / 마케팅","Champions Club 추천 코드 홍보 게시물 초안","review"],["hon","오늘 팀이 작성한 초안을 세 줄로 요약","read"],["kai / 지도","초록 띠 심사를 앞둔 수련생을 위한 훈련 제안","review"]]},
    es:{days:["lun","mar","mié","jue","vie","sáb"],full:"% lleno",noClass:"sin clase",belt:"",
      belts:["cinturón blanco","cinturón amarillo","cinturón naranja","cinturón verde","cinturón azul","cinturón morado","cinturón marrón","cinturón negro"],month:" /mes",year:" /año",review:"revisar",read:"leído",
      feed:[["chad / ventas","Redactó un mensaje para una familia cuya prueba termina el viernes","review"],["claire / rendimiento","Resumió la asistencia por programa de este mes","read"],["marcus / marketing","Redactó una publicación de referidos con tu código de Champions Club","review"],["hon","Resumió en tres líneas lo que el equipo redactó hoy","read"],["kai / enseñanza","Sugirió ejercicios para alumnos que se examinan de cinturón verde","review"]]}
  };
  var t=L[document.documentElement.lang]||L.en;

  // example attendance heatmap
  var times=["16:00","17:00","18:00","19:00","20:00"],days=t.days;
  var v=[[.35,.42,.38,.45,.3,0],[.72,.8,.7,.84,.55,.9],[.95,.88,.97,.9,.62,.78],[.68,.74,.81,.7,.4,0],[.3,.5,.36,.55,.2,0]];
  var h=document.getElementById("heat"),html="<span></span>";
  days.forEach(function(d){html+='<span class="day">'+d+"</span>"});
  times.forEach(function(tm,i){html+='<span class="lbl">'+tm+"</span>";v[i].forEach(function(x,j){
    html+='<span class="c" title="'+(x?Math.round(x*100)+t.full+", "+days[j]+" "+tm:t.noClass)+'" style="background:'+(x?"color-mix(in srgb,var(--accent) "+Math.round(x*100)+"%,rgba(255,255,255,.04))":"rgba(255,255,255,.03)")+'"></span>'})});
  h.innerHTML=html;
  // example rank mix (belt colors are literal)
  var r=[["#f1f1ec",46],["#f2d14b",38],["#f08a3c",31],["#4cae6a",29],["#3d7be0",24],["#8a5cd6",19],["#8b5a3c",14],["#050505",11]];
  var tot=r.reduce(function(a,b){return a+b[1]},0),bar="",leg="";
  r.forEach(function(x,i){var name=t.belts[i];bar+='<span title="'+name+t.belt+": "+x[1]+'" style="width:'+(x[1]/tot*100)+"%;background:"+x[0]+'"></span>';leg+='<div><i style="background:'+x[0]+'"></i>'+name+"<b>"+x[1]+"</b></div>"});
  document.getElementById("ranks").innerHTML=bar;document.getElementById("legend").innerHTML=leg;

  // rotating preview of AI drafts
  var feed=t.feed;
  var log=document.getElementById("log"),k=0;
  var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(!reduce)setInterval(function(){var f=feed[k++%feed.length],row=document.createElement("div");row.className="log-row new";
    row.innerHTML='<span><span class="who">'+f[0]+"</span>"+f[1]+'</span><span class="v'+(f[2]=="read"?" ok":"")+'">'+t[f[2]]+"</span>";
    log.insertBefore(row,log.firstChild);if(log.children.length>4)log.removeChild(log.lastChild)},4200);

  // pricing toggle
  var pb=document.querySelectorAll(".toggle button");
  pb.forEach(function(b){b.addEventListener("click",function(){var p=b.dataset.p;
    pb.forEach(function(o){o.setAttribute("aria-pressed",o===b?"true":"false")});
    document.querySelectorAll(".price").forEach(function(el){el.querySelector(".amt").textContent=el.dataset[p];el.querySelector(".per").textContent=p=="m"?t.month:t.year})})});
})();
