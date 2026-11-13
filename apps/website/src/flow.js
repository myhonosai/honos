/* Scroll-driven strand field: a bundle of luminous threads that twist like a belt in motion.
   Each keyframe is a cubic Bezier spine (viewport units) + spread, pinch strength, pinch position. */
(function(){
  var c=document.getElementById("flow"),x=c.getContext("2d");
  if(!x)return;
  var K=[
    [1.15,-0.10, 0.52,0.02, 0.20,0.98, 1.12,1.02, .40,.94,.50], // hero: bright knot
    [0.78,-0.12, 1.12,0.38, 0.30,0.66, 0.96,1.14, .24,.45,.52], // agents: tall S on the right
    [-0.12,0.98, 0.28,0.42, 0.72,0.84, 1.12,0.02, .22,.30,.46], // platform: diagonal sweep
    [-0.12,0.70, 0.30,0.18, 0.62,1.00, 1.12,0.30, .20,.55,.58], // photos/steps
    [-0.12,0.80, 0.35,0.55, 0.65,1.02, 1.12,0.66, .17,.60,.52], // pricing: horizontal band
    [-0.12,0.22, 0.35,0.62, 0.70,0.04, 1.12,0.44, .22,.40,.50]  // cta/footer
  ];
  var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  var W,H,D,N,SEG,FRAME=0,last=-1e9,strands=[],parts=[],cur=K[0].slice(),A=[200,242,90],B=[98,214,196];
  var mx=.5,my=.5,tmx=.5,tmy=.5,P=[0,0,0,0],Q=[0,0];
  function rnd(a,b){return a+Math.random()*(b-a)}
  function hex(h){h=String(h).trim().replace("#","");if(h.length!==6)return null;return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]}
  function colors(){var s=getComputedStyle(document.body),a=hex(s.getPropertyValue("--accent")),b=hex(s.getPropertyValue("--accent-2"));if(a)A=a;if(b)B=b;
    strands.forEach(function(st){var m=Math.pow(st.m,1.1);st.rgb=Math.round(A[0]+(B[0]-A[0])*m)+","+Math.round(A[1]+(B[1]-A[1])*m)+","+Math.round(A[2]+(B[2]-A[2])*m)})}
  // Phones: fewer, slightly brighter strands, 1x pixels and ~30 fps, so the page stays responsive on slower CPUs.
  function size(){W=innerWidth;H=innerHeight;var small=W<700;D=small?1:Math.min(window.devicePixelRatio||1,1.5);FRAME=small?33:0;
    c.width=Math.round(W*D);c.height=Math.round(H*D);x.setTransform(D,0,0,D,0,0);
    N=small?56:200;SEG=small?28:70;var lift=small?1.45:1;strands=[];
    for(var i=0;i<N;i++)strands.push({o:(i/(N-1))*2-1+rnd(-.06,.06),ph:rnd(0,6.283),w:rnd(.5,1.3)*(small?1.15:1),a:Math.min(.8,(Math.random()<.14?rnd(.32,.6):rnd(.07,.2))*lift),m:Math.random(),f:rnd(.6,1.5)});
    parts=[];for(var j=0;j<(small?24:110);j++)parts.push({s:Math.floor(Math.random()*N),t:Math.random(),v:rnd(.0006,.0022)*(small?2:1),r:rnd(.5,1.5)});
    colors()}
  function target(){var max=document.documentElement.scrollHeight-H,p=max>0?Math.min(1,Math.max(0,scrollY/max)):0,f=p*(K.length-1),i=Math.min(K.length-2,Math.floor(f)),k=f-i;k=k*k*(3-2*k);
    var a=K[i],b=K[i+1],o=[];for(var n=0;n<a.length;n++)o.push(a[n]+(b[n]-a[n])*k);return o}
  function spine(t){var k=cur,u=1-t,b0=u*u*u,b1=3*u*u*t,b2=3*u*t*t,b3=t*t*t;
    P[0]=(b0*k[0]+b1*k[2]+b2*k[4]+b3*k[6])*W;P[1]=(b0*k[1]+b1*k[3]+b2*k[5]+b3*k[7])*H;
    var d0=3*u*u,d1=6*u*t,d2=3*t*t,dx=(d0*(k[2]-k[0])+d1*(k[4]-k[2])+d2*(k[6]-k[4]))*W,dy=(d0*(k[3]-k[1])+d1*(k[5]-k[3])+d2*(k[7]-k[5]))*H,L=Math.hypot(dx,dy)||1;
    P[2]=-dy/L;P[3]=dx/L}
  function point(s,t,T,S){spine(t);
    var g=Math.exp(-Math.pow(t-cur[10],2)/0.0242),spread=S*(1-cur[9]*g)*(.55+.45*Math.sin(t*3.1+T*.22));
    var tw=Math.cos(t*3.8+T*.38+s.ph*.12);
    var off=s.o*spread*tw+Math.sin(t*6*s.f+T*.9+s.ph)*S*.05*(1-g*.85);
    var px=P[0]+P[2]*off,py=P[1]+P[3]*off,dx=mx*W-px,dy=my*H-py,dm=Math.hypot(dx,dy),pull=Math.max(0,1-dm/(Math.min(W,H)*.35))*.07;
    Q[0]=px+dx*pull;Q[1]=py+dy*pull;return g}
  function draw(time){
    var tg=target(),e=reduce?1:(FRAME?.105:.055);for(var n=0;n<cur.length;n++)cur[n]+=(tg[n]-cur[n])*e;
    var me=FRAME?.08:.04;mx+=(tmx-mx)*me;my+=(tmy-my)*me;
    var T=reduce?0:time*.001,S=Math.min(W,H)*cur[8]*(W<700?1.3:1);
    x.globalCompositeOperation="source-over";x.clearRect(0,0,W,H);x.globalCompositeOperation="lighter";
    // glow at the knot
    spine(cur[10]);var gr=x.createRadialGradient(P[0],P[1],0,P[0],P[1],S*1.6);
    gr.addColorStop(0,"rgba("+A.join(",")+","+(.34*cur[9]).toFixed(3)+")");gr.addColorStop(1,"rgba("+A.join(",")+",0)");x.fillStyle=gr;x.fillRect(0,0,W,H);
    // volumetric haze along the spine
    x.lineCap="round";for(var h=0;h<3;h++){x.strokeStyle="rgba("+(h==1?B:A).join(",")+",0.035)";x.lineWidth=S*(.35+h*.3);x.beginPath();for(var j=0;j<=30;j++){spine(j/30);if(j)x.lineTo(P[0],P[1]);else x.moveTo(P[0],P[1])}x.stroke()}
    for(var i=0;i<N;i++){var s=strands[i];x.strokeStyle="rgba("+s.rgb+","+s.a+")";x.lineWidth=s.w;x.beginPath();
      for(var j=0;j<=SEG;j++){point(s,j/SEG,T,S);if(j)x.lineTo(Q[0],Q[1]);else x.moveTo(Q[0],Q[1])}x.stroke()}
    for(var p=0;p<parts.length;p++){var q=parts[p];if(!reduce){q.t+=q.v;if(q.t>1)q.t-=1}
      var st=strands[q.s];point(st,q.t,T,S);var fade=Math.sin(q.t*Math.PI);
      x.fillStyle="rgba("+st.rgb+","+(.75*fade).toFixed(3)+")";x.beginPath();x.arc(Q[0],Q[1],q.r,0,6.283);x.fill()}
  }
  var raf=0;function loop(t){if(t-last>=FRAME){last=t;draw(t)}raf=requestAnimationFrame(loop)}
  document.addEventListener("visibilitychange",function(){if(reduce)return;cancelAnimationFrame(raf);if(document.visibilityState==="visible")raf=requestAnimationFrame(loop)});
  size();
  addEventListener("resize",function(){size();if(reduce)draw(0)});
  addEventListener("pointermove",function(e){tmx=e.clientX/W;tmy=e.clientY/H},{passive:true});
  if(reduce){draw(0);addEventListener("scroll",function(){draw(0)},{passive:true})}
  else{raf=requestAnimationFrame(loop)}
})();
