const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const fs       = require("fs");
const path     = require("path");
const https    = require("https");
const http     = require("http");
const crypto   = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Paths (cloud-safe) ─────────────────────────────────────────────────────
const DATA_DIR  = process.env.DATA_DIR  || path.join(__dirname, "tax-data");
const FILES_DIR = process.env.FILES_DIR || path.join(__dirname, "tax-files");
const ENTRIES   = path.join(DATA_DIR, "entries.json");
const FILES_META= path.join(DATA_DIR, "files-meta.json");
const USERS_FILE= path.join(DATA_DIR, "users.json");
// ── Sessions (persisted to disk) ───────────────────────────────────────────
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
function loadSessions(){ try{ return JSON.parse(fs.readFileSync(SESSIONS_FILE,"utf8")); }catch{ return {}; } }
function saveSessions(s){ try{ fs.writeFileSync(SESSIONS_FILE,JSON.stringify(s)); }catch{} }
const SESSIONS = loadSessions();
Object.keys(SESSIONS).forEach(t=>{ if(Date.now()>SESSIONS[t].expires) delete SESSIONS[t]; });
saveSessions(SESSIONS);

// ── Cookie parser (no extra dependency) ────────────────────────────────────
function parseCookies(req){
  const out={};
  (req.headers.cookie||"").split(";").forEach(c=>{
    const i=c.indexOf("="); if(i<0)return;
    out[c.slice(0,i).trim()]=decodeURIComponent(c.slice(i+1).trim());
  });
  return out;
}

// ── API Key ────────────────────────────────────────────────────────────────
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
if(!ANTHROPIC_API_KEY){
  try{
    const kf = path.join(__dirname,"api-key.txt");
    if(fs.existsSync(kf)) ANTHROPIC_API_KEY = fs.readFileSync(kf,"utf8").trim();
  }catch{}
}

// ── Create folders ─────────────────────────────────────────────────────────
[DATA_DIR, FILES_DIR].forEach(d=>{ if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });

// ── Helpers ────────────────────────────────────────────────────────────────
const readJSON  = f => { try{ return JSON.parse(fs.readFileSync(f,"utf8")); }catch{ return []; } };
const writeJSON = (f,d) => fs.writeFileSync(f, JSON.stringify(d,null,2));

function initUsers(){
  if(!fs.existsSync(USERS_FILE)){
    // Default admin user — password is hashed
    const adminPass = process.env.ADMIN_PASSWORD || "Hassan@2025";
    const hash = crypto.createHash("sha256").update(adminPass).digest("hex");
    writeJSON(USERS_FILE,[{username:"admin",passwordHash:hash,name:"Hassan",role:"admin",createdAt:new Date().toISOString()}]);
    console.log("[AUTH] Created default admin user. Password:",adminPass);
  }
}
initUsers();

function hashPass(p){ return crypto.createHash("sha256").update(p).digest("hex"); }
function genToken(){ return crypto.randomBytes(32).toString("hex"); }

function requireAuth(req,res,next){
  const cookies=parseCookies(req);
  const token = req.headers["x-auth-token"] || cookies.htw_session || req.query.token;
  if(!token) return res.status(401).json({error:"Not authenticated"});
  const session = SESSIONS[token];
  if(!session) return res.status(401).json({error:"Session expired"});
  if(Date.now() > session.expires){ delete SESSIONS[token]; saveSessions(SESSIONS); return res.status(401).json({error:"Session expired"}); }
  session.expires = Date.now() + 8*60*60*1000;
  saveSessions(SESSIONS);
  req.user = session.username;
  next();
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({limit:"500mb"}));
app.use(express.urlencoded({extended:true,limit:"500mb"}));

// Serve built React frontend
const DIST = path.join(__dirname,"dist");
if(fs.existsSync(DIST)){
  app.use(express.static(DIST,{
    setHeaders(res,filePath){
      if(filePath.endsWith(".js"))  res.setHeader("Content-Type","application/javascript; charset=utf-8");
      if(filePath.endsWith(".html"))res.setHeader("Content-Type","text/html; charset=utf-8");
      if(filePath.endsWith(".css")) res.setHeader("Content-Type","text/css; charset=utf-8");
    }
  }));
}

