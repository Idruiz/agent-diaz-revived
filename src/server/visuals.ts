import sharp from "sharp";

export interface ChartSpec { title:string; type:"bar"|"line"|"pie"|"donut"; labels:string[]; series:Array<{name:string;values:number[]}>; unit?:string; sourceNote?:string }
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const palette=["#c99a2e","#2f739c","#70a37f","#c8664f","#8067a8"];

export function chartSvg(spec:ChartSpec,width=1000,height=560):string{
 const pad={l:86,r:28,t:72,b:92},w=width-pad.l-pad.r,h=height-pad.t-pad.b,all=spec.series.flatMap(s=>s.values),max=Math.max(1,...all.map(Math.abs))*1.12;
 let marks="",legend="";
 if(spec.type==="bar"){
  const group=w/spec.labels.length,bw=Math.max(8,(group*.72)/spec.series.length);
  spec.labels.forEach((l,i)=>{spec.series.forEach((s,j)=>{const v=s.values[i]??0,bh=h*Math.abs(v)/max,x=pad.l+i*group+group*.14+j*bw,y=pad.t+h-bh;marks+=`<rect x="${x}" y="${y}" width="${bw-3}" height="${bh}" rx="3" fill="${palette[j%palette.length]}"/><text x="${x+bw/2}" y="${Math.max(pad.t+12,y-7)}" text-anchor="middle" class="val">${v}</text>`});marks+=`<text x="${pad.l+i*group+group/2}" y="${pad.t+h+28}" text-anchor="middle" class="lab">${esc(l.slice(0,16))}</text>`});
 }else if(spec.type==="line"){
  const dx=w/Math.max(1,spec.labels.length-1);spec.series.forEach((s,j)=>{const pts=s.values.map((v,i)=>`${pad.l+i*dx},${pad.t+h-h*v/max}`).join(" ");marks+=`<polyline points="${pts}" fill="none" stroke="${palette[j%palette.length]}" stroke-width="5"/>`;s.values.forEach((v,i)=>marks+=`<circle cx="${pad.l+i*dx}" cy="${pad.t+h-h*v/max}" r="6" fill="${palette[j%palette.length]}"/>`)});spec.labels.forEach((l,i)=>marks+=`<text x="${pad.l+i*dx}" y="${pad.t+h+28}" text-anchor="middle" class="lab">${esc(l.slice(0,14))}</text>`);
 }else{
  const values=spec.series[0]!.values,total=values.reduce((a,b)=>a+Math.max(0,b),0)||1,cx=width/2,cy=height/2+18,r=150,inner=spec.type==="donut"?82:0;let a=-Math.PI/2;
  values.forEach((v,i)=>{const n=Math.max(0,v),end=a+n/total*Math.PI*2,large=end-a>Math.PI?1:0,p1=[cx+r*Math.cos(a),cy+r*Math.sin(a)],p2=[cx+r*Math.cos(end),cy+r*Math.sin(end)],q1=[cx+inner*Math.cos(end),cy+inner*Math.sin(end)],q2=[cx+inner*Math.cos(a),cy+inner*Math.sin(a)];marks+=inner?`<path d="M${p1} A${r},${r} 0 ${large},1 ${p2} L${q1} A${inner},${inner} 0 ${large},0 ${q2} Z" fill="${palette[i%palette.length]}"/>`:`<path d="M${cx},${cy} L${p1} A${r},${r} 0 ${large},1 ${p2} Z" fill="${palette[i%palette.length]}"/>`;a=end;legend+=`<rect x="${width-245}" y="${105+i*30}" width="15" height="15" fill="${palette[i%palette.length]}"/><text x="${width-220}" y="${118+i*30}" class="lab">${esc(spec.labels[i]??"")} (${v})</text>`});
 }
 spec.series.forEach((s,i)=>legend+=`<circle cx="${100+i*180}" cy="${height-28}" r="7" fill="${palette[i%palette.length]}"/><text x="${114+i*180}" y="${height-23}" class="lab">${esc(s.name)}</text>`);
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>text{font-family:'DejaVu Sans','Liberation Sans',sans-serif;fill:#17324d}.title{font-size:27px;font-weight:700}.lab{font-size:15px}.val{font-size:13px;font-weight:700}.note{font-size:12px;fill:#667784}</style><rect width="100%" height="100%" rx="18" fill="#fff"/><text x="${pad.l}" y="42" class="title">${esc(spec.title)}</text><line x1="${pad.l}" y1="${pad.t+h}" x2="${pad.l+w}" y2="${pad.t+h}" stroke="#cad3d9"/>${marks}${legend}<text x="${pad.l}" y="${height-8}" class="note">${esc(spec.sourceNote||"")}</text></svg>`;
}
export async function chartPng(spec:ChartSpec):Promise<Buffer>{return sharp(Buffer.from(chartSvg(spec))).png().toBuffer()}

export function diagramSvg(d:{title:string;nodes:string[];caption?:string},width=1000,height=420):string{
 const gap=(width-140)/d.nodes.length;let body="";d.nodes.forEach((n,i)=>{const x=70+i*gap,y=150;body+=`<rect x="${x}" y="${y}" width="${gap-35}" height="100" rx="14" fill="${i%2?'#e7eef2':'#f1e5c5'}" stroke="#c99a2e"/><text x="${x+(gap-35)/2}" y="${y+56}" text-anchor="middle" class="node">${esc(n.slice(0,28))}</text>`;if(i<d.nodes.length-1)body+=`<path d="M${x+gap-35},${y+50} L${x+gap-5},${y+50}" stroke="#2f739c" stroke-width="4" marker-end="url(#a)"/>`});return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#2f739c"/></marker></defs><style>text{font-family:'DejaVu Sans','Liberation Sans',sans-serif;fill:#17324d}.title{font-size:28px;font-weight:bold}.node{font-size:16px;font-weight:bold}.cap{font-size:14px;fill:#667784}</style><rect width="100%" height="100%" fill="#fff"/><text x="60" y="55" class="title">${esc(d.title)}</text>${body}<text x="60" y="365" class="cap">${esc(d.caption||"")}</text></svg>`}
export async function diagramPng(d:{title:string;nodes:string[];caption?:string}):Promise<Buffer>{return sharp(Buffer.from(diagramSvg(d))).png().toBuffer()}
