(function(root){
const key=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const next=(k,n=1)=>{let d=new Date(k+'T12:00:00');d.setDate(d.getDate()+n);return key(d)};
const fresh=t=>({version:1,start:t,days:{},habits:[]});
function ensure(s,k){if(!s.days[k])s.days[k]={items:[]};let day=s.days[k];for(let h of s.habits){if(h.start<=k&&(!h.end||h.end>k)&&h.week.includes(new Date(k+'T12:00:00').getDay())&&!day.items.some(i=>i.habit===h.id))day.items.push({id:h.id+'@'+k,habit:h.id,title:h.title,icon:h.icon,color:h.color,status:'pending'});}return day}
function calculate(s,t){let streak=0,record=0,ice=2,pair=0,ideal=0;for(let k=s.start;k<=t;k=next(k)){let d=ensure(s,k),required=d.items.filter(i=>i.status!=='rest'),done=required.length>0&&required.every(i=>i.status==='done');d.outcome='open';if(done){streak++;ideal++;pair++;if(pair===2){ice=Math.min(2,ice+1);pair=0}d.outcome='ideal'}else if(k<t){pair=0;if(required.length===0){d.outcome='neutral'}else{for(let i of required)if(i.status==='pending')i.status='missed';if(ice){ice--;d.outcome='frozen'}else{streak=0;d.outcome='broken'}}}record=Math.max(record,streak)}return {streak,record,ice,pair,ideal}}
root.PlannerEngine={key,next,fresh,ensure,calculate};if(typeof module!=='undefined')module.exports=root.PlannerEngine;
})(typeof window==='undefined'?globalThis:window);