// ── Auth routes (public) ───────────────────────────────────────────────────
app.post("/api/login",(req,res)=>{
  const {username,password} = req.body;
  const users = readJSON(USERS_FILE);
  const user = users.find(u=>u.username===username && u.passwordHash===hashPass(password));
  if(!user) return res.status(401).json({ok:false,error:"Invalid username or password"});
  const token = genToken();
  SESSIONS[token] = {username:user.username,name:user.name,role:user.role,expires:Date.now()+8*60*60*1000};
  saveSessions(SESSIONS);
  res.setHeader("Set-Cookie","htw_session="+token+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800");
  res.json({ok:true,token,name:user.name,role:user.role});
});

app.post("/api/logout",requireAuth,(req,res)=>{
  const token = req.headers["x-auth-token"];
  delete SESSIONS[token];
  saveSessions(SESSIONS);
  res.setHeader("Set-Cookie","htw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ok:true});
});

app.get("/api/check-auth",(req,res)=>{
  const cookies=parseCookies(req);
  const token=req.headers["x-auth-token"]||cookies.htw_session;
  if(!token||!SESSIONS[token]||Date.now()>SESSIONS[token].expires) return res.json({ok:false});
  res.json({ok:true,name:SESSIONS[token].name||req.query.username||"Hassan"});
});

app.get("/api/me",requireAuth,(req,res)=>{
  const s = Object.values(SESSIONS).find(s=>s.username===req.user);
  res.json({ok:true,username:req.user,name:s?.name||req.user});
});

app.get("/api/ping",(req,res)=>res.json({ok:true}));

// ── User management (admin only) ───────────────────────────────────────────
app.get("/api/users",requireAuth,(req,res)=>{
  const users=readJSON(USERS_FILE).map(u=>({username:u.username,name:u.name,role:u.role,createdAt:u.createdAt}));
  res.json(users);
});

app.post("/api/users",requireAuth,(req,res)=>{
  const users=readJSON(USERS_FILE);
  const s=Object.values(SESSIONS).find(s=>s.username===req.user);
  if(s?.role!=="admin") return res.status(403).json({error:"Admin only"});
  const {username,password,name,role}=req.body;
  if(users.find(u=>u.username===username)) return res.status(400).json({error:"Username already exists"});
  users.push({username,passwordHash:hashPass(password),name:name||username,role:role||"user",createdAt:new Date().toISOString()});
  writeJSON(USERS_FILE,users);
  res.json({ok:true});
});

app.delete("/api/users/:username",requireAuth,(req,res)=>{
  const s=Object.values(SESSIONS).find(s=>s.username===req.user);
  if(s?.role!=="admin") return res.status(403).json({error:"Admin only"});
  if(req.params.username==="admin") return res.status(400).json({error:"Cannot delete admin"});
  const users=readJSON(USERS_FILE).filter(u=>u.username!==req.params.username);
  writeJSON(USERS_FILE,users);
  res.json({ok:true});
});

app.post("/api/change-password",requireAuth,(req,res)=>{
  const {oldPassword,newPassword}=req.body;
  const users=readJSON(USERS_FILE);
  const idx=users.findIndex(u=>u.username===req.user);
  if(idx===-1) return res.status(404).json({error:"User not found"});
  if(users[idx].passwordHash!==hashPass(oldPassword)) return res.status(400).json({error:"Current password incorrect"});
  users[idx].passwordHash=hashPass(newPassword);
  writeJSON(USERS_FILE,users);
  res.json({ok:true});
});

// ── Protected data routes ─────────────────────────────────────────────────
app.get("/api/entries",   requireAuth,(req,res)=>res.json(readJSON(ENTRIES)));
app.post("/api/entries",  requireAuth,(req,res)=>{ writeJSON(ENTRIES,req.body); res.json({ok:true}); });
app.post("/api/entries/add",requireAuth,(req,res)=>{
  const current=readJSON(ENTRIES);
  const news=Array.isArray(req.body)?req.body:[req.body];
  writeJSON(ENTRIES,[...current,...news]);
  res.json({ok:true});
});
app.put("/api/entries/:id",requireAuth,(req,res)=>{
  const data=readJSON(ENTRIES).map(e=>e.id===req.params.id?{...e,...req.body}:e);
  writeJSON(ENTRIES,data);
  res.json({ok:true});
});
app.delete("/api/entries/:id",requireAuth,(req,res)=>{
  writeJSON(ENTRIES,readJSON(ENTRIES).filter(e=>e.id!==req.params.id));
  res.json({ok:true});
});

app.get("/api/files-meta",   requireAuth,(req,res)=>res.json(readJSON(FILES_META)));
app.post("/api/files-meta",  requireAuth,(req,res)=>{
  const metas=Array.isArray(req.body)?req.body:[req.body];
  const current=readJSON(FILES_META);
  const updated=[...current];
  metas.forEach(m=>{ const i=updated.findIndex(f=>f.name===m.name); if(i>=0)updated[i]=m; else updated.unshift(m); });
  writeJSON(FILES_META,updated);
  res.json({ok:true,count:updated.length});
});
app.put("/api/files-meta/all",requireAuth,(req,res)=>{
  writeJSON(FILES_META,Array.isArray(req.body)?req.body:[]);
  res.json({ok:true});
});

// File upload
const upload = multer({storage:multer.diskStorage({
  destination:(req,file,cb)=>cb(null,FILES_DIR),
  filename:(req,file,cb)=>{
    const safe=file.originalname.replace(/[^a-zA-Z0-9.\-_]/g,"_").replace(/_+/g,"_").slice(0,200);
    const dest=path.join(FILES_DIR,safe);
    cb(null,fs.existsSync(dest)?Date.now()+"_"+safe:safe);
  }
}),limits:{fileSize:500*1024*1024}});

app.post("/api/upload",requireAuth,upload.array("files",100),(req,res)=>{
  if(!req.files?.length) return res.status(400).json({ok:false,error:"No files"});
  res.json({ok:true,files:req.files.map(f=>({name:f.filename,original:f.originalname,size:f.size}))});
});

app.get("/api/file/:name",requireAuth,(req,res)=>{
  const fp=path.join(FILES_DIR,path.basename(req.params.name));
  if(!fs.existsSync(fp)) return res.status(404).json({error:"Not found"});
  res.sendFile(fp);
});

app.get("/api/file/:name/base64",requireAuth,(req,res)=>{
  const fp=path.join(FILES_DIR,path.basename(req.params.name));
  if(!fs.existsSync(fp)) return res.status(404).json({error:"Not found"});
  res.json({base64:fs.readFileSync(fp).toString("base64")});
});

// ── AI proxy ───────────────────────────────────────────────────────────────
app.post("/api/ai",requireAuth,(req,res)=>{
  if(!ANTHROPIC_API_KEY||ANTHROPIC_API_KEY==="YOUR_API_KEY_HERE")
    return res.status(400).json({error:"Add ANTHROPIC_API_KEY to Railway environment variables"});
  const body=JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:2000,...req.body});
  const opts={hostname:"api.anthropic.com",path:"/v1/messages",method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,
      "anthropic-version":"2023-06-01","Content-Length":Buffer.byteLength(body)}};
  const apiReq=https.request(opts,apiRes=>{
    let d="";
    apiRes.on("data",c=>d+=c);
    apiRes.on("end",()=>{
      try{ const j=JSON.parse(d); res.json({content:j.content}); }
      catch{ res.status(500).json({error:"AI parse error"}); }
    });
  });
  apiReq.on("error",e=>res.status(500).json({error:e.message}));
  apiReq.write(body);apiReq.end();
});

