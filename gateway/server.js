'use strict';
// LAN gateway. Requires ffmpeg installed. Serve behind HTTPS reverse proxy and access controls.
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {spawn}=require('child_process');
const PORT=Number(process.env.PORT||8787), HOST=process.env.HOST||'127.0.0.1';
const ORIGIN=process.env.ALLOWED_ORIGIN||'';const TOKEN=process.env.GATEWAY_TOKEN||'';
if(!TOKEN||TOKEN.length<20){console.error('Set GATEWAY_TOKEN (20+ chars)');process.exit(1)}
const sessions=new Map();const root=fs.mkdtempSync(path.join(os.tmpdir(),'central-hls-'));
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
function cors(req,res){if(ORIGIN&&req.headers.origin===ORIGIN){res.setHeader('Access-Control-Allow-Origin',ORIGIN);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS')} }
function clean(id){const s=sessions.get(id);if(!s)return;s.proc.kill('SIGTERM');sessions.delete(id);fs.rmSync(s.dir,{recursive:true,force:true})}
const server=http.createServer(async(req,res)=>{cors(req,res);if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
const url=new URL(req.url,'http://localhost');if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{service:'central-rtsp-gateway',version:'4.0.0',active:sessions.size});
if(req.method==='POST'&&url.pathname==='/api/streams'){
 if(req.headers.authorization!=='Bearer '+TOKEN)return send(res,401,{error:'Token do gateway inválido'});
 let raw='';for await(const part of req){raw+=part;if(raw.length>4096)return send(res,413,{error:'Requisição grande'})}
 let v;try{v=JSON.parse(raw)}catch{return send(res,400,{error:'JSON inválido'})}
 const ip=String(v.ip||'');const port=Number(v.port||554);const route=String(v.path||'/onvif1');
 // Prevent SSRF to internet and limit target to RFC1918 private IPv4 addresses.
 const n=ip.split('.').map(Number);const privateIp=n.length===4&&n.every(x=>Number.isInteger(x)&&x>=0&&x<=255)&&(n[0]===10||(n[0]===172&&n[1]>=16&&n[1]<=31)||(n[0]===192&&n[1]===168));
 if(!privateIp||!Number.isInteger(port)||port<1||port>65535||!/^\/[\w/-]{1,80}$/.test(route))return send(res,400,{error:'IP privado, porta ou caminho inválido'});
 const user=String(v.username||'admin'),pass=String(v.password||'');if(!pass||user.length>80||pass.length>200||/[\r\n]/.test(user+pass))return send(res,400,{error:'Credenciais inválidas'});
 const id=crypto.randomBytes(20).toString('hex'),dir=path.join(root,id);fs.mkdirSync(dir);
 const authUser=encodeURIComponent(user),authPass=encodeURIComponent(pass);
 const rtsp=`rtsp://${authUser}:${authPass}@${ip}:${port}${route}`;
 const args=['-hide_banner','-loglevel','error','-rtsp_transport','tcp','-i',rtsp,'-an','-c:v','copy','-f','hls','-hls_time','2','-hls_list_size','4','-hls_flags','delete_segments+omit_endlist',path.join(dir,'index.m3u8')];
 const proc=spawn('ffmpeg',args,{stdio:'ignore'});sessions.set(id,{proc,dir,created:Date.now()});proc.on('error',()=>clean(id));proc.on('exit',()=>{if(sessions.has(id))setTimeout(()=>clean(id),30000)});
 return send(res,201,{playlist:'/hls/'+id+'/index.m3u8',session:id});
 }
 const m=url.pathname.match(/^\/hls\/([a-f0-9]{40})\/(index\.m3u8|index\d+\.ts)$/);
 if(req.method==='GET'&&m){const s=sessions.get(m[1]);if(!s)return send(res,404,{error:'Sessão encerrada'});const file=path.join(s.dir,m[2]);if(!fs.existsSync(file))return send(res,404,{error:'Vídeo ainda não disponível'});res.writeHead(200,{'Content-Type':m[2].endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t','Cache-Control':'no-store'});return fs.createReadStream(file).pipe(res)}
 send(res,404,{error:'Rota desconhecida'});
});
setInterval(()=>{for(const [id,s] of sessions)if(Date.now()-s.created>20*60*1000)clean(id)},60000).unref();
server.listen(PORT,HOST,()=>console.log(`Gateway em http://${HOST}:${PORT} - configure proxy HTTPS antes de expor`));
