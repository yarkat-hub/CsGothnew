const express=require('express'),Database=require('better-sqlite3'),bcrypt=require('bcryptjs'),crypto=require('crypto'),path=require('path');
const db=new Database(process.env.DB_FILE||'csgoth.db');db.pragma('journal_mode=WAL');
db.exec(`
create table if not exists users(id integer primary key,name text unique collate nocase not null,pw text not null,gold integer not null default 0,admin integer not null default 0,ref integer,refs integer not null default 0,ref_earn integer not null default 0,last_free integer not null default 0,opened integer not null default 0,created integer);
create table if not exists inv(id integer primary key,user_id integer not null,name text,rarity integer,value integer);
create table if not exists sessions(token text primary key,user_id integer not null,exp integer not null);
create table if not exists prices(case_id text primary key,price integer not null);
create table if not exists payments(id text primary key,user_id integer,amount integer,created integer);
create table if not exists admin_log(ts integer,admin text,action text);
create table if not exists promos(code text primary key collate nocase,bonus integer not null default 0,partner text,partner_pct integer not null default 0,max_uses integer not null default 0,uses integer not null default 0,deposited integer not null default 0,paid integer not null default 0,active integer not null default 1,created integer);
create table if not exists promo_use(user_id integer,code text collate nocase,primary key(user_id,code));
create table if not exists withdrawals(id integer primary key,user_id integer,steam text,region text,items text,gold integer,rub integer,status text not null default 'new',note text,created integer);
create table if not exists resets(h text primary key,user_id integer,exp integer);
create table if not exists orders(id text primary key,user_id integer,amount integer,status text,created integer);`);

for(const c of['spent integer not null default 0','last_cb integer not null default 0','rk text','email text','tg_id integer','display text'])try{db.exec('alter table users add column '+c)}catch(e){}
try{db.exec('alter table orders add column ext text')}catch(e){}
try{db.exec('alter table orders add column promo text')}catch(e){}
try{db.exec('alter table orders add column provider text')}catch(e){}
try{db.exec('alter table orders add column stars integer')}catch(e){}
try{db.exec('create unique index if not exists u_tg on users(tg_id)')}catch(e){}
const CB=+process.env.CASHBACK_PCT||5;
// Вывод на Steam: курс (рублей за 1 G), комиссия %, минимум в рублях, сколько нужно пополнить до первого вывода
const WD_RATE=+process.env.WITHDRAW_RATE||1,WD_FEE=process.env.WITHDRAW_FEE_PCT===undefined?5:+process.env.WITHDRAW_FEE_PCT,WD_MIN=+process.env.WITHDRAW_MIN||100,WD_NEED=process.env.WITHDRAW_NEED_DEPOSIT===undefined?100:+process.env.WITHDRAW_NEED_DEPOSIT;
const RW=[55,28,11,5,1];
const CASES=[
 // Предмет: [название, редкость, цена в G, вес]. Сумма весов в кейсе = 10000, шанс = вес / 10000.
 {id:'free',name:'Ежедневный',price:0,ic:'★',free:1,items:[['P250 | Песчаная дюна',0,18,4500],['MP9 | Розовое железо',0,22,3500],['Nova | Орех',1,40,1400],['AK-47 | Сафари',1,70,500],['M4A4 | Буря в пустыне',2,120,90],['Desert Eagle | Пламя',3,320,10]]},
 {id:'dust',name:'Пыльный старт',price:50,ic:'D',items:[['P250 | Песчаная дюна',0,18,3200],['MP9 | Розовое железо',0,22,3000],['Nova | Орех',1,40,2000],['AK-47 | Сафари',1,70,1100],['M4A4 | Буря в пустыне',2,120,500],['Desert Eagle | Пламя',3,320,170],['AWP | Гадюка',4,900,30]]},
 {id:'goth',name:'Готик',price:200,ic:'G',items:[['Glock-18 | Ночная тень',0,60,4050],['USP-S | Кладбище',1,130,3200],['MP7 | Чёрная вдова',1,150,1800],['M4A1-S | Реквием',2,400,600],['AK-47 | Чёрный лотос',3,1100,220],['AWP | Склеп',3,1600,110],['Нож | Некромант',4,5200,20]]},
 {id:'gold',name:'Золотая лихорадка',price:1000,ic:'$',items:[['AK-47 | Жёлтая метка',1,500,8000],['M4A4 | Золотой век',2,1500,1200],['AWP | Золотой песок',2,2100,550],['Desert Eagle | Слиток',3,4200,200],['Керамбит | Жёлтая смерть',4,16000,45],['Перчатки | Золотая пыль',4,24000,5]]}
];
const price=c=>{const r=db.prepare('select price from prices where case_id=?').get(c.id);return r?r.price:c.price};
// выбор скина только на сервере, криптостойкий генератор
function pick(c){let r=crypto.randomInt(10000);for(const i of c.items){r-=i[3];if(r<0)return i}return c.items[0]}
const bad=(m,c=400)=>{const e=new Error(m);e.code=c;throw e};
const cookie=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=')).filter(a=>a[0]));
function startSession(res,uid){const t=crypto.randomBytes(32).toString('hex');db.prepare('insert into sessions values(?,?,?)').run(t,uid,Date.now()+30*864e5);res.setHeader('Set-Cookie',`sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30*86400}${process.env.COOKIE_SECURE?'; Secure':''}`);return t}
function auth(req,res,next){const t=String(req.headers.authorization||'').replace(/^Bearer /,'')||cookie(req).sid;const u=t&&db.prepare('select u.* from sessions s join users u on u.id=s.user_id where s.token=? and s.exp>?').get(t,Date.now());if(!u)return res.status(401).json({error:'Войди в аккаунт'});req.user=u;next()}
const admin=(req,res,next)=>req.user.admin?next():res.status(403).json({error:'Нет доступа'});
const okMail=e=>typeof e==='string'&&e.length<=100&&/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const newKey=()=>crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g).join('-');
// Защита от ботов: Cloudflare Turnstile. Включается, когда задан TURNSTILE_SECRET.
async function human(req,res,next){try{const sec=process.env.TURNSTILE_SECRET;if(sec){
 const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret:sec,response:String((req.body||{}).cf||''),remoteip:req.ip})});
 if(!(await r.json()).success)bad('Подтверди, что ты не бот')}next()}catch(e){next(e)}}