// ── URL Download ───────────────────────────────────────────────────────────
app.post("/api/download-url",requireAuth,async(req,res)=>{
  const {url}=req.body;
  if(!url) return res.status(400).json({ok:false,error:"No URL"});
  const urlLib=require("url");
  async function download(currentUrl,redirects){
    if(redirects>5) throw new Error("Too many redirects");
    const parsed=urlLib.parse(currentUrl);
    const protocol=parsed.protocol==="https:"?https:http;
    return new Promise((resolve,reject)=>{
      const r=protocol.request({hostname:parsed.hostname,port:parsed.port,path:parsed.path,method:"GET",
        headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0","Accept":"application/pdf,*/*","Referer":"https://tax.gov.ae/"}},
        response=>{
          if([301,302,303,307,308].includes(response.statusCode)&&response.headers.location){
            response.resume();
            resolve(download(response.headers.location.startsWith("http")?response.headers.location:urlLib.resolve(currentUrl,response.headers.location),redirects+1));
            return;
          }
          if(response.statusCode!==200){reject(new Error("HTTP "+response.statusCode));return;}
          resolve({response,finalUrl:currentUrl});
        });
      r.on("error",reject);r.setTimeout(30000,()=>{r.destroy();reject(new Error("Timeout"));});r.end();
    });
  }
  try{
    const {response,finalUrl}=await download(url,0);
    let filename=path.basename(urlLib.parse(finalUrl).pathname)||"document";
    try{filename=decodeURIComponent(filename);}catch{}
    filename=filename.replace(/[/\?%*:|"<>]/g,"_").slice(0,200);
    if(!path.extname(filename))filename+=".pdf";
    let dest=path.join(FILES_DIR,filename);
    if(fs.existsSync(dest)){const e=path.extname(filename);filename=path.basename(filename,e)+"_"+Date.now()+e;dest=path.join(FILES_DIR,filename);}
    const file=fs.createWriteStream(dest);
    await new Promise((resolve,reject)=>{response.pipe(file);file.on("finish",resolve);file.on("error",reject);});
    const stat=fs.statSync(dest);
    if(stat.size<100){fs.unlinkSync(dest);throw new Error("Downloaded file too small — site may block direct downloads");}
    res.json({ok:true,files:[{name:filename,original:filename,size:stat.size}]});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ── Catch-all: serve React app ─────────────────────────────────────────────
if(fs.existsSync(DIST)){
  app.get("*",(req,res)=>res.sendFile(path.join(DIST,"index.html")));
}

app.listen(PORT,()=>console.log("[SERVER] Hassan Tax World running on port",PORT));