// Platega: создание платёжной ссылки (POST /transaction/process). Способ оплаты: PLATEGA_METHOD (2 = СБП, 11 = карты).
async function providerCreate(order,user,ip){
 const mid=process.env.PLATEGA_MERCHANT_ID,key=process.env.PLATEGA_SECRET;
 if(!mid||!key)bad('Платежи ещё не подключены',501);
 const base=process.env.PUBLIC_URL||'';
 const r=await fetch((process.env.PLATEGA_URL||'https://app.platega.io')+'/transaction/process',{method:'POST',headers:{'Content-Type':'application/json','X-MerchantId':mid,'X-Secret':key},body:JSON.stringify({
  paymentMethod:+(process.env.PLATEGA_METHOD||2),
  paymentDetails:{amount:order.amount,currency:'RUB'},
  description:'Пополнение баланса CsGoth',
  return:base+'/',failedUrl:base+'/',
  payload:order.id,
  metadata:{userId:String(user.tg_id||user.id),userName:user.display||user.name,clientIp:ip,user_email:(user.tg_id||user.id)+'@telegram.org'}})});
 const j=await r.json().catch(()=>({}));
 if(!r.ok||!j.redirect){console.error('Platega',r.status,j);bad('Не удалось создать платёж, попробуй позже',502)}
 db.prepare('update orders set ext=? where id=?').run(String(j.transactionId||''),order.id);
 return j.redirect}
// Письма через Resend. Нужны RESEND_API_KEY и MAIL_FROM (адрес на подтверждённом в Resend домене).
const sha=t=>crypto.createHash('sha256').update(t).digest('hex');
const mailOn=()=>!!(process.env.RESEND_API_KEY&&process.env.MAIL_FROM);
async function sendMail(to,subject,html){
 const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.RESEND_API_KEY},body:JSON.stringify({from:process.env.MAIL_FROM,to:[to],subject,html})});
 if(!r.ok)throw new Error('Resend '+r.status+' '+await r.text().catch(()=>''))}
// Промокод при пополнении: бонус игроку в % от суммы и, если задан партнёр (блогер, стример), его доля в голде.
// Начисляется один раз на игрока и код, только после подтверждённой оплаты.
function promoBonus(o){
 if(!o.promo)return;
 const p=db.prepare('select * from promos where code=? and active=1').get(o.promo);if(!p)return;
 if(p.max_uses>0&&p.uses>=p.max_uses)return;
 if(db.prepare('insert or ignore into promo_use values(?,?)').run(o.user_id,p.code).changes!==1)return;
 const b=Math.floor(o.amount*p.bonus/100);if(b>0)db.prepare('update users set gold=gold+? where id=?').run(b,o.user_id);
 let pay=0;
 if(p.partner&&p.partner_pct>0){const u=db.prepare('select id from users where tg_id=?').get(+p.partner);
  if(u&&u.id!==o.user_id){pay=Math.floor(o.amount*p.partner_pct/100);db.prepare('update users set gold=gold+? where id=?').run(pay,u.id)}}
 db.prepare('update promos set uses=uses+1,deposited=deposited+?,paid=paid+? where code=?').run(o.amount,b+pay,p.code)}
// ===== Telegram Stars и бот: обновления забираем сами через getUpdates, публичный адрес для этого не нужен =====
const STAR_GOLD=+process.env.STAR_GOLD||1;
const TG_API=process.env.TG_API||'https://api.telegram.org';
async function tg(method,body){
 const r=await fetch(TG_API+'/bot'+process.env.BOT_TOKEN+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
 const j=await r.json().catch(()=>({}));if(!j.ok)throw new Error('Telegram '+method+': '+(j.description||r.status));return j.result}
// Единое место, где заказ становится оплаченным. Срабатывает один раз, даже если сообщили и колбэк, и опрос статуса.
const settle=db.transaction(id=>{
 const o=db.prepare('select * from orders where id=?').get(id);if(!o||o.status==='paid')return null;
 db.prepare("update orders set status='paid' where id=?").run(o.id);
 credit(o.user_id,o.amount,'ord-'+o.id);promoBonus(o);return o});
function checkPromoFor(user,code){
 if(!code)return null;const p=db.prepare('select * from promos where code=? and active=1').get(code);
 if(!p||(p.max_uses>0&&p.uses>=p.max_uses))bad('Промокод не найден или закончился');
 if(db.prepare('select 1 from promo_use where user_id=? and code=?').get(user.id,p.code))bad('Ты уже использовал этот промокод');
 return p.code}
async function handleUpdate(u){
 try{
  if(u.pre_checkout_query){const q=u.pre_checkout_query;
   const o=db.prepare('select * from orders where id=?').get(String(q.invoice_payload||''));
   const ok=!!(o&&o.provider==='stars'&&o.status==='new'&&q.currency==='XTR'&&q.total_amount===o.stars);
   await tg('answerPreCheckoutQuery',ok?{pre_checkout_query_id:q.id,ok:true}:{pre_checkout_query_id:q.id,ok:false,error_message:'Заказ не найден или уже оплачен'});return}
  const m=u.message;if(!m)return;
  if(m.successful_payment){const sp=m.successful_payment;
   const o=db.prepare('select * from orders where id=?').get(String(sp.invoice_payload||''));
   if(o&&o.provider==='stars'&&sp.currency==='XTR'&&sp.total_amount===o.stars&&settle(o.id)){
    db.prepare('update orders set ext=? where id=?').run(String(sp.telegram_payment_charge_id||''),o.id);
    const us=db.prepare('select tg_id from users where id=?').get(o.user_id);
    if(us&&us.tg_id)await tg('sendMessage',{chat_id:us.tg_id,text:'Оплата получена: +'+o.amount+' G'}).catch(()=>{})}
   return}
  if(m.text&&/^\/start/.test(m.text)&&m.chat&&m.chat.type==='private'&&/^https:/.test(process.env.PUBLIC_URL||''))
   await tg('sendMessage',{chat_id:m.chat.id,text:'Нажми «Играть», чтобы открыть CsGoth.',reply_markup:{inline_keyboard:[[{text:'Играть',web_app:{url:process.env.PUBLIC_URL}}]]}})
 }catch(e){console.error('bot update:',e.message)}}
let offset=0;
async function pollBot(){
 try{await tg('deleteWebhook',{})}catch(e){console.error(e.message)}
 if(/^https:/.test(process.env.PUBLIC_URL||''))try{await tg('setChatMenuButton',{menu_button:{type:'web_app',text:'Играть',web_app:{url:process.env.PUBLIC_URL}}});console.log('>>> Кнопка «Играть» в боте обновлена на новый адрес. Отправь боту /start и нажми «Играть» под ответом.')}catch(e){console.error('>>> Кнопку «Играть» обновить не удалось: '+e.message)}
 for(;;){
  try{const ups=await tg('getUpdates',{offset,timeout:25,allowed_updates:['pre_checkout_query','message']});
   for(const u of ups){offset=u.update_id+1;await handleUpdate(u)}}
  catch(e){console.error('bot:',e.message);if(/fetch failed/.test(e.message)&&Date.now()-(pollBot.hint||0)>60000){pollBot.hint=Date.now();console.error('>>> Нет связи с Telegram (api.telegram.org). Включи VPN на всём компьютере и перезапусти игру: без этого кнопка «Играть» не обновится и оплата Stars не заработает.')}await new Promise(r=>setTimeout(r,3000))}}}
// ===== Platega: статус платежа спрашиваем сами, колбэк и публичный адрес не обязательны =====
async function plategaStatus(extId){
 const r=await fetch((process.env.PLATEGA_URL||'https://app.platega.io')+'/transaction/'+encodeURIComponent(extId),{headers:{'X-MerchantId':process.env.PLATEGA_MERCHANT_ID,'X-Secret':process.env.PLATEGA_SECRET}});
 if(!r.ok)throw new Error('Platega status '+r.status);return (await r.json()).status}
async function checkPlatega(userId,includeOld){
 if(!process.env.PLATEGA_MERCHANT_ID||!process.env.PLATEGA_SECRET)return;
 const since=Date.now()-(includeOld?2*864e5:3*36e5);
 const rows=db.prepare("select * from orders where (provider='platega' or provider is null) and status='new' and ext is not null and ext!='' and created>?"+(userId?' and user_id=?':'')+' order by created desc limit 30').all(...(userId?[since,userId]:[since]));
 for(const o of rows){try{const st=await plategaStatus(o.ext);
  if(st==='CONFIRMED')settle(o.id);
  else if(st==='CANCELED')db.prepare("update orders set status='canceled' where id=? and status='new'").run(o.id)}catch(e){console.error(e.message)}}}
async function selfCheck(){
 const u=process.env.PUBLIC_URL;if(!/^https?:/.test(u||''))return;
 for(let i=0;i<(+process.env.SELF_CHECK_TRIES||30);i++){
  try{const r=await fetch(u+'/api/config');if(r.ok){console.log('>>> Адрес работает снаружи: '+u);return}}catch(e){}
  await new Promise(r=>setTimeout(r,3000))}
 console.error('>>> Адрес '+u+' не открывается снаружи. Тоннель не работает или его блокирует интернет. Закрой окно, проверь VPN и запусти start.bat заново.')}
function startWorkers(){
 selfCheck();
 if(process.env.BOT_TOKEN&&!process.env.NO_BOT)pollBot();
 if(process.env.PLATEGA_MERCHANT_ID&&process.env.PLATEGA_SECRET){let n=0,busy=false;
  setInterval(()=>{if(busy)return;busy=true;checkPlatega(0,n++%40===0).finally(()=>{busy=false})},+process.env.PAY_POLL_MS||15000)}}
const hits=new Map();
function limit(req,res,next){const n=Date.now(),a=(hits.get(req.ip)||[]).filter(t=>n-t<6e4);a.push(n);hits.set(req.ip,a);a.length>10?res.status(429).json({error:'Слишком много попыток, подожди минуту'}):next()}
const credit=db.transaction((uid,a,pid)=>{
 db.prepare('insert into payments values(?,?,?,?)').run(pid,uid,a,Date.now());
 db.prepare('update users set gold=gold+? where id=?').run(a,uid);
 const r=db.prepare('select ref from users where id=?').get(uid).ref;
 if(r){const b=Math.floor(a*.05);db.prepare('update users set gold=gold+?,ref_earn=ref_earn+? where id=?').run(b,b,r)}});

// Админы задаются списком Telegram ID в ADMIN_TG_IDS и проверяются при каждом входе.

const app=express();app.set('trust proxy',1);app.use(express.json({limit:'10kb',verify:(req,res,buf)=>{req.raw=buf}}));
app.use((req,res,next)=>{if(req.path==='/'||req.path.startsWith('/api/'))console.log(new Date().toLocaleTimeString('ru-RU'),req.method,req.path);next()});
app.use(express.static(path.join(__dirname,'public')));

// Вход через Telegram: подпись initData проверяется по токену бота (см. документацию Telegram Mini Apps).
app.post('/api/tg',limit,(req,res)=>{
 const bot=process.env.BOT_TOKEN;if(!bot)bad('BOT_TOKEN не задан на сервере',500);
 const p=new URLSearchParams(String((req.body||{}).initData||'')),hash=p.get('hash');p.delete('hash');
 const dcs=[...p.entries()].sort((a,b)=>a[0]<b[0]?-1:1).map(([k,v])=>k+'='+v).join('\n');
 const key=crypto.createHmac('sha256','WebAppData').update(bot).digest();
 if(!hash||!same(hash,crypto.createHmac('sha256',key).update(dcs).digest('hex')))bad('Неверная подпись Telegram',401);
 if(Date.now()/1000-(+p.get('auth_date')||0)>86400)bad('Сессия устарела, открой мини-апп заново',401);
 let tu;try{tu=JSON.parse(p.get('user')||'')}catch(e){}
 if(!tu||!Number.isInteger(tu.id))bad('Нет данных пользователя',401);
 const adminIds=(process.env.ADMIN_TG_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
 const display=String(tu.username?'@'+tu.username:([tu.first_name,tu.last_name].filter(Boolean).join(' ')||'игрок '+tu.id)).slice(0,40);
 const id=db.transaction(()=>{
  let u=db.prepare('select id from users where tg_id=?').get(tu.id);
  if(!u){
   const m=/^ref_(\d{1,15})$/.exec(p.get('start_param')||'');
   const rf=m&&+m[1]!==tu.id?db.prepare('select id from users where tg_id=?').get(+m[1]):null;
   const nid=db.prepare('insert into users(name,pw,gold,ref,created,tg_id,display) values(?,?,?,?,?,?,?)').run('tg'+tu.id,'',rf?150:100,rf?rf.id:null,Date.now(),tu.id,display).lastInsertRowid;
   if(rf)db.prepare('update users set gold=gold+100,refs=refs+1,ref_earn=ref_earn+100 where id=?').run(rf.id);
   u={id:nid}}
  db.prepare('update users set display=?,admin=? where id=?').run(display,adminIds.includes(String(tu.id))?1:0,u.id);
  return u.id})();
 res.json({token:startSession(res,id)})});
app.get('/api/config',(req,res)=>res.json({link:process.env.MINIAPP_LINK||'',wd:{min:WD_MIN,need:WD_NEED,fee:WD_FEE,rate:WD_RATE},stars:!!process.env.BOT_TOKEN&&!process.env.NO_BOT,starGold:STAR_GOLD,pay:!!(process.env.PLATEGA_MERCHANT_ID&&process.env.PLATEGA_SECRET)}));
app.post('/api/logout',(req,res)=>{const t=cookie(req).sid;if(t)db.prepare('delete from sessions where token=?').run(t);res.setHeader('Set-Cookie','sid=; HttpOnly; Path=/; Max-Age=0');res.json({ok:1})});
app.get('/api/cases',(req,res)=>res.json(CASES.map(c=>({...c,price:price(c)}))));
app.get('/api/me',auth,(req,res)=>{const u=req.user;
 const refActive=db.prepare("select count(distinct o.user_id) c from orders o join users r on r.id=o.user_id where r.ref=? and o.status='paid'").get(u.id).c;
 const deposited=db.prepare("select coalesce(sum(amount),0) s from orders where user_id=? and status='paid'").get(u.id).s;
 const wd=db.prepare('select id,rub,status,created,note from withdrawals where user_id=? order by id desc limit 10').all(u.id);
 res.json({refActive,deposited,wd,name:u.display||u.name,tg:u.tg_id,gold:u.gold,admin:!!u.admin,refs:u.refs,refEarn:u.ref_earn,hasEmail:!!u.email,spent:u.spent,cbPct:CB,cbAmount:Math.floor(u.spent*CB/100),cbLeft:Math.max(0,u.last_cb+7*864e5-Date.now()),freeLeft:Math.max(0,u.last_free+864e5-Date.now()),inv:db.prepare('select id,name,rarity,value from inv where user_id=? order by id').all(u.id)})});
app.post('/api/open',auth,(req,res)=>{
 const c=CASES.find(x=>x.id===(req.body||{}).id);if(!c)bad('Кейс не найден',404);
 const win=db.transaction(()=>{
  const u=db.prepare('select * from users where id=?').get(req.user.id),p=price(c),now=Date.now();
  if(c.free){if(u.last_free+864e5>now)bad('Бесплатный кейс ещё недоступен');db.prepare('update users set last_free=? where id=?').run(now,u.id)}
  else{if(u.gold<p)bad('Не хватает голды');db.prepare('update users set gold=gold-?,spent=spent+? where id=?').run(p,p,u.id)}
  const w=pick(c);db.prepare('update users set opened=opened+1 where id=?').run(u.id);
  const id=db.prepare('insert into inv(user_id,name,rarity,value) values(?,?,?,?)').run(u.id,w[0],w[1],w[2]).lastInsertRowid;
  return{id,name:w[0],rarity:w[1],value:w[2]}})();
 res.json({win})});
app.post('/api/sell',auth,(req,res)=>{db.transaction(()=>{
 const i=db.prepare('select * from inv where id=? and user_id=?').get((req.body||{}).id,req.user.id);if(!i)bad('Скин не найден',404);
 db.prepare('delete from inv where id=?').run(i.id);db.prepare('update users set gold=gold+? where id=?').run(i.value,req.user.id)})();res.json({ok:1})});
app.post('/api/sellall',auth,(req,res)=>{db.transaction(()=>{
 const t=db.prepare('select coalesce(sum(value),0) s from inv where user_id=?').get(req.user.id).s;
 db.prepare('delete from inv where user_id=?').run(req.user.id);db.prepare('update users set gold=gold+? where id=?').run(t,req.user.id)})();res.json({ok:1})});

// Тестовое пополнение: работает только при DEMO_PAYMENTS=1. В бою не включать.
app.post('/api/topup',auth,(req,res)=>{
 if(!process.env.DEMO_PAYMENTS)bad('Платежи не подключены',501);
 const a=Math.floor(+(req.body||{}).amount);if(!(a>=10&&a<=100000))bad('Сумма от 10 до 100000');
 const did='demo-'+crypto.randomUUID();db.prepare("insert into orders(id,user_id,amount,status,created,provider) values(?,?,?,'paid',?,'demo')").run(did,req.user.id,a,Date.now());credit(req.user.id,a,did);res.json({ok:1})});
app.post('/api/pay/create',auth,async(req,res,next)=>{try{
 const a=Math.floor(+(req.body||{}).amount);if(!(a>=10&&a<=100000))bad('Сумма от 10 до 100000');
 let user=req.user;if(!user.email){const m=String((req.body||{}).email||'').trim().toLowerCase();if(okMail(m)&&!db.prepare('select 1 from users where email=?').get(m)){db.prepare('update users set email=? where id=?').run(m,user.id);user={...user,email:m}}}
 const id=crypto.randomUUID();let promo=null;const pc=String((req.body||{}).promo||'').trim();
 if(pc){const p=db.prepare('select * from promos where code=? and active=1').get(pc);
  if(!p||(p.max_uses>0&&p.uses>=p.max_uses))bad('Промокод не найден или закончился');
  if(db.prepare('select 1 from promo_use where user_id=? and code=?').get(user.id,p.code))bad('Ты уже использовал этот промокод');
  promo=p.code}
 db.prepare("insert into orders(id,user_id,amount,status,created,promo,provider) values(?,?,?,'new',?,?,'platega')").run(id,req.user.id,a,Date.now(),promo);
 res.json({url:await providerCreate({id,amount:a},user,req.ip)})}catch(e){next(e)}});
// Колбэк Platega. Платёжка присылает наши же X-MerchantId и X-Secret, подписи у тела нет, поэтому сравниваем заголовки.
// Адрес колбэка (PUBLIC_URL/api/pay/webhook) указывается в кабинете Platega. Обработка идемпотентна.
const same=(a,b)=>{a=Buffer.from(String(a||''));b=Buffer.from(String(b||''));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
app.post('/api/pay/webhook',(req,res)=>{
 const mid=process.env.PLATEGA_MERCHANT_ID,key=process.env.PLATEGA_SECRET;
 if(!mid||!key||!same(req.headers['x-merchantid'],mid)||!same(req.headers['x-secret'],key))return res.sendStatus(403);
 const{status,amount,payload}=req.body||{};const o=db.prepare('select * from orders where id=?').get(String(payload||''));
 if(!o)return res.sendStatus(400);
 if(status==='CONFIRMED'){
  if(+amount!==o.amount)return res.sendStatus(400);
  settle(o.id);
 }else if(status==='CANCELED'&&o.status==='new')db.prepare("update orders set status='canceled' where id=?").run(o.id);
 else if(status==='CHARGEBACKED'||status==='PARTIALLY_REFUNDED')db.prepare('insert into admin_log values(?,?,?)').run(Date.now(),'platega',status+' order '+o.id+' user '+o.user_id);
 res.sendStatus(200)});

// Кэшбэк: возвращаем CASHBACK_PCT% голды, потраченной на платные кейсы, раз в 7 дней.
app.post('/api/cashback',auth,(req,res)=>{const r=db.transaction(()=>{
 const u=db.prepare('select * from users where id=?').get(req.user.id),a=Math.floor(u.spent*CB/100);
 if(u.last_cb+7*864e5>Date.now())bad('Кэшбэк ещё недоступен');if(a<1)bad('Пока нечего возвращать');
 db.prepare('update users set gold=gold+?,spent=0,last_cb=? where id=?').run(a,Date.now(),u.id);return a})();res.json({amount:r})});
const CAT=new Map();CASES.forEach(c=>c.items.forEach(i=>CAT.set(i[0],i)));
// Апгрейд: ставка из своих скинов, цель дороже. Шанс = ставка / цена цели * 0.95, максимум 90%. Проигранные скины сгорают.
app.post('/api/upgrade',auth,(req,res)=>{
 const b=req.body||{},ids=[...new Set((Array.isArray(b.ids)?b.ids:[]).map(Number))].filter(Number.isInteger),t=CAT.get(String(b.target));
 if(!t||!ids.length||ids.length>50)bad('Неверные данные');
 const out=db.transaction(()=>{
  const rows=ids.map(id=>db.prepare('select * from inv where id=? and user_id=?').get(id,req.user.id));
  if(rows.some(r=>!r))bad('Скин не найден',404);
  const st=rows.reduce((a,r)=>a+r.value,0);
  if(!(t[2]>st&&t[2]<=st*95))bad('Эта цель недоступна для такой ставки');
  const ch=Math.min(.9,st/t[2]*.95);
  rows.forEach(r=>db.prepare('delete from inv where id=?').run(r.id));
  const won=crypto.randomInt(1e6)/1e6<ch;
  if(won)db.prepare('insert into inv(user_id,name,rarity,value) values(?,?,?,?)').run(req.user.id,t[0],t[1],t[2]);
  return{won,chance:ch,item:won?{name:t[0],rarity:t[1],value:t[2]}:null}})();
 res.json(out)});

app.post('/api/pay/stars',auth,async(req,res,next)=>{try{
 if(!process.env.BOT_TOKEN)bad('Оплата звёздами не подключена',501);
 const st=Math.floor(+(req.body||{}).stars);if(!(st>=1&&st<=10000))bad('Количество Stars от 1 до 10000');
 const gold=Math.floor(st*STAR_GOLD);if(gold<1)bad('Слишком маленькая сумма');
 const promo=checkPromoFor(req.user,String((req.body||{}).promo||'').trim());
 const id=crypto.randomUUID();
 const link=await tg('createInvoiceLink',{title:'Голда CsGoth',description:'Пополнение баланса: '+gold+' G',payload:id,currency:'XTR',prices:[{label:gold+' G',amount:st}]});
 db.prepare("insert into orders(id,user_id,amount,status,created,promo,provider,stars) values(?,?,?,'new',?,?,'stars',?)").run(id,req.user.id,gold,Date.now(),promo,st);
 res.json({link})}catch(e){next(e)}});
const lastChk=new Map();
app.post('/api/pay/check',auth,async(req,res,next)=>{try{
 const n=Date.now();if(n-(lastChk.get(req.user.id)||0)>3000){lastChk.set(req.user.id,n);await checkPlatega(req.user.id,true)}
 res.json({ok:1})}catch(e){next(e)}});
// ===== Вывод скинов на Steam: заявка игрока, ручная выплата админом =====
app.post('/api/withdraw',auth,(req,res)=>{
 const b=req.body||{},region=b.region==='cis'?'cis':b.region==='ru'?'ru':null,steam=String(b.login||'').trim();
 const ids=[...new Set((Array.isArray(b.ids)?b.ids:[]).map(Number))].filter(Number.isInteger);
 if(!region)bad('Выбери регион');
 if(!/^[A-Za-z0-9_.-]{3,64}$/.test(steam))bad('Введи Steam-логин (латиница, цифры, _ . -), от 3 символов');
 if(!ids.length||ids.length>50)bad('Выбери скины для вывода');
 db.transaction(()=>{
  const dep=db.prepare("select coalesce(sum(amount),0) s from orders where user_id=? and status='paid'").get(req.user.id).s;
  if(dep<WD_NEED)bad('Вывод доступен после пополнения баланса минимум на '+WD_NEED+' ₽');
  const rows=ids.map(id=>db.prepare('select * from inv where id=? and user_id=?').get(id,req.user.id));
  if(rows.some(r=>!r))bad('Скин не найден',404);
  const gold=rows.reduce((a,r)=>a+r.value,0),rub=Math.floor(gold*WD_RATE*(1-WD_FEE/100));
  if(rub<WD_MIN)bad('Минимальная сумма вывода '+WD_MIN+' ₽');
  rows.forEach(r=>db.prepare('delete from inv where id=?').run(r.id));
  db.prepare('insert into withdrawals(user_id,steam,region,items,gold,rub,created) values(?,?,?,?,?,?,?)').run(req.user.id,steam,region,JSON.stringify(rows.map(r=>({name:r.name,rarity:r.rarity,value:r.value}))),gold,rub,Date.now())})();
 res.json({ok:1})});
app.get('/api/admin/withdrawals',auth,admin,(req,res)=>res.json(db.prepare("select w.id,w.steam,w.region,w.items,w.gold,w.rub,w.status,w.note,w.created,u.display,u.tg_id from withdrawals w join users u on u.id=w.user_id order by (w.status='new') desc,w.id desc limit 100").all()));
app.post('/api/admin/withdraw',auth,admin,(req,res)=>{
 const id=+(req.body||{}).id,act=(req.body||{}).action,note=String((req.body||{}).note||'').slice(0,200);
 if(!['paid','reject'].includes(act))bad('Неверные данные');
 const w=db.transaction(()=>{
  const w=db.prepare('select * from withdrawals where id=?').get(id);if(!w||w.status!=='new')bad('Заявка уже обработана или не найдена',409);
  if(act==='paid')db.prepare("update withdrawals set status='paid',note=? where id=?").run(note,id);
  else{for(const i of JSON.parse(w.items))db.prepare('insert into inv(user_id,name,rarity,value) values(?,?,?,?)').run(w.user_id,i.name,i.rarity,i.value);
   db.prepare("update withdrawals set status='rejected',note=? where id=?").run(note,id)}
  db.prepare('insert into admin_log values(?,?,?)').run(Date.now(),req.user.name,'withdraw '+id+' '+act);return w})();
 if(process.env.BOT_TOKEN&&!process.env.NO_BOT){const us=db.prepare('select tg_id from users where id=?').get(w.user_id);
  if(us&&us.tg_id)tg('sendMessage',{chat_id:us.tg_id,text:act==='paid'?'Вывод '+w.rub+' ₽ на Steam выполнен.':'Заявка на вывод отклонена, скины вернулись в инвентарь.'+(note?' '+note:'')}).catch(()=>{})}
 res.json({ok:1})});
app.get('/api/promo/:code',auth,(req,res)=>{
 const p=db.prepare('select * from promos where code=? and active=1').get(String(req.params.code));
 if(!p||(p.max_uses>0&&p.uses>=p.max_uses))bad('Промокод не найден или закончился',404);
 if(db.prepare('select 1 from promo_use where user_id=? and code=?').get(req.user.id,p.code))bad('Ты уже использовал этот промокод');
 res.json({bonus:p.bonus})});
app.get('/api/admin/promos',auth,admin,(req,res)=>res.json(db.prepare('select * from promos order by created desc').all()));
app.post('/api/admin/promo',auth,admin,(req,res)=>{
 const b=req.body||{},code=String(b.code||'').trim(),bonus=Math.trunc(+b.bonus||0),pp=Math.trunc(+b.partner_pct||0),mu=Math.trunc(+b.max_uses||0),partner=String(b.partner||'').trim();
 if(!/^[A-Za-z0-9_-]{3,24}$/.test(code)||bonus<0||bonus>100||pp<0||pp>50||mu<0)bad('Код: 3–24 символа (латиница, цифры, _ и -), бонус 0–100%, доля партнёра 0–50%');
 if(partner&&!db.prepare('select 1 from users where tg_id=?').get(+partner))bad('Партнёр с таким Telegram ID не найден: он должен хотя бы раз открыть мини-апп');
 db.prepare('insert into promos(code,bonus,partner,partner_pct,max_uses,created) values(?,?,?,?,?,?) on conflict(code) do update set bonus=excluded.bonus,partner=excluded.partner,partner_pct=excluded.partner_pct,max_uses=excluded.max_uses').run(code,bonus,partner||null,pp,mu,Date.now());
 db.prepare('insert into admin_log values(?,?,?)').run(Date.now(),req.user.name,`promo ${code} ${bonus}% partner ${partner||'-'} ${pp}%`);res.json({ok:1})});
app.post('/api/admin/promo/toggle',auth,admin,(req,res)=>{db.prepare('update promos set active=1-active where code=?').run(String((req.body||{}).code||''));res.json({ok:1})});
app.get('/api/admin/users',auth,admin,(req,res)=>res.json(db.prepare('select name,display,tg_id,gold,opened,admin from users order by id').all()));
app.post('/api/admin/gold',auth,admin,(req,res)=>{
 const d=Math.trunc(+(req.body||{}).delta),n=String((req.body||{}).name||'');if(!d||!db.prepare('select 1 from users where name=?').get(n))bad('Неверные данные');
 db.prepare('update users set gold=max(0,gold+?) where name=?').run(d,n);
 db.prepare('insert into admin_log values(?,?,?)').run(Date.now(),req.user.name,`gold ${n} ${d}`);res.json({ok:1})});
app.post('/api/admin/price',auth,admin,(req,res)=>{
 const id=(req.body||{}).id,p=Math.trunc(+(req.body||{}).price),c=CASES.find(x=>x.id===id);if(!c||c.free||!(p>=1))bad('Неверные данные');
 db.prepare('insert into prices values(?,?) on conflict(case_id) do update set price=excluded.price').run(id,p);
 db.prepare('insert into admin_log values(?,?,?)').run(Date.now(),req.user.name,`price ${id} ${p}`);res.json({ok:1})});

app.use((e,req,res,next)=>{if(typeof e.code!=='number'){console.error(e);return res.status(500).json({error:'Ошибка сервера'})}res.status(e.code).json({error:e.message})});
app.listen(process.env.PORT||3000,()=>{console.log('CsGoth запущен на порту '+(process.env.PORT||3000));startWorkers()});
