import { useState, useEffect, useRef, useCallback } from "react";

/* ─── API helpers — talks to local Express server ────────────────────────── */
const IS_LOCAL = typeof window!=="undefined" && window.location.hostname==="localhost";
const BASE_URL = IS_LOCAL ? "http://localhost:3001" : "";
const API = BASE_URL+"/api";

// Auth token storage
const getToken = ()=>localStorage.getItem("htw_token")||"";
const authHeaders = ()=>({"Content-Type":"application/json","x-auth-token":getToken()});
const authFetch = (url,opts={})=>fetch(url,{...opts,headers:{...opts.headers,"x-auth-token":getToken(),"Content-Type":"application/json"}});

async function apiListFiles() {
  try { const r = await fetch(`${API}/files`); return await r.json(); }
  catch { return []; }
}
async function apiUpload(fileList) {
  const fd = new FormData();
  for (const f of fileList) fd.append("files", f);
  try {
    const r = await fetch(`${API}/upload`, { method: "POST", body: fd });
    if (!r.ok) {
      const txt = await r.text();
      console.error("Upload HTTP error:", r.status, txt);
      return { ok: false, error: `HTTP ${r.status}: ${txt}` };
    }
    const json = await r.json();
    console.log("Upload response:", json);
    return json;
  } catch(e) {
    console.error("Upload fetch error:", e);
    return { ok: false, error: e.message };
  }
}
async function apiDelete(name) {
  await fetch(`${API}/file/${encodeURIComponent(name)}`, { method: "DELETE" });
}
async function apiDownloadUrl(url) {
  const r = await fetch(`${API.replace("/api","")}/api/download-url`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({url})
  });
  return await r.json();
}
function downloadFile(filename){
  const a = document.createElement("a");
  a.href = `${BASE_URL}/api/file/${encodeURIComponent(filename)}`;
  a.download = filename;
  a.click();
}
async function apiBase64(name) {
  const r = await fetch(`${API}/file/${encodeURIComponent(name)}/base64`);
  const d = await r.json();
  return d.base64 || null;
}
function fileViewUrl(name) {
  return `${API}/file/${encodeURIComponent(name)}`;
}
async function apiOpenFolder() {
  await fetch(`${API}/open-folder`);
}

/* ─── PDF text extraction (client side, for search index) ───────────────── */
async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  for (const [lib, worker] of [
    ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
     "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"],
    ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js",
     "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js"],
  ]) {
    try {
      await new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=lib; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = worker;
      return window.pdfjsLib;
    } catch { /* try next */ }
  }
  return null;
}
async function extractPdfTextFromBase64(b64) {
  try {
    const lib = await loadPdfJs();
    if (!lib) return { text:"", pages:0 };
    const bin=atob(b64), arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
    const pdf=await lib.getDocument({data:arr}).promise;
    let text="";
    for(let p=1;p<=pdf.numPages;p++){
      const page=await pdf.getPage(p);
      const c=await page.getTextContent();
      text+=`\n[Page ${p}]\n`+c.items.map(i=>i.str).join(" ");
    }
    return { text:text.trim(), pages:pdf.numPages };
  } catch(e) { return { text:"", pages:0 }; }
}

/* ─── LocalStorage for metadata & entries ───────────────────────────────── */
async function lsSet(key,val){
  // PRIMARY: save to server (unlimited I: drive storage)
  try{
    if(key==="kb-entries-v2"){
      await fetch(`${API}/entries`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(val)});
    } else if(key==="kb-files-meta-v2"){
      await fetch(`${API}/files-meta`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Array.isArray(val)?val:[val])});
    }
  }catch(e){console.warn("Server save failed:",e);}
  // FALLBACK: also try localStorage (may fail if full - that is OK)
  try{localStorage.setItem(key,JSON.stringify(val));}catch{}
}
async function lsGet(key){
  // PRIMARY: load from server
  try{
    if(key==="kb-entries-v2"){
      const r=await fetch(`${API}/entries`);
      if(r.ok){const d=await r.json();if(Array.isArray(d)&&d.length>0)return d;}
    } else if(key==="kb-files-meta-v2"){
      const r=await fetch(`${API}/files-meta`);
      if(r.ok){const d=await r.json();if(Array.isArray(d)&&d.length>0)return d;}
    }
  }catch(e){console.warn("Server load failed, trying localStorage:",e);}
  // FALLBACK: localStorage
  try{const v=localStorage.getItem(key);return v?JSON.parse(v):null;}catch{return null;}
}

async function callClaude(messages, system="") {
  try {
    const res=await fetch(`${API}/ai`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({system,messages})
    });
    if(!res.ok) {
      const txt=await res.text();
      throw new Error(`Server error ${res.status}: ${txt}`);
    }
    const d=await res.json();
    if(d.error) throw new Error(typeof d.error==="string"?d.error:JSON.stringify(d.error));
    if(d.type==="error") throw new Error(d.error?.message||JSON.stringify(d));
    return d.content?.map(b=>b.text||"").join("")||"";
  } catch(e) {
    if(e.message==="Failed to fetch") throw new Error("Server unreachable — is npm run dev running on port 3001?");
    throw e;
  }
}

/* ─── Global CSS ─────────────────────────────────────────────────────────── */
const G = `
  html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:#F0F2F5; --surface:#FFFFFF; --surface2:#F4F5F7;
    --border:#E2E5EA; --border2:#C8CDD6;
    --text:#1A202C; --text2:#4A5568; --text3:#A0ADB8;
    --accent:#EF9F27; --accent-bg:#FFF8EC; --accent-txt:#854F0B;
    --nav:#0F172A; --nav-active:rgba(239,159,39,0.15);
    --radius:10px; --radius-sm:6px; --radius-lg:14px;
    --shadow:0 1px 3px rgba(0,0,0,0.07),0 1px 2px rgba(0,0,0,0.04);
    --shadow-md:0 4px 14px rgba(0,0,0,0.10);
  }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:14px; line-height:1.5; }
  button { font-family:inherit; cursor:pointer; border:none; background:none; }
  input,textarea,select { font-family:inherit; font-size:14px; color:var(--text); }
  ::-webkit-scrollbar{width:5px;height:5px;}
  ::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px;}
  @keyframes spin{to{transform:rotate(360deg);}}
  @keyframes blink{0%,100%{opacity:0.3}50%{opacity:1}}
`;

/* ─── Data Model ─────────────────────────────────────────────────────────── */
const TAX_CATS = [
  { id:"ct",  label:"Corporate Tax",    color:"#3B82F6" },
  { id:"vat", label:"VAT",              color:"#10B981" },
  { id:"tp",  label:"Transfer Pricing", color:"#8B5CF6" },
  { id:"fz",  label:"Free Zone",        color:"#F59E0B" },
  { id:"ex",  label:"Excise Tax",       color:"#EF4444" },
  { id:"gen", label:"General",          color:"#6B7280" },
];

// All doc types — some only shown for specific categories
const DOC_TYPES = [
  { id:"laws",         label:"Laws",                    icon:"⚖",  cats:null },
  { id:"cabinet",      label:"Cabinet Decisions",       icon:"🏛",  cats:["ct","vat"] },
  { id:"ministerial",  label:"Ministerial Decisions",   icon:"📜",  cats:["ct","vat"] },
  { id:"fta",          label:"FTA Decisions",           icon:"🏢",  cats:["ct","vat"] },
  { id:"guidelines",   label:"Guidelines",              icon:"📘", cats:null },
  { id:"pclars",       label:"Public Clarifications",   icon:"📋", cats:null },
  { id:"bulletins",    label:"Bulletins",               icon:"📰", cats:null },
  { id:"procedures",   label:"General Procedures",      icon:"📑", cats:null },
  { id:"hmnotes",      label:"HM Notes",                icon:"✏",  cats:null },
  { id:"usermanual",   label:"User Manual",             icon:"📖", cats:["vat"] },
  { id:"vatfiling",    label:"VAT Filing",              icon:"📊", cats:["vat"] },
  { id:"internet",     label:"Material from Internet",  icon:"🌐", cats:["vat"] },
  { id:"penalties",    label:"Penalties",               icon:"⚠️", cats:["vat","ct"] },
  { id:"taxprocedures", label:"Tax Procedures",          icon:"📋", cats:["vat","ct"] },
  { id:"foodforthought", label:"Food for Thought",  icon:"🧠", cats:null },
  { id:"hmexam",       label:"HM Exam Material",        icon:"🎓", cats:null },
];

function docTypesForCat(catId) {
  return DOC_TYPES.filter(d => d.cats === null || d.cats.includes(catId));
}

const STORE_KEY  = "kb-entries-v2";
const FILES_KEY  = "kb-files-meta-v2";

/* ─── Helpers ────────────────────────────────────────────────────────────── */
const genId   = () => Date.now().toString(36)+Math.random().toString(36).slice(2);
const fmt     = iso => iso?new Date(iso).toLocaleDateString("en-AE",{day:"2-digit",month:"short",year:"numeric"}):"";
const fmtSize = b => b<1024?`${b}B`:b<1048576?`${(b/1024).toFixed(1)}KB`:`${(b/1048576).toFixed(1)}MB`;
const hilite = (text, q) => {
  if (!q || !text) return (text || "").slice(0, 200) + "...";
  const lq = q.toLowerCase();
  const lt = text.toLowerCase();
  const positions = [];
  let pos = lt.indexOf(lq);
  while (pos !== -1 && positions.length < 4) {
    positions.push(pos);
    pos = lt.indexOf(lq, pos + 1);
  }
  if (!positions.length) return text.slice(0, 200) + "...";
  const snippets = [];
  let i = 0;
  while (i < positions.length) {
    let s = Math.max(0, positions[i] - 120);
    let e = Math.min(text.length, positions[i] + lq.length + 120);
    while (i + 1 < positions.length && positions[i + 1] < e) {
      e = Math.min(text.length, positions[i + 1] + lq.length + 120);
      i++;
    }
    const prefix = s > 0 ? "..." : "";
    const suffix = e < text.length ? "..." : "";
    snippets.push(prefix + text.slice(s, e) + suffix);
    i++;
  }
  return snippets.join(" | ");
};

// Find which page(s) a search term appears on in extracted PDF text
function findMatchPages(extractedText, q) {
  if (!extractedText || !q) return [];
  const lq = q.toLowerCase();
  const lt = extractedText.toLowerCase();
  const pages = new Set();
  let pos = lt.indexOf(lq);
  while (pos !== -1 && pages.size < 5) {
    // Walk backwards to find the most recent [Page N] marker
    const textBefore = extractedText.slice(0, pos);
    const pageMarkers = [...textBefore.matchAll(/\[Page (\d+)\]/g)];
    if (pageMarkers.length > 0) {
      pages.add(parseInt(pageMarkers[pageMarkers.length - 1][1]));
    }
    pos = lt.indexOf(lq, pos + 1);
  }
  return [...pages].sort((a, b) => a - b);
}

// Build snippet with page context
function getPagedSnippets(extractedText, q) {
  if (!extractedText || !q) return [];
  const lq = extractedText.toLowerCase();
  const qt = q.toLowerCase();
  const results = [];
  const seenPages = new Set();
  let pos = lq.indexOf(qt);
  while (pos !== -1 && results.length < 4) {
    const textBefore = extractedText.slice(0, pos);
    const pageMarkers = [...textBefore.matchAll(/\[Page (\d+)\]/g)];
    const pageNum = pageMarkers.length > 0
      ? parseInt(pageMarkers[pageMarkers.length - 1][1])
      : null;
    const s = Math.max(0, pos - 200);
    const e = Math.min(extractedText.length, pos + q.length + 200);
    const snippet = (s > 0 ? "..." : "") + extractedText.slice(s, e) + (e < extractedText.length ? "..." : "");
    const pageKey = pageNum || ("pos"+pos);
    if (!seenPages.has(pageKey)) {
      seenPages.add(pageKey);
      results.push({ page: pageNum, snippet });
    }
    pos = lq.indexOf(qt, pos + 1);
  }
  return results;
}



/* ─── Highlight matching text ───────────────────────────────────────────── */
function HL({text, q}){
  if(!q||!text) return <span>{text||""}</span>;
  const lq=q.toLowerCase(), lt=(text||"").toLowerCase();
  const parts=[]; let last=0, i=lt.indexOf(lq);
  while(i!==-1&&parts.length<20){
    if(i>last) parts.push({t:text.slice(last,i),hi:false});
    parts.push({t:text.slice(i,i+q.length),hi:true});
    last=i+q.length; i=lt.indexOf(lq,last);
  }
  if(last<text.length) parts.push({t:text.slice(last),hi:false});
  return <span>{parts.map((p,k)=> p.hi
    ?<mark key={k} style={{background:"#FEF08A",color:"#713F12",borderRadius:3,padding:"0 2px",fontWeight:700}}>{p.t}</mark>
    :<span key={k}>{p.t}</span>
  )}</span>;
}

/* ─── Tiny UI ────────────────────────────────────────────────────────────── */
const Spinner=({size=20})=><div style={{width:size,height:size,border:"2px solid var(--border)",borderTopColor:"var(--text2)",borderRadius:"50%",animation:"spin 0.7s linear infinite",flexShrink:0}}/>;
const Dots=()=><div style={{display:"flex",gap:4,padding:"2px 0"}}>{[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:"var(--text3)",animation:"blink 1.2s ease-in-out infinite",animationDelay:`${i*0.2}s`}}/>)}</div>;
const IS ={width:"100%",padding:"9px 13px",fontSize:14,borderRadius:"var(--radius-sm)",border:"1.5px solid var(--border2)",background:"#fff",color:"var(--text)",outline:"none"};
const TA ={...IS,minHeight:88,resize:"vertical",lineHeight:1.6};
const SEL={...IS,cursor:"pointer"};

const Field=({label,children})=>(
  <div style={{marginBottom:"0.9rem"}}>
    <label style={{display:"block",fontSize:11,fontWeight:700,color:"var(--text2)",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.06em"}}>{label}</label>
    {children}
  </div>
);
const Btn=({onClick,children,variant="default",disabled,style:st={}})=>{
  const S={
    default:{background:"#fff",border:"1.5px solid var(--border2)",color:"var(--text)",padding:"8px 16px",borderRadius:"var(--radius-sm)",fontWeight:500},
    primary:{background:"var(--nav)",border:"none",color:"#fff",padding:"8px 18px",borderRadius:"var(--radius-sm)",fontWeight:600},
    accent: {background:"var(--accent)",border:"none",color:"#fff",padding:"8px 18px",borderRadius:"var(--radius-sm)",fontWeight:600},
    danger: {background:"#FEE2E2",border:"1.5px solid #FECACA",color:"#7F1D1D",padding:"8px 16px",borderRadius:"var(--radius-sm)",fontWeight:500},
  };
  return<button onClick={onClick} disabled={disabled} style={{...S[variant],...st,opacity:disabled?0.5:1,cursor:disabled?"not-allowed":"pointer"}}>{children}</button>;
};

/* ─── Modal ──────────────────────────────────────────────────────────────── */
const Modal=({title,onClose,wide,children})=>(
  <div onClick={e=>e.target===e.currentTarget&&onClose()} style={{position:"fixed",inset:0,background:"rgba(10,20,40,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:20,backdropFilter:"blur(2px)"}}>
    <div style={{background:"#fff",borderRadius:"var(--radius-lg)",boxShadow:"0 8px 40px rgba(0,0,0,0.18)",width:"100%",maxWidth:wide?780:580,maxHeight:"90vh",overflow:"auto",display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"1rem 1.5rem",borderBottom:"1.5px solid var(--border)",flexShrink:0}}>
        <p style={{fontWeight:700,fontSize:16,color:"var(--text)"}}>{title}</p>
        <button onClick={onClose} style={{background:"var(--surface2)",border:"none",width:28,height:28,borderRadius:"50%",fontSize:17,color:"var(--text2)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
      </div>
      <div style={{padding:"1.25rem 1.5rem",overflow:"auto"}}>{children}</div>
    </div>
  </div>
);

/* ─── Status Badge ───────────────────────────────────────────────────────── */
const STS={Active:{bg:"#D1FAE5",c:"#064E3B"},Amended:{bg:"#FEF3C7",c:"#78350F"},Superseded:{bg:"#FEE2E2",c:"#7F1D1D"},Draft:{bg:"#E0E7FF",c:"#3730A3"}};
const SBadge=({s})=>{ const st=STS[s]||STS.Active; return<span style={{background:st.bg,color:st.c,fontSize:11,fontWeight:600,padding:"2px 9px",borderRadius:20,whiteSpace:"nowrap"}}>{s}</span>; };

/* ─── Reusable File Upload Zone ──────────────────────────────────────────── */
function FileUploadZone({id,color,bg,dashed,desc,onUploaded}){
  const [uploading,setUploading]=useState(false);
  const [err,setErr]=useState("");
  const ref=useRef();

  const [dragging,setDragging]=useState(false);

  async function handle(file){
    if(!file)return;
    setUploading(true);setErr("");
    try{
      const res=await apiUpload([file]);
      if(!res.ok)throw new Error(res.error||"Upload failed");
      const saved=res.files[0];
      // Extract PDF text for search
      let pages=0;
      if(file.name.toLowerCase().endsWith(".pdf")){
        try{
          const b64=await apiBase64(saved.name);
          if(b64){const r=await extractPdfTextFromBase64(b64);pages=r.pages;}
        }catch{}
      }
      onUploaded({name:saved.name,size:saved.size,pages,extractedText});
    }catch(e){setErr(e.message);}
    setUploading(false);
  }

  return(<div>
    <div
      onClick={()=>!uploading&&ref.current?.click()}
      onDrop={e=>{e.preventDefault();setDragging(false);if(!uploading)handle(e.dataTransfer.files[0]);}}
      onDragOver={e=>{e.preventDefault();e.stopPropagation();}}
      onDragEnter={e=>{e.preventDefault();setDragging(true);}}
      onDragLeave={e=>{e.preventDefault();setDragging(false);}}
      style={{border:`2px dashed ${dragging?"#3B82F6":dashed}`,background:dragging?"#EFF6FF":"",borderRadius:"var(--radius-sm)",padding:"1rem",textAlign:"center",cursor:uploading?"wait":"pointer",background:bg,transition:"opacity 0.15s"}}
      onMouseEnter={e=>{if(!uploading)e.currentTarget.style.opacity="0.85";}}
      onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
      {uploading
        ?<div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><Spinner size={16}/><span style={{fontSize:12,color,fontWeight:500}}>Uploading...</span></div>
        :<><p style={{fontSize:20,marginBottom:4}}>📎</p><p style={{fontSize:12,fontWeight:600,color}}>{desc}</p><p style={{fontSize:11,color,opacity:0.7,marginTop:2}}>Click or drag & drop · PDF, images supported</p></>}
    </div>
    <input ref={ref} type="file" accept=".pdf,application/pdf,.png,.jpg,.jpeg" style={{display:"none"}}
      onChange={e=>{handle(e.target.files[0]);e.target.value="";}}/>
    {err&&<p style={{fontSize:11,color:"#DC2626",marginTop:4}}>{err}</p>}
  </div>);
}

/* ─── Entry Form ─────────────────────────────────────────────────────────── */
function EntryForm({catId,docTypeId,initial,onSave,onClose}){
  const cat=TAX_CATS.find(c=>c.id===catId);
  const dt=DOC_TYPES.find(d=>d.id===docTypeId);
  const isNote=["hmnotes","hmexam"].includes(docTypeId);
  const isFoodForThought=docTypeId==="foodforthought";
  const [f,setF]=useState(initial||{title:"",reference:"",articleNo:"",publicationRef:"",decisionNo:"",effectiveDate:"",issueDate:"",year:"",month:"",status:"Active",summary:"",fullText:"",notes:"",flashcards:"",examNotes:"",tags:"",attachedFile:null,notesFile:null,flashFile:null,summaryFile:null,examFile:null});
  const s=(k,v)=>setF(p=>({...p,[k]:v}));
  const fileRef=useRef();
  const [uploading,setUploading]=useState(false);
  const [uploadMsg,setUploadMsg]=useState("");

  async function handleAttach(fileList){
    const file=fileList[0]; if(!file)return;
    setUploading(true);setUploadMsg(`Uploading ${file.name}...`);
    try{
      const res=await apiUpload([file]);
      if(!res.ok)throw new Error(res.error||"Upload failed");
      const saved=res.files[0];
      // Extract text if PDF
      let extractedText="",pages=0;
      if(file.name.toLowerCase().endsWith(".pdf")){
        setUploadMsg("Extracting text from PDF...");
        try{
          const b64=await apiBase64(saved.name);
          if(b64){const r=await extractPdfTextFromBase64(b64);extractedText=r.text;pages=r.pages;}
        }catch{}
      }
      // Save to file library on server (unlimited storage)
      const cappedText = extractedText // No limit;
      const meta={id:genId(),name:saved.name,originalName:saved.original,fileType:file.type,size:saved.size,catId,notes:"",pages,extractedText:cappedText,createdAt:new Date().toISOString()};
      try{
        await fetch(`${API}/files-meta`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify([meta])});
      }catch(e){console.warn("File meta save error:",e);}
      setUploadMsg(`✓ ${saved.name} attached${pages>0?` · ${pages} pages extracted`:""}`);
      s("attachedFile",{name:saved.name,pages,size:saved.size});
    }catch(e){
      setUploadMsg("Error: "+e.message);
    }
    setUploading(false);
  }

  const submit=()=>{
    if(!f.title.trim())return alert("Please enter a title");
    onSave({...f,id:f.id||genId(),catId,docTypeId,createdAt:f.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()});
    onClose();
  };

  return(<div>
    {/* Category/type banner */}
    <div style={{background:cat.color+"12",border:`1px solid ${cat.color}30`,borderRadius:"var(--radius-sm)",padding:"8px 14px",marginBottom:16,display:"flex",gap:8,alignItems:"center"}}>
      <span style={{fontSize:14}}>{dt.icon}</span>
      <span style={{fontSize:13,fontWeight:700,color:cat.color}}>{cat.label}</span>
      <span style={{fontSize:12,color:"var(--text2)"}}>→ {dt.label}</span>
    </div>

    <Field label="Title *"><input style={IS} value={f.title} onChange={e=>s("title",e.target.value)} placeholder={`${dt.label} title...`} autoFocus/></Field>

    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <Field label="Year"><input style={IS} type="number" value={f.year} onChange={e=>s("year",e.target.value)} placeholder="e.g. 2023"/></Field>
      <Field label="Month">
        <select style={SEL} value={f.month} onChange={e=>s("month",e.target.value)}>
          <option value="">— Select month —</option>
          {["January","February","March","April","May","June","July","August","September","October","November","December"].map(m=><option key={m}>{m}</option>)}
        </select>
      </Field>
    </div>

    {!isNote&&<>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Field label="Law / Reference"><input style={IS} value={f.reference} onChange={e=>s("reference",e.target.value)} placeholder="e.g. Article 21, CT Law"/></Field>
        <Field label="Article / Section No."><input style={IS} value={f.articleNo} onChange={e=>s("articleNo",e.target.value)} placeholder="e.g. Art. 21(1)(b)"/></Field>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Field label={["ministerial","cabinet","fta"].includes(docTypeId)?"Decision No.":"Publication / Ref. No."}>
          <input style={IS}
            value={["ministerial","cabinet","fta"].includes(docTypeId)?f.decisionNo:f.publicationRef}
            onChange={e=>s(["ministerial","cabinet","fta"].includes(docTypeId)?"decisionNo":"publicationRef",e.target.value)}
            placeholder={
              docTypeId==="cabinet"?"e.g. Cabinet Decision No. 49 of 2023":
              docTypeId==="ministerial"?"e.g. Ministerial Decision No. 114 of 2023":
              docTypeId==="fta"?"e.g. FTA Decision No. 3 of 2023":
              "e.g. CTP001 / VATG001"
            }/>
        </Field>
        <Field label="Status"><select style={SEL} value={f.status} onChange={e=>s("status",e.target.value)}>{["Active","Amended","Superseded","Draft"].map(x=><option key={x}>{x}</option>)}</select></Field>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Field label="Effective Date"><input style={IS} type="date" value={f.effectiveDate} onChange={e=>s("effectiveDate",e.target.value)}/></Field>
        <Field label="Issue Date"><input style={IS} type="date" value={f.issueDate} onChange={e=>s("issueDate",e.target.value)}/></Field>
      </div>
    </>}
    {isNote&&<Field label="Status"><select style={SEL} value={f.status} onChange={e=>s("status",e.target.value)}>{["Active","Amended","Superseded","Draft"].map(x=><option key={x}>{x}</option>)}</select></Field>}

    {/* ── PDF Attachment ────────────────────────────────────────────── */}
    <Field label="Attach PDF / Document">
      <input type="file" ref={fileRef} onChange={e=>handleAttach(e.target.files)} accept=".pdf,application/pdf,image/*,.txt" style={{display:"none"}}/>
      {f.attachedFile?(
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"#ECFDF5",border:"1.5px solid #6EE7B7",borderRadius:"var(--radius-sm)"}}>
          <span style={{fontSize:20}}>📄</span>
          <div style={{flex:1,minWidth:0}}>
            <p style={{fontWeight:600,fontSize:13,color:"#064E3B",wordBreak:"break-word"}}>{f.attachedFile.name}</p>
            <p style={{fontSize:11,color:"#059669"}}>
              {fmtSize(f.attachedFile.size)}{f.attachedFile.pages>0?` · ${f.attachedFile.pages} pages extracted & searchable`:""} · saved to your PC
            </p>
          </div>
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            <a href={fileViewUrl(f.attachedFile.name)} target="_blank" rel="noreferrer" style={{padding:"4px 10px",fontSize:12,background:"#fff",border:"1px solid #6EE7B7",borderRadius:"var(--radius-sm)",color:"#064E3B",textDecoration:"none",cursor:"pointer"}}>👁 View</a>
            <button onClick={()=>s("attachedFile",null)} style={{padding:"4px 10px",fontSize:12,background:"#FEE2E2",border:"1px solid #FECACA",borderRadius:"var(--radius-sm)",color:"#7F1D1D",cursor:"pointer"}}>Remove</button>
          </div>
        </div>
      ):(
        <div
          onClick={()=>!uploading&&fileRef.current?.click()}
          onDrop={e=>{e.preventDefault();e.stopPropagation();if(!uploading)handleAttach(e.dataTransfer.files);}}
          onDragOver={e=>{e.preventDefault();e.stopPropagation();}}
          onDragEnter={e=>e.preventDefault()}
          onDragLeave={e=>e.preventDefault()}
          style={{border:"2px dashed var(--border2)",borderRadius:"var(--radius-sm)",padding:"1rem",textAlign:"center",cursor:uploading?"wait":"pointer",background:"var(--surface2)",transition:"background 0.15s"}}
          onMouseEnter={e=>{if(!uploading)e.currentTarget.style.background="#E2E8F0";}}
          onMouseLeave={e=>e.currentTarget.style.background="var(--surface2)"}>
          {uploading?(
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
              <Spinner size={18}/>
              <span style={{fontSize:13,color:"var(--text2)",fontWeight:500}}>{uploadMsg}</span>
            </div>
          ):(
            <>
              <p style={{fontSize:22,marginBottom:4}}>📎</p>
              <p style={{fontSize:13,fontWeight:600,color:"var(--text2)"}}>Click or drag a PDF here</p>
              <p style={{fontSize:11,color:"var(--text3)",marginTop:3}}>PDF uploaded to your PC · text extracted · file becomes searchable</p>
            </>
          )}
        </div>
      )}
      {uploadMsg&&!uploading&&<p style={{fontSize:12,color:uploadMsg.startsWith("Error")?"#DC2626":"#059669",marginTop:6,fontWeight:500}}>{uploadMsg}</p>}
    </Field>

    <Field label={isFoodForThought?"Scenario / Question":isNote?"Content":"Summary"}><textarea style={TA} value={f.summary} onChange={e=>s("summary",e.target.value)} placeholder={isFoodForThought?"Describe the real-world scenario or question...":isNote?"Write your content, study notes, exam insights...":"Brief summary of this provision..."}/></Field>
    {!isNote&&!isFoodForThought&&<Field label="Full Text / Verbatim"><textarea style={{...TA,minHeight:120}} value={f.fullText} onChange={e=>s("fullText",e.target.value)} placeholder="Paste the complete legal text here (or leave blank if PDF attached above)..."/></Field>}
    {isFoodForThought&&(
      <div style={{background:"#FFF7ED",border:"1.5px solid #FED7AA",borderRadius:8,padding:"14px 16px",marginBottom:12}}>
        <p style={{fontSize:11,fontWeight:800,color:"#C2410C",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>🧠 Food for Thought Fields</p>
        <Field label="Answer / Analysis"><textarea style={{...TA,minHeight:100,background:"#fff"}} value={f.fullText||""} onChange={e=>s("fullText",e.target.value)} placeholder="Write the detailed answer, analysis, and conclusion for this scenario..."/></Field>
        <Field label="Law References"><textarea style={{...TA,minHeight:60,background:"#fff"}} value={f.articleNo||""} onChange={e=>s("articleNo",e.target.value)} placeholder="e.g. Article 55, Federal Decree-Law No. 8/2017 — Pre-registration input tax..."/></Field>
        <Field label="Key Takeaway"><textarea style={{...TA,minHeight:50,background:"#fff"}} value={f.examNotes||""} onChange={e=>s("examNotes",e.target.value)} placeholder="What is the key practical lesson from this case?"/></Field>
      </div>
    )}
    <Field label="Tags (comma separated)"><input style={IS} value={f.tags} onChange={e=>s("tags",e.target.value)} placeholder="e.g. threshold, relief, exemption, small business"/></Field>

    {/* ── Notes, Flashcards, Summary, Exam — each with text + optional PDF ── */}
    {[
      { textKey:"notes",     fileKey:"notesFile",   label:"Notes",          icon:"✏",  color:"#0EA5E9", bg:"#F0F9FF", dashed:"#7DD3FC", placeholder:"Write your personal notes, observations, exam tips..." },
      { textKey:"flashcards",fileKey:"flashFile",   label:"Flashcards",     icon:"🃏", color:"#F59E0B", bg:"#FFFBEB", dashed:"#FCD34D", placeholder:"Write key points, definitions, rules to memorize..." },
      { textKey:"summary",   fileKey:"summaryFile", label:"Summary",        icon:"≡",  color:"#10B981", bg:"#F0FDF4", dashed:"#6EE7B7", placeholder:"Write a brief summary of this law / provision..." },
      { textKey:"examNotes", fileKey:"examFile",    label:"Exam Material",  icon:"🎓", color:"#8B5CF6", bg:"#F5F3FF", dashed:"#C4B5FD", placeholder:"Write exam tips, past questions, key scenarios..." },
    ].map(({textKey,fileKey,label,icon,color,bg,dashed,placeholder})=>(
      <div key={textKey} style={{marginBottom:"1.25rem",background:bg,border:`1.5px solid ${dashed}`,borderRadius:"var(--radius)",padding:"1rem",transition:"box-shadow 0.15s"}}>
        {/* Section header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <p style={{fontSize:12,fontWeight:700,color,textTransform:"uppercase",letterSpacing:"0.06em"}}>{icon} {label}</p>
          <span style={{fontSize:11,color,opacity:0.6}}>text + PDF both optional</span>
        </div>

        {/* Text area */}
        <textarea
          value={f[textKey]||""}
          onChange={e=>s(textKey,e.target.value)}
          placeholder={placeholder}
          style={{...TA,minHeight:72,border:`1px solid ${dashed}`,background:"#fff",marginBottom:10,display:"block"}}/>

        {/* File attachment */}
        {f[fileKey]?(
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"#fff",border:`1px solid ${dashed}`,borderRadius:"var(--radius-sm)"}}>
            <span style={{fontSize:18,flexShrink:0}}>📄</span>
            <div style={{flex:1,minWidth:0}}>
              <p style={{fontWeight:600,fontSize:12,color,wordBreak:"break-word"}}>{f[fileKey].name}</p>
              <p style={{fontSize:11,color,opacity:0.65}}>{fmtSize(f[fileKey].size)}{f[fileKey].pages>0?` · ${f[fileKey].pages} pages`:""}</p>
            </div>
            <a href={fileViewUrl(f[fileKey].name)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}
              style={{padding:"3px 9px",fontSize:11,background:"#fff",border:`1px solid ${dashed}`,borderRadius:20,color,textDecoration:"none",fontWeight:600,flexShrink:0}}>👁 View</a>
            <button onClick={()=>s(fileKey,null)}
              style={{padding:"3px 9px",fontSize:11,background:"#FEE2E2",border:"1px solid #FECACA",borderRadius:20,color:"#7F1D1D",cursor:"pointer",flexShrink:0}}>✕ Remove</button>
          </div>
        ):(
          <FileUploadZone
            id={`file-${fileKey}-${catId}`}
            color={color} bg={"#fff"} dashed={dashed}
            desc={`Attach ${label} PDF (optional)`}
            onUploaded={fileInfo=>s(fileKey,fileInfo)}/>
        )}
      </div>
    ))}

    <div style={{display:"flex",gap:10,marginTop:8}}>
      <Btn onClick={submit} variant="primary" disabled={uploading}>Save Entry</Btn>
      <Btn onClick={onClose} variant="default">Cancel</Btn>
    </div>
  </div>);
}

/* ─── Detail Modal ───────────────────────────────────────────────────────── */
const DRow=({l,v})=>v?<div style={{display:"flex",gap:16,padding:"8px 0",borderBottom:"1px solid var(--border)"}}><span style={{fontSize:12,color:"var(--text2)",minWidth:140,fontWeight:600}}>{l}</span><span style={{fontSize:13}}>{v}</span></div>:null;
const DBlock=({l,v,accent})=>v?<div style={{marginTop:14,background:accent?"#FFFBEB":"var(--surface2)",borderRadius:"var(--radius-sm)",padding:"12px 14px",border:accent?"1.5px solid #FDE68A":"1.5px solid var(--border)"}}><p style={{fontSize:10,fontWeight:700,color:accent?"#92400E":"var(--text2)",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.06em"}}>{l}</p><p style={{fontSize:13,lineHeight:1.75,whiteSpace:"pre-wrap",color:accent?"#78350F":"var(--text)"}}>{v}</p></div>:null;

function DetailModal({item,onClose,onEdit,onDelete,onAI}){
  const cat=TAX_CATS.find(c=>c.id===item.catId);
  const dt=DOC_TYPES.find(d=>d.id===item.docTypeId);
  return(<Modal title={item.title} onClose={onClose} wide>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16,alignItems:"center"}}>
      {cat&&<span style={{background:cat.color+"18",color:cat.color,fontSize:12,fontWeight:700,padding:"3px 11px",borderRadius:20}}>{cat.label}</span>}
      {dt&&<span style={{background:"var(--surface2)",color:"var(--text2)",fontSize:12,fontWeight:500,padding:"3px 11px",borderRadius:20}}>{dt.icon} {dt.label}</span>}
      {item.status&&<SBadge s={item.status}/>}
      <button onClick={onAI} style={{marginLeft:"auto",background:"#FFF8EC",border:"1.5px solid #FCD34D",color:"#854F0B",padding:"5px 14px",borderRadius:20,fontWeight:600,fontSize:12,cursor:"pointer"}}>◈ AI Actions</button>
    </div>
    <DRow l="Reference"         v={item.reference}/>
    <DRow l="Article No."       v={item.articleNo}/>
    <DRow l="Publication Ref."  v={item.publicationRef}/>
    <DRow l="Decision No."      v={item.decisionNo}/>
    <DRow l="Effective Date"    v={fmt(item.effectiveDate)}/>
    <DRow l="Issue Date"        v={fmt(item.issueDate)}/>

    {/* Attached PDF */}
    {item.attachedFile&&(
      <div style={{marginTop:12,marginBottom:4,background:"#F0FDF4",border:"1.5px solid #86EFAC",borderRadius:"var(--radius-sm)",padding:"12px 14px",display:"flex",alignItems:"center",gap:12}}>
        <span style={{fontSize:24,flexShrink:0}}>📄</span>
        <div style={{flex:1,minWidth:0}}>
          <p style={{fontWeight:700,fontSize:13,color:"#15803D",wordBreak:"break-word"}}>{item.attachedFile.name}</p>
          <p style={{fontSize:11,color:"#16A34A",marginTop:2}}>
            {fmtSize(item.attachedFile.size)}{item.attachedFile.pages>0?` · ${item.attachedFile.pages} pages`:""} · stored on your PC
          </p>
        </div>
        <div style={{display:"flex",gap:8,flexShrink:0}}>
          <a href={fileViewUrl(item.attachedFile.name)} target="_blank" rel="noreferrer"
            style={{padding:"6px 14px",background:"#15803D",border:"none",borderRadius:"var(--radius-sm)",color:"#fff",fontWeight:600,fontSize:12,textDecoration:"none",cursor:"pointer"}}>
            👁 Open PDF
          </a>
          <button onClick={()=>downloadFile(item.attachedFile.name)} style={{padding:"6px 14px",background:"#1E40AF",color:"#fff",border:"none",borderRadius:"var(--radius-sm)",fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>⬇ Download</button>
        </div>
      </div>
    )}

    <DBlock l="Summary / Content" v={item.summary}/>
    {item.docTypeId==="foodforthought"&&item.fullText&&(
      <div style={{marginTop:14,background:"#FFF7ED",border:"1.5px solid #FED7AA",borderRadius:10,padding:"16px 18px"}}>
        <p style={{fontSize:10,fontWeight:800,color:"#C2410C",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>🧠 Answer / Analysis</p>
        <p style={{fontSize:13,lineHeight:1.8,color:"#1C1917",whiteSpace:"pre-wrap"}}>{item.fullText}</p>
      </div>
    )}
    {item.docTypeId==="foodforthought"&&item.articleNo&&(
      <div style={{marginTop:10,background:"#EFF6FF",border:"1.5px solid #BFDBFE",borderRadius:10,padding:"14px 16px"}}>
        <p style={{fontSize:10,fontWeight:800,color:"#1D4ED8",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>⚖ Law References</p>
        <p style={{fontSize:12.5,lineHeight:1.8,color:"#1E3A5F",whiteSpace:"pre-wrap"}}>{item.articleNo}</p>
      </div>
    )}
    {item.docTypeId==="foodforthought"&&item.examNotes&&(
      <div style={{marginTop:10,background:"#F0FDF4",border:"1.5px solid #BBF7D0",borderRadius:10,padding:"14px 16px"}}>
        <p style={{fontSize:10,fontWeight:800,color:"#15803D",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>✅ Key Takeaway</p>
        <p style={{fontSize:12.5,lineHeight:1.8,color:"#14532D",whiteSpace:"pre-wrap"}}>{item.examNotes}</p>
      </div>
    )}
    <DBlock l="Full Text"         v={item.fullText}/>
    <DBlock l="Full Text" v={item.fullText}/>
    {item.tags&&<p style={{fontSize:12,color:"var(--text2)",marginTop:12}}>🏷 {item.tags}</p>}

    {/* Notes, Flashcards, Summary, Exam — text + file */}
    <div style={{marginTop:16,display:"flex",flexDirection:"column",gap:12}}>
      {[
        {textKey:"notes",     fileKey:"notesFile",   label:"Notes",         icon:"✏",  color:"#0EA5E9", bg:"#F0F9FF", bd:"#7DD3FC"},
        {textKey:"flashcards",fileKey:"flashFile",   label:"Flashcards",    icon:"🃏", color:"#F59E0B", bg:"#FFFBEB", bd:"#FCD34D"},
        {textKey:"summary",   fileKey:"summaryFile", label:"Summary",       icon:"≡",  color:"#10B981", bg:"#F0FDF4", bd:"#6EE7B7"},
        {textKey:"examNotes", fileKey:"examFile",    label:"Exam Material", icon:"🎓", color:"#8B5CF6", bg:"#F5F3FF", bd:"#C4B5FD"},
      ].filter(x=>item[x.textKey]||item[x.fileKey]).map(({textKey,fileKey,label,icon,color,bg,bd})=>(
        <div key={textKey} style={{background:bg,border:`1.5px solid ${bd}`,borderRadius:"var(--radius-sm)",padding:"12px 14px"}}>
          <p style={{fontSize:11,fontWeight:700,color,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>{icon} {label}</p>
          {item[textKey]&&<p style={{fontSize:13,lineHeight:1.75,color:"var(--text)",whiteSpace:"pre-wrap",marginBottom:item[fileKey]?10:0}}>{item[textKey]}</p>}
          {item[fileKey]&&(
            <a href={fileViewUrl(item[fileKey].name)} target="_blank" rel="noreferrer"
              style={{display:"inline-flex",alignItems:"center",gap:8,padding:"5px 12px",background:"#fff",border:`1px solid ${bd}`,borderRadius:20,textDecoration:"none",color,fontWeight:600,fontSize:12}}>
              📄 {item[fileKey].name}{item[fileKey].pages>0?` (${item[fileKey].pages}p)`:""} — Open PDF
            </a>
          )}
        </div>
      ))}
    </div>

    {/* Original Law PDF */}
    {item.attachedFile&&(
      <div style={{marginTop:12,background:"#F0FDF4",border:"1.5px solid #6EE7B7",borderRadius:"var(--radius-sm)",padding:"10px 14px",display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:20}}>📄</span>
        <div style={{flex:1,minWidth:0}}>
          <p style={{fontSize:11,fontWeight:700,color:"#059669",textTransform:"uppercase",letterSpacing:"0.04em"}}>Original Law PDF</p>
          <p style={{fontSize:12,color:"#059669",wordBreak:"break-word"}}>{item.attachedFile.name}</p>
        </div>
        <a href={fileViewUrl(item.attachedFile.name)} target="_blank" rel="noreferrer"
          style={{padding:"5px 12px",background:"#059669",border:"none",borderRadius:20,color:"#fff",fontWeight:600,fontSize:12,textDecoration:"none"}}>Open →</a>
      </div>
    )}
    <div style={{display:"flex",gap:10,marginTop:20,paddingTop:16,borderTop:"1.5px solid var(--border)"}}>
      <Btn onClick={onEdit} variant="default">Edit</Btn>
      <Btn onClick={onDelete} variant="danger">Delete</Btn>
    </div>
  </Modal>);
}

/* ─── Table Row ──────────────────────────────────────────────────────────── */
function TableRow({item,onClick,onMove}){
  return(
    <tr onClick={onClick}
      onMouseEnter={e=>e.currentTarget.style.background="#F8FAFF"}
      onMouseLeave={e=>e.currentTarget.style.background="#fff"}
      style={{cursor:"pointer",transition:"background 0.1s",borderBottom:"1px solid var(--border)"}}>
      <td style={{padding:"10px 12px",fontSize:12,color:"var(--text2)",whiteSpace:"nowrap"}}>{item.year||"—"}</td>
      <td style={{padding:"10px 12px",fontSize:12,color:"var(--text2)",whiteSpace:"nowrap"}}>{item.month||"—"}</td>
      <td style={{padding:"10px 12px",fontSize:12,color:"var(--text2)",whiteSpace:"nowrap",maxWidth:100,overflow:"hidden",textOverflow:"ellipsis"}}>{item.reference||item.decisionNo||item.publicationRef||"—"}</td>
      <td style={{padding:"10px 12px",fontSize:13,fontWeight:600,color:"var(--text)",maxWidth:280}}>
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          <span>{item.title}</span>
          {item.status&&<SBadge s={item.status}/>}
        </div>
        {item.articleNo&&<p style={{fontSize:11,color:"var(--text2)",marginTop:2,fontWeight:400}}>{item.articleNo}</p>}
      </td>
      <td style={{padding:"10px 12px",fontSize:12,color:"var(--text2)",maxWidth:180}}>
        <p style={{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",lineHeight:1.5}}>{item.notes||"—"}</p>
      </td>
      <td style={{padding:"10px 12px",textAlign:"center"}}>
        {item.notesFile
          ?<a href={fileViewUrl(item.notesFile.name)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{background:"#F0F9FF",color:"#0EA5E9",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20,textDecoration:"none"}}>📄 PDF</a>
          :<span style={{color:"var(--text3)",fontSize:12}}>—</span>}
      </td>
      <td style={{padding:"10px 12px",textAlign:"center"}}>
        {item.flashFile
          ?<a href={fileViewUrl(item.flashFile.name)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{background:"#FFFBEB",color:"#F59E0B",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20,textDecoration:"none"}}>📄 PDF</a>
          :<span style={{color:"var(--text3)",fontSize:12}}>—</span>}
      </td>
      <td style={{padding:"10px 12px",textAlign:"center"}}>
        {item.summaryFile
          ?<a href={fileViewUrl(item.summaryFile.name)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{background:"#F0FDF4",color:"#10B981",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20,textDecoration:"none"}}>📄 PDF</a>
          :<span style={{color:"var(--text3)",fontSize:12}}>—</span>}
      </td>
      <td style={{padding:"10px 12px",textAlign:"center"}}>
        {item.examFile
          ?<a href={fileViewUrl(item.examFile.name)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{background:"#F5F3FF",color:"#8B5CF6",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20,textDecoration:"none"}}>📄 PDF</a>
          :<span style={{color:"var(--text3)",fontSize:12}}>—</span>}
      </td>
      <td style={{padding:"6px 8px",textAlign:"center"}} onClick={e=>e.stopPropagation()}>
        {onMove&&<button onClick={()=>onMove(item)} title="Move to another section"
          style={{padding:"4px 10px",background:"#F8FAFF",border:"1px solid #BFDBFE",borderRadius:5,fontSize:10,fontWeight:700,cursor:"pointer",color:"#1D4ED8",whiteSpace:"nowrap"}}>
          ⇄ Move
        </button>}
      </td>
    </tr>
  );
}

/* ─── Entry Card (search results only) ──────────────────────────────────── */
function EntryCard({item,onClick,searchQ}){
  const dt=DOC_TYPES.find(d=>d.id===item.docTypeId);
  const cat=TAX_CATS.find(c=>c.id===item.catId);
  return(<div onClick={onClick}
    onMouseEnter={e=>{e.currentTarget.style.boxShadow="var(--shadow-md)";e.currentTarget.style.borderColor="#94A3B8";}}
    onMouseLeave={e=>{e.currentTarget.style.boxShadow="var(--shadow)";e.currentTarget.style.borderColor="var(--border)";}}
    style={{background:"#fff",border:"1.5px solid var(--border)",borderRadius:"var(--radius)",padding:"1rem 1.25rem",cursor:"pointer",boxShadow:"var(--shadow)",transition:"box-shadow 0.15s,border-color 0.15s"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:8}}>
      <div style={{display:"flex",gap:8,flex:1,minWidth:0}}>
        {dt&&<span style={{fontSize:15,flexShrink:0,marginTop:1}}>{dt.icon}</span>}
        <p style={{fontWeight:600,fontSize:14,lineHeight:1.4,color:"var(--text)"}}>{item.title}</p>
      </div>
      {item.status&&<SBadge s={item.status}/>}
    </div>
    {cat&&searchQ&&<span style={{background:cat.color+"18",color:cat.color,fontSize:10,fontWeight:700,padding:"1px 8px",borderRadius:20,marginLeft:23,marginBottom:6,display:"inline-block"}}>{cat.label}</span>}
    {[item.reference,item.articleNo].filter(Boolean).join(" · ")&&<p style={{fontSize:12,color:"var(--text2)",marginBottom:6,marginLeft:23}}>{[item.reference,item.articleNo].filter(Boolean).join(" · ")}</p>}
    {(item.publicationRef||item.decisionNo)&&<p style={{fontSize:12,color:"var(--text2)",marginBottom:6,marginLeft:23}}>{item.publicationRef||item.decisionNo}{item.issueDate?` · ${fmt(item.issueDate)}`:""}</p>}
    {searchQ&&item._matchIn
      ?<p style={{fontSize:12,color:"#065F46",background:"#ECFDF5",padding:"4px 10px",borderRadius:4,lineHeight:1.6,fontStyle:"italic",marginLeft:23}}>...{hilite(item.summary||item.fullText||"",searchQ)}...</p>
      :item.summary&&<p style={{fontSize:12,color:"var(--text2)",lineHeight:1.55,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",marginLeft:23}}>{item.summary}</p>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:10}}>
      <div style={{display:"flex",gap:6}}>
        {item.attachedFile&&<span style={{fontSize:11,color:"#059669",fontWeight:600}}>📎 Law PDF</span>}
        {item.summaryFile&&<span style={{fontSize:11,color:"#1D4ED8",fontWeight:600}}>📄 Summary</span>}
        {item.examFile&&<span style={{fontSize:11,color:"#7C3AED",fontWeight:600}}>📄 Exam</span>}
        {item.flashcards&&<span style={{fontSize:11,color:"#92400E",fontWeight:600}}>🃏 Flashcards</span>}
      </div>
      <span style={{fontSize:11,color:"var(--text3)"}}>{fmt(item.updatedAt||item.createdAt)}</span>
    </div>
  </div>);
}
/* ─── Drop Destination Picker ───────────────────────────────────────────── */
function DropDestPicker({cat, onCancel, onSave}){
  const [droppedData,setDroppedData]=useState(null);
  const [destCat,setDestCat]=useState(cat.id);
  const [destDt,setDestDt]=useState(docTypesForCat(cat.id)[0].id);
  const [hovering,setHovering]=useState(false);

  // Handle drop on the ENTIRE overlay (not just the box)
  const handleDrop=e=>{
    e.preventDefault();e.stopPropagation();setHovering(false);
    const files=e.dataTransfer.files;
    if(files&&files.length>0){
      setDroppedData({files,url:null,names:Array.from(files).map(f=>f.name)});
    } else {
      const raw=e.dataTransfer.getData("text/uri-list")||e.dataTransfer.getData("text/plain")||"";
      const url=raw.trim().split(/\s+/)[0];
      if(url&&url.startsWith("http")){
        const name=decodeURIComponent(url.split("/").pop().split("?")[0])||url.slice(0,60);
        setDroppedData({files:null,url,names:[name]});
      }
    }
  };

  const dts=docTypesForCat(destCat);
  const selCat=TAX_CATS.find(c=>c.id===destCat);
  const selDt=dts.find(d=>d.id===destDt);

  return(
    <div
      onDrop={handleDrop}
      onDragOver={e=>{e.preventDefault();e.stopPropagation();setHovering(true);}}
      onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget))setHovering(false);}}
      style={{position:"fixed",inset:0,zIndex:600,background:hovering?"rgba(30,58,95,0.92)":"rgba(15,23,42,0.80)",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)",transition:"background 0.15s"}}>

      {hovering&&!droppedData&&(
        <div style={{textAlign:"center",color:"#fff",pointerEvents:"none"}}>
          <p style={{fontSize:64,marginBottom:12}}>📂</p>
          <p style={{fontSize:24,fontWeight:800}}>Release to drop</p>
        </div>
      )}

      {!hovering&&(
      <div style={{background:"#fff",borderRadius:16,padding:"28px 32px",width:580,maxWidth:"95vw",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 25px 80px rgba(0,0,0,0.5)"}}>

        {!droppedData?(
          <>
            <h3 style={{fontSize:16,fontWeight:800,color:"#1E3A5F",marginBottom:12,textAlign:"center"}}>🔗 Add from Link or File</h3>
            {/* Drop zone */}
            <div style={{border:"3px dashed #BFDBFE",borderRadius:12,padding:"28px 20px",textAlign:"center",background:"#F0F9FF",marginBottom:12}}>
              <p style={{fontSize:32,marginBottom:8}}>⬇</p>
              <p style={{fontSize:14,fontWeight:700,color:"#1E3A5F"}}>Drop a PDF file here</p>
              <p style={{fontSize:11,color:"#64748B",marginTop:4}}>Drag from File Explorer or Downloads folder</p>
            </div>

            {/* Divider */}
            <div style={{display:"flex",alignItems:"center",gap:10,margin:"12px 0"}}>
              <div style={{flex:1,height:1,background:"#E2E8F0"}}/>
              <span style={{fontSize:11,color:"#94A3B8",fontWeight:600}}>OR PASTE A URL</span>
              <div style={{flex:1,height:1,background:"#E2E8F0"}}/>
            </div>

            {/* URL input */}
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <input
                id="url-input"
                type="text"
                placeholder="https://tax.gov.ae/...pdf"
                style={{flex:1,padding:"9px 12px",border:"1.5px solid #BFDBFE",borderRadius:8,fontSize:12,outline:"none"}}
                onKeyDown={e=>{
                  if(e.key==="Enter"){
                    const url=e.target.value.trim();
                    if(url&&url.startsWith("http")){
                      setDroppedData({files:null,url,names:[decodeURIComponent(url.split("/").pop().split("?")[0])||url.slice(0,60)]});
                    }
                  }
                }}
              />
              <button
                onClick={()=>{
                  const inp=document.getElementById("url-input");
                  const url=(inp?.value||"").trim();
                  if(url&&url.startsWith("http")){
                    setDroppedData({files:null,url,names:[decodeURIComponent(url.split("/").pop().split("?")[0])||url.slice(0,60)]});
                  } else {
                    inp?.focus();
                  }
                }}
                style={{padding:"9px 18px",background:"#1E3A5F",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                ⬇ Download
              </button>
            </div>
            <p style={{fontSize:10,color:"#94A3B8",marginBottom:12,textAlign:"center"}}>
              Right-click any PDF link → "Copy link address" → paste above
            </p>

            <button onClick={onCancel} style={{width:"100%",padding:"9px",background:"#F1F5F9",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600,color:"#64748B"}}>Cancel</button>
          </>
        ):(
          <>
            <h3 style={{fontSize:15,fontWeight:800,color:"#1E3A5F",marginBottom:10}}>Choose where to save</h3>
            <div style={{background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:8,padding:"8px 14px",marginBottom:16,fontSize:12,color:"#065F46"}}>
              {droppedData.names.map((n,i)=><div key={i} style={{marginBottom:2}}>📄 {n}</div>)}
            </div>

            <p style={{fontSize:11,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Tax Category</p>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
              {TAX_CATS.map(c=>(
                <button key={c.id} onClick={()=>{setDestCat(c.id);setDestDt(docTypesForCat(c.id)[0].id);}}
                  style={{padding:"6px 16px",borderRadius:20,border:"2px solid "+(destCat===c.id?c.color:"#E2E8F0"),background:destCat===c.id?c.color:"#fff",color:destCat===c.id?"#fff":"#64748B",fontSize:12,fontWeight:600,cursor:"pointer",transition:"all 0.1s"}}>
                  {c.label}
                </button>
              ))}
            </div>

            <p style={{fontSize:11,fontWeight:700,color:"#94A3B8",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>Document Type</p>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:22}}>
              {dts.map(d=>(
                <button key={d.id} onClick={()=>setDestDt(d.id)}
                  style={{padding:"6px 16px",borderRadius:20,border:"2px solid "+(destDt===d.id?"#1E3A5F":"#E2E8F0"),background:destDt===d.id?"#1E3A5F":"#fff",color:destDt===d.id?"#fff":"#64748B",fontSize:12,fontWeight:600,cursor:"pointer",transition:"all 0.1s"}}>
                  {d.icon} {d.label}
                </button>
              ))}
            </div>

            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>onSave(droppedData.files,droppedData.url,destCat,destDt)}
                style={{flex:1,padding:"12px",background:"#1E3A5F",color:"#fff",border:"none",borderRadius:8,fontSize:13,fontWeight:700,cursor:"pointer"}}>
                ✓ Save to {selCat?.label} / {selDt?.label}
              </button>
              <button onClick={()=>setDroppedData(null)}
                style={{padding:"12px 16px",background:"#FEF9C3",border:"1px solid #FDE68A",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,color:"#92400E"}}>
                ↩ Change
              </button>
              <button onClick={onCancel}
                style={{padding:"12px 16px",background:"#F1F5F9",border:"none",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,color:"#64748B"}}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}

/* ─── Category Page ──────────────────────────────────────────────────────── */
function CatPage({cat,entries,files=[],onAdd,onBulkSave,onItem,activeType,onChangeType,onSearchAll}){
  const [q,setQ]=useState("");
  const [bulkUploading,setBulkUploading]=useState(false);
  const [bulkStatus,setBulkStatus]=useState("");
  const [showDropPicker,setShowDropPicker]=useState(false);
  const [sortBy,setSortBy]=useState("year-desc");
  const [filterYear,setFilterYear]=useState("all");
  const [filterMonth,setFilterMonth]=useState("all");
  const [filterStatus,setFilterStatus]=useState("all");
  const [moveModal,setMoveModal]=useState(null); // entry to move
  const bulkRef=useRef();
  const dropRef=useRef();


  const tabs=docTypesForCat(cat.id);
  const dt=tabs.find(d=>d.id===activeType)||tabs[0];
  const catEntries=entries.filter(e=>e.catId===cat.id);
  const allTypeEntries=catEntries.filter(e=>e.docTypeId===dt.id);
  // Filter
  const filteredEntries=allTypeEntries.filter(e=>{
    if(filterYear!=="all" && e.year!==filterYear) return false;
    if(filterMonth!=="all" && (e.month||"").toLowerCase()!==(filterMonth||"").toLowerCase()) return false;
    if(filterStatus!=="all" && (e.status||"Active")!==filterStatus) return false;
    return true;
  });
  // Sort
  const MONTHS={"january":1,"february":2,"march":3,"april":4,"may":5,"june":6,"july":7,"august":8,"september":9,"october":10,"november":11,"december":12};
  const monthNum=e=>MONTHS[(e.month||"").toLowerCase()]||0;
  const yearNum=e=>parseInt(e.year||"0")||0;
  // Combined year+month sort value: year*100 + month (e.g. 202504 = April 2025)
  const dateVal=e=>yearNum(e)*100+monthNum(e);

  const typeEntries=[...filteredEntries].sort((a,b)=>{
    if(sortBy==="year-desc") return dateVal(b)-dateVal(a);
    if(sortBy==="year-asc") return dateVal(a)-dateVal(b);
    if(sortBy==="title-asc") return (a.title||"").localeCompare(b.title||"");
    if(sortBy==="title-desc") return (b.title||"").localeCompare(a.title||"");
    if(sortBy==="ref-asc") return (a.reference||"").localeCompare(b.reference||"");
    if(sortBy==="newest") return new Date(b.createdAt||0)-new Date(a.createdAt||0);
    return 0;
  });
  // Get unique years and months for filter dropdowns
  const availYears=[...new Set(allTypeEntries.map(e=>e.year).filter(Boolean))].sort((a,b)=>b.localeCompare(a));
  const availMonths=["January","February","March","April","May","June","July","August","September","October","November","December"];
  const counts=Object.fromEntries(tabs.map(d=>[d.id,catEntries.filter(e=>e.docTypeId===d.id).length]));

  const qLow=q.trim().toLowerCase();
  const searching=qLow.length>0;
  const textKeys=["title","reference","articleNo","decisionNo","publicationRef","summary","fullText","notes","flashcards","examNotes","tags"];

  const pdfText=(ref)=>{
    if(!ref) return "";
    if(ref.extractedText) return ref.extractedText;
    const f=files.find(f=>f.name===ref.name);
    return f?.extractedText||"";
  };

  // Build flat rows: one row per passage match
  const buildRows=()=>{
    const rows=[];
    allTypeEntries.forEach(e=>{
      // Text field matches → one row per field
      textKeys.forEach(k=>{
        if(!e[k]) return;
        const val=e[k];
        if(!val.toLowerCase().includes(qLow)) return;
        const snippets=getPagedSnippets(val,q);
        if(snippets.length>0){
          snippets.slice(0,3).forEach(ps=>{
            rows.push({entry:e,source:k==="title"?"Title":k==="summary"?"Summary":k==="fullText"?"Full Text":k==="notes"?"Notes":k==="flashcards"?"Flashcards":k==="examNotes"?"Exam":k,snippet:ps.snippet,page:ps.page,fileName:null,inPdf:false});
          });
        } else {
          // Fallback: use hilite result
          rows.push({entry:e,source:k==="title"?"Title":k==="summary"?"Summary":k==="fullText"?"Full Text":k==="notes"?"Notes":k==="flashcards"?"Flashcards":k==="examNotes"?"Exam":k,snippet:hilite(val,q),page:null,fileName:null,inPdf:false});
        }
      });
      // PDF matches → one row per page
      [{ref:e.attachedFile,label:"Law PDF"},{ref:e.notesFile,label:"Notes PDF"},{ref:e.flashFile,label:"Flash PDF"},{ref:e.summaryFile,label:"Summary PDF"},{ref:e.examFile,label:"Exam PDF"}]
        .filter(x=>x.ref)
        .forEach(({ref,label})=>{
          const txt=pdfText(ref);
          if(!txt.toLowerCase().includes(qLow)) return;
          const passages=getPagedSnippets(txt,q);
          if(passages.length>0){
            passages.slice(0,4).forEach(ps=>{
              rows.push({entry:e,source:label,snippet:ps.snippet,page:ps.page,fileName:ref.name,inPdf:true});
            });
          } else {
            rows.push({entry:e,source:label,snippet:hilite(txt,q),page:null,fileName:ref.name,inPdf:true});
          }
        });
    });
    return rows;
  };

  const rows=searching?buildRows():[];
  const shownEntries=searching?[...new Set(rows.map(r=>r.entry.id))].map(id=>allTypeEntries.find(e=>e.id===id)).filter(Boolean):typeEntries;

  async function bulkUpload(fileList){
    const pdfs = Array.from(fileList);
    if(!pdfs.length) return;

    setBulkUploading(true);
    setBulkStatus("Connecting to server...");

    setBulkStatus("Starting upload of "+pdfs.length+" file"+(pdfs.length!==1?"s":"")+"...");

    const results = [];
    const errors = [];

    for(let i=0; i<pdfs.length; i++){
      const file = pdfs[i];
      const step = "["+(i+1)+"/"+pdfs.length+"]";
      setBulkStatus(step+" Uploading: "+file.name.slice(0,45)+"...");

      try{
        // Upload file
        const fd = new FormData();
        fd.append("files", file);
        const uploadRes = await fetch(`${API}/upload`, {method:"POST", body:fd});
        
        if(!uploadRes.ok){
          const errText = await uploadRes.text();
          throw new Error("Server error "+uploadRes.status+": "+errText.slice(0,100));
        }
        
        const uploadJson = await uploadRes.json();
        if(!uploadJson.ok || !uploadJson.files || !uploadJson.files[0]){
          throw new Error("Bad server response: "+JSON.stringify(uploadJson).slice(0,100));
        }
        
        const saved = uploadJson.files[0];
        setBulkStatus(step+" Saved. Extracting text...");

        // Skip text extraction during bulk upload - files are on server, search works via file library
        let extractedText = "", pages = 0;

        // Save file metadata to library - truncate text to prevent storage overflow
        const MAX_TEXT = 10000000; // unlimited per file max
        const storedText = extractedText.length > MAX_TEXT ? extractedText.slice(0, MAX_TEXT) : extractedText;
        const meta = {
          id:genId(), name:saved.name, originalName:saved.original||file.name,
          fileType:file.type, size:saved.size, catId:cat.id,
          notes:"", pages, extractedText:storedText, createdAt:new Date().toISOString()
        };
        try {
          await fetch(`${API}/files-meta`,{
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify([meta])
          });
        } catch(e) { console.warn("File meta save skipped:", e.message); }

        // Build clean title from filename
        const cleanTitle = file.name
          .replace(/[.]pdf$/i, "")
          .replace(/[_ -]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const yearMatch = cleanTitle.match(/20[0-9][0-9]/);

        // Create entry - do NOT store extractedText in entry (too large for localStorage)
        // extractedText lives only in the file library meta
        const entry = {
          id:genId(), catId:cat.id, docTypeId:dt.id,
          title:cleanTitle, reference:"", articleNo:"", publicationRef:"", decisionNo:"",
          effectiveDate:"", issueDate:"", year:yearMatch?yearMatch[0]:"", month:"",
          status:"Active", summary:"", fullText:"", notes:"", flashcards:"", examNotes:"", tags:"",
          attachedFile:{name:saved.name, size:saved.size, pages},
          notesFile:null, flashFile:null, summaryFile:null, examFile:null,
          createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
        };

        // Save directly to server (unlimited storage on I: drive)
        try {
          const saveRes = await fetch(`${API}/entries/add`,{
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify([entry])
          });
          if(!saveRes.ok) throw new Error("Server save failed");
        } catch(storageErr) {
          throw new Error("Could not save entry: "+storageErr.message);
        }
        results.push(entry);
        setBulkStatus(step+" Done: "+cleanTitle.slice(0,40));

      }catch(err){
        console.error("Bulk upload error:", file.name, err);
        const errMsg = err.message||"unknown error";
        if(errMsg==="Failed to fetch"){
          setBulkStatus("Server not running — open terminal and run: npm run dev");
          setBulkUploading(false); return;
        }
        errors.push(file.name+": "+errMsg);
        setBulkStatus(step+" FAILED: "+errMsg.slice(0,60));
      }
    }

    // Refresh React state from server immediately
    if(results.length > 0){
      try{
        const er = await fetch(`${API}/entries`);
        if(er.ok) setEntries(await er.json());
        const fr = await fetch(`${API}/files-meta`);
        if(fr.ok) setFiles(await fr.json());
      }catch(e){ console.warn("State refresh failed:", e); }
    }

    if(errors.length > 0 && results.length === 0){
      setBulkStatus("All failed. Error: "+errors[0].slice(0,80));
      setBulkUploading(false);
      return;
    } else if(errors.length > 0){
      setBulkStatus(results.length+" uploaded. "+errors.length+" failed. Extracting PDF text in background...");
    } else {
      setBulkStatus("Entries saved! Extracting PDF text for search (background)...");
    }

    // Background text extraction — runs after entries appear, updates file-meta for search
    setBulkUploading(false);
    (async()=>{
      let extracted = 0;
      for(const entry of results){
        if(!entry.attachedFile?.name) continue;
        try{
          const b64Res = await Promise.race([
            fetch(`${API.replace('/api','')}/api/file/${encodeURIComponent(entry.attachedFile.name)}/base64`),
            new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),25000))
          ]);
          if(!b64Res.ok) continue;
          const b64Json = await b64Res.json();
          if(!b64Json.base64) continue;
          const extracted_result = await Promise.race([
            extractPdfTextFromBase64(b64Json.base64),
            new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),30000))
          ]);
          const text = extracted_result.text || "";
          const pages = extracted_result.pages || 0;
          if(!text) continue;
          // Cap at 100KB and save to server file-meta
          const storedText = text; // No limit
          await fetch(`${API}/files-meta`,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify([{
              id:entry.id+"_meta",
              name:entry.attachedFile.name,
              originalName:entry.attachedFile.name,
              catId:entry.catId,
              size:entry.attachedFile.size||0,
              pages, extractedText:storedText,
              createdAt:new Date().toISOString()
            }])
          });
          extracted++;
          setBulkStatus("Extracting text: "+extracted+"/"+results.length+" done — search will find these now");
        }catch(e){ console.warn("Text extract failed for",entry.attachedFile?.name,":",e.message); }
      }
      // Final state refresh with text included
      try{
        const fr2 = await fetch(`${API}/files-meta`);
        if(fr2.ok) setFiles(await fr2.json());
      }catch{}
      setBulkStatus("Done! "+results.length+" entr"+(results.length!==1?"ies":"y")+" added. Text extracted for "+extracted+" PDFs — search is ready.");
      setTimeout(()=>setBulkStatus(""), 10000);
    })();
  }


  return(
    <div>
      {showDropPicker&&<DropDestPicker cat={cat}
        onCancel={()=>setShowDropPicker(false)}
        onSave={async(droppedFiles,droppedUrl,destCatId,destDtId)=>{
          setShowDropPicker(false);
          if(droppedFiles&&droppedFiles.length>0){
            setBulkUploading(true);
            const arr=Array.from(droppedFiles);
            setBulkStatus("Uploading "+arr.length+" file(s)...");
            const results=[];
            for(let i=0;i<arr.length;i++){
              const file=arr[i];
              setBulkStatus("["+(i+1)+"/"+arr.length+"] "+file.name.slice(0,40));
              try{
                const fd=new FormData();fd.append("files",file);
                const r=await fetch(`${API}/upload`,{method:"POST",body:fd});
                if(!r.ok) continue;
                const j=await r.json();if(!j.ok||!j.files[0]) continue;
                const saved=j.files[0];
                const cleanTitle=file.name.replace(/[.]pdf$/i,"").replace(/[._-]+/g," ").trim();
                const entry={id:genId(),catId:destCatId,docTypeId:destDtId,title:cleanTitle,reference:"",year:"",month:"",status:"Active",attachedFile:{name:saved.name,size:saved.size,pages:0},notesFile:null,flashFile:null,summaryFile:null,examFile:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
                await fetch(`${API}/entries/add`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify([entry])});
                results.push(entry);
              }catch{}
            }
            if(onBulkSave&&results.length) onBulkSave(results);
            setBulkStatus("✓ "+results.length+" saved to "+TAX_CATS.find(c=>c.id===destCatId)?.label);
            setBulkUploading(false);setTimeout(()=>setBulkStatus(""),5000);
          } else if(droppedUrl){
            setBulkUploading(true);setBulkStatus("Downloading...");
            try{
              const res=await apiDownloadUrl(droppedUrl);
              if(res.ok&&res.files[0]){
                const saved=res.files[0];
                const cleanTitle=decodeURIComponent(saved.name).replace(/[._-]+/g," ").replace(/[ ]*pdf$/i,"").trim()||"Downloaded Document";
                const entry={id:genId(),catId:destCatId,docTypeId:destDtId,title:cleanTitle,reference:"",year:"",month:"",status:"Active",attachedFile:{name:saved.name,size:saved.size,pages:0},notesFile:null,flashFile:null,summaryFile:null,examFile:null,sourceUrl:droppedUrl,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
                await fetch(`${API}/entries/add`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify([entry])});
                if(onBulkSave) onBulkSave([entry]);
                setBulkStatus("✓ Saved to "+TAX_CATS.find(c=>c.id===destCatId)?.label+": "+cleanTitle);
              }else{setBulkStatus("Failed: "+(res.error||"error"));}
            }catch(e2){setBulkStatus("Error: "+e2.message);}
            setBulkUploading(false);setTimeout(()=>setBulkStatus(""),6000);
          }
        }}/>}
      {/* Banner */}
      <div style={{background:cat.color+"18",border:"1px solid "+cat.color+"30",borderRadius:"var(--radius)",padding:"1rem 1.25rem",marginBottom:16}}>
        <h1 style={{fontSize:24,fontWeight:800,color:cat.color,marginBottom:2}}>{cat.label}</h1>
        <p style={{fontSize:12,color:"var(--text2)"}}>{catEntries.length} total entries</p>
      </div>

      {/* Tab bar */}
      <div style={{background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",padding:"5px",display:"flex",gap:3,marginBottom:16,flexWrap:"wrap",boxShadow:"var(--shadow)"}}>
        {tabs.map(d=>(
          <button key={d.id} onClick={()=>{onChangeType(d.id);setQ("");}} style={{
            padding:"6px 12px",borderRadius:"var(--radius-sm)",fontSize:12,
            fontWeight:activeType===d.id?700:400,
            background:activeType===d.id?"var(--nav)":"transparent",
            color:activeType===d.id?"#fff":"var(--text2)",
            border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:4,whiteSpace:"nowrap"
          }}>
            {d.icon} {d.label}
            {counts[d.id]>0&&<span style={{fontSize:10,background:activeType===d.id?"rgba(255,255,255,0.2)":"var(--surface2)",color:activeType===d.id?"#fff":"var(--text2)",padding:"1px 6px",borderRadius:20,fontWeight:600}}>{counts[d.id]}</span>}
          </button>
        ))}
      </div>

      {/* Search + Add */}
      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:200,position:"relative"}}>
          <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"var(--text3)",pointerEvents:"none"}}>⌕</span>
          <input value={q} onChange={e=>setQ(e.target.value)}
            placeholder={"Search in "+dt.label+" — name, notes, inside PDFs..."}
            style={{...IS,paddingLeft:36,width:"100%"}}/>
          {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"var(--border)",border:"none",borderRadius:"50%",width:18,height:18,fontSize:12,cursor:"pointer",color:"var(--text2)",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>}
        </div>
        {searching&&onSearchAll&&(
          <button onClick={()=>onSearchAll(q)} style={{padding:"8px 14px",background:"var(--surface2)",border:"1.5px solid var(--border2)",borderRadius:"var(--radius-sm)",fontSize:12,color:"var(--text2)",cursor:"pointer",whiteSpace:"nowrap",fontWeight:500}}>
            🌐 Search whole app
          </button>
        )}
        <Btn onClick={onAdd} variant="primary" style={{whiteSpace:"nowrap"}}>+ Add {dt.label}</Btn>
        <button onClick={()=>!bulkUploading&&bulkRef.current?.click()}
          disabled={bulkUploading}
          style={{padding:"8px 14px",background:"#FFFBEB",border:"1.5px solid #FCD34D",borderRadius:"var(--radius-sm)",fontSize:12,color:"#854F0B",cursor:"pointer",whiteSpace:"nowrap",fontWeight:600,flexShrink:0}}>
          {bulkUploading?"⏳ Uploading...":"📤 Bulk Upload PDFs"}
        </button>
        <button onClick={()=>setShowDropPicker(true)}
          style={{padding:"8px 14px",background:"#EFF6FF",border:"1.5px solid #BFDBFE",borderRadius:"var(--radius-sm)",fontSize:12,color:"#1D4ED8",cursor:"pointer",whiteSpace:"nowrap",fontWeight:600,flexShrink:0}}>
          🔗 Add from Link / Drop
        </button>
        <input ref={bulkRef} type="file" multiple accept=".pdf,application/pdf" style={{display:"none"}}
          onChange={e=>{bulkUpload(e.target.files);e.target.value="";}} />
        <button onClick={async()=>{
          // Force re-extract ALL files to pick up full text with new unlimited limit
          const noText=typeEntries.filter(e=>e.attachedFile?.name);
          if(!noText.length){setBulkStatus("No PDFs attached to entries in this section.");setTimeout(()=>setBulkStatus(""),3000);return;}
          setBulkStatus("Re-extracting text for "+noText.length+" PDFs...");
          let done=0;
          for(const entry of noText){
            try{
              const b64Res=await Promise.race([
                fetch(`${API.replace('/api','')}/api/file/${encodeURIComponent(entry.attachedFile.name)}/base64`),
                new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),20000))
              ]);
              if(!b64Res.ok) continue;
              const b64Json=await b64Res.json();
              if(!b64Json.base64) continue;
              const r=await Promise.race([
                extractPdfTextFromBase64(b64Json.base64),
                new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),30000))
              ]);
              const text=r.text||"";
              if(!text) continue;
              const stored=text; // No limit — full document stored
              await fetch(`${API}/files-meta`,{method:"POST",headers:{"Content-Type":"application/json"},
                body:JSON.stringify([{id:entry.id+"_meta",name:entry.attachedFile.name,originalName:entry.attachedFile.name,
                  catId:entry.catId,size:entry.attachedFile.size||0,pages:r.pages||0,extractedText:stored,createdAt:new Date().toISOString()}])});
              done++;
              setBulkStatus("Extracted "+done+"/"+noText.length+" — "+entry.attachedFile.name.slice(0,30));
            }catch(e){console.warn("Extract failed:",e.message);}
          }
          const fr=await fetch(`${API}/files-meta`);
          if(fr.ok) setFiles(await fr.json());
          setBulkStatus("Done! Text extracted for "+done+" PDFs. Search inside PDFs is now active.");
          setTimeout(()=>setBulkStatus(""),8000);
        }}
          style={{padding:"8px 12px",background:"#EFF6FF",border:"1.5px solid #BFDBFE",borderRadius:"var(--radius-sm)",fontSize:11,color:"#1D4ED8",cursor:"pointer",whiteSpace:"nowrap",fontWeight:600,flexShrink:0}}>
          🔍 Extract PDF Text {typeEntries.filter(e=>e.attachedFile&&!pdfText(e.attachedFile)).length>0&&"("+typeEntries.filter(e=>e.attachedFile&&!pdfText(e.attachedFile)).length+" pending)"}
        </button>
      </div>
      {bulkStatus&&<p style={{fontSize:12,color:bulkStatus.startsWith("✓")?"#059669":"#854F0B",marginBottom:8,fontWeight:600,padding:"6px 12px",background:bulkStatus.startsWith("✓")?"#F0FDF4":"#FFFBEB",borderRadius:"var(--radius-sm)",border:"1px solid "+(bulkStatus.startsWith("✓")?"#6EE7B7":"#FCD34D")}}>{bulkStatus}</p>}

      {/* Sort & Filter Bar */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",padding:"8px 12px",background:"#F8FAFF",borderRadius:"var(--radius-sm)",border:"1px solid var(--border)",marginBottom:12}}>
        <span style={{fontSize:11,fontWeight:700,color:"var(--text2)",flexShrink:0}}>Sort & Filter:</span>
        <select value={sortBy} onChange={e=>setSortBy(e.target.value)}
          style={{padding:"4px 8px",border:"1px solid var(--border2)",borderRadius:5,fontSize:11,color:"var(--text)",background:"#fff",cursor:"pointer"}}>
          <option value="year-desc">Date: Newest First (Dec 2025 → Jan 2020)</option>
          <option value="year-asc">Date: Oldest First (Jan 2020 → Dec 2025)</option>
          <option value="title-asc">Name: A → Z</option>
          <option value="title-desc">Name: Z → A</option>
          <option value="ref-asc">Reference</option>
          <option value="newest">Recently Added</option>
        </select>
        <select value={filterYear} onChange={e=>setFilterYear(e.target.value)}
          style={{padding:"4px 8px",border:"1px solid var(--border2)",borderRadius:5,fontSize:11,color:"var(--text)",background:"#fff",cursor:"pointer"}}>
          <option value="all">All Years</option>
          {availYears.map(y=><option key={y} value={y}>{y}</option>)}
        </select>
        <select value={filterMonth} onChange={e=>setFilterMonth(e.target.value)}
          style={{padding:"4px 8px",border:"1px solid var(--border2)",borderRadius:5,fontSize:11,color:"var(--text)",background:"#fff",cursor:"pointer"}}>
          <option value="all">All Months</option>
          {availMonths.map(m=><option key={m} value={m}>{m}</option>)}
        </select>
        <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}
          style={{padding:"4px 8px",border:"1px solid var(--border2)",borderRadius:5,fontSize:11,color:"var(--text)",background:"#fff",cursor:"pointer"}}>
          <option value="all">All Status</option>
          <option value="Active">Active</option>
          <option value="Superseded">Superseded</option>
          <option value="Draft">Draft</option>
          <option value="Repealed">Repealed</option>
        </select>
        {(filterYear!=="all"||filterMonth!=="all"||filterStatus!=="all")&&(
          <button onClick={()=>{setFilterYear("all");setFilterMonth("all");setFilterStatus("all");}}
            style={{padding:"4px 10px",background:"#FEE2E2",color:"#DC2626",border:"1px solid #FECACA",borderRadius:5,fontSize:11,fontWeight:600,cursor:"pointer"}}>
            ✕ Clear filters
          </button>
        )}
        <span style={{marginLeft:"auto",fontSize:11,color:"var(--text2)",fontWeight:600}}>
          {typeEntries.length}{allTypeEntries.length!==typeEntries.length?" of "+allTypeEntries.length:""} {dt.label}
        </span>
      </div>

      {/* Move Document Modal */}
      {moveModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setMoveModal(null)}>
          <div style={{background:"#fff",borderRadius:12,padding:"24px",maxWidth:440,width:"90%",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}} onClick={e=>e.stopPropagation()}>
            <h3 style={{fontSize:16,fontWeight:800,color:"#1E3A5F",marginBottom:4}}>Move Document</h3>
            <p style={{fontSize:12,color:"var(--text2)",marginBottom:16}}>"{moveModal.title}"</p>
            <p style={{fontSize:12,fontWeight:600,color:"var(--text)",marginBottom:8}}>Select destination:</p>
            <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:320,overflowY:"auto"}}>
              {TAX_CATS.map(c=>
                DOC_TYPES.filter(d=>c.id==="ct"||c.id==="vat"?true:!["cabinet","ministerial","fta"].includes(d.id)).map(d=>{
                  const isCurrent = c.id===moveModal.catId && d.id===moveModal.docTypeId;
                  return(
                    <button key={c.id+"-"+d.id} disabled={isCurrent}
                      onClick={()=>{
                        if(onItem) onItem({...moveModal,_moveAction:{catId:c.id,docTypeId:d.id}});
                        setMoveModal(null);
                      }}
                      style={{padding:"8px 12px",textAlign:"left",border:"1px solid var(--border)",borderRadius:6,background:isCurrent?"#F0F9FF":"#fff",cursor:isCurrent?"default":"pointer",fontSize:12,color:isCurrent?"#0369A1":"var(--text)",fontWeight:isCurrent?700:400}}>
                      {c.label} → {d.label} {isCurrent?"(current)":""}
                    </button>
                  );
                })
              )}
            </div>
            <button onClick={()=>setMoveModal(null)} style={{marginTop:16,padding:"8px 20px",background:"var(--surface2)",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>Cancel</button>
          </div>
        </div>
      )}

      {searching&&<p style={{fontSize:12,color:"var(--text2)",marginBottom:12}}>
        <strong>{rows.length}</strong> passage{rows.length!==1?"s":""} across <strong>{shownEntries.length}</strong> entr{shownEntries.length!==1?"ies":"y"} for "<strong>{q}</strong>"
        {rows.length===0&&onSearchAll&&<> · <button onClick={()=>onSearchAll(q)} style={{background:"none",border:"none",color:"#854F0B",cursor:"pointer",fontSize:12,textDecoration:"underline"}}>try whole app</button></>}
      </p>}

      {/* Empty state */}
      {searching&&rows.length===0&&(
        <div style={{textAlign:"center",padding:"3rem",background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",color:"var(--text2)"}}>
          <p style={{fontSize:22,marginBottom:8}}>🔍</p>
          <p style={{fontWeight:600}}>No results for "{q}" in {dt.label}</p>
          <p style={{fontSize:12,color:"var(--text3)",marginTop:6}}>Try different keywords or search the whole app</p>
        </div>
      )}
      {!searching&&shownEntries.length===0&&(
        <div style={{textAlign:"center",padding:"3rem",background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",color:"var(--text2)"}}>
          <p style={{fontSize:32,marginBottom:12}}>{dt.icon}</p>
          <p style={{fontWeight:600,marginBottom:6}}>No {dt.label} yet</p>
          <p style={{fontSize:12,color:"var(--text3)"}}>Click "+ Add {dt.label}" to add the first one</p>
        </div>
      )}

      {/* SEARCH RESULTS — flat row table */}
      {searching&&rows.length>0&&(
        <div style={{background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",overflow:"auto",boxShadow:"var(--shadow)"}}>
          <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed"}}>
            <colgroup>
              <col style={{width:"22%"}}/>
              <col style={{width:"12%"}}/>
              <col style={{width:"54%"}}/>
              <col style={{width:"12%"}}/>
            </colgroup>
            <thead>
              <tr style={{background:"var(--surface2)",borderBottom:"2px solid var(--border)"}}>
                {["Name","Source","Context (3 lines)","Page"].map(h=>(
                  <th key={h} style={{padding:"10px 12px",textAlign:h==="Page"?"center":"left",fontSize:11,fontWeight:700,color:"var(--text2)",letterSpacing:"0.05em",textTransform:"uppercase"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row,ri)=>{
                const isNewEntry=ri===0||rows[ri-1].entry.id!==row.entry.id;
                return(
                  <tr key={ri}
                    onClick={()=>onItem(row.entry)}
                    onMouseEnter={e=>e.currentTarget.style.background="#F8FAFF"}
                    onMouseLeave={e=>e.currentTarget.style.background=isNewEntry?"#FAFBFF":"#fff"}
                    style={{borderBottom:"1px solid var(--border)",cursor:"pointer",background:isNewEntry?"#FAFBFF":"#fff",transition:"background 0.1s"}}>
                    {/* Name */}
                    <td style={{padding:"10px 12px",verticalAlign:"top"}}>
                      {isNewEntry&&(
                        <div>
                          <p style={{fontWeight:700,fontSize:12,color:"var(--text)",lineHeight:1.4}}><HL text={row.entry.title} q={q}/></p>
                          {(row.entry.reference||row.entry.decisionNo)&&<p style={{fontSize:10,color:"var(--text3)",marginTop:3}}>{row.entry.reference||row.entry.decisionNo}</p>}
                          {row.entry.year&&<p style={{fontSize:10,color:"var(--text3)"}}>{row.entry.year}{row.entry.month?" · "+row.entry.month:""}</p>}
                        </div>
                      )}
                    </td>
                    {/* Source */}
                    <td style={{padding:"10px 12px",verticalAlign:"top"}}>
                      <span style={{fontSize:10,fontWeight:700,color:"#fff",background:row.inPdf?"#059669":"var(--nav)",padding:"2px 8px",borderRadius:20,whiteSpace:"nowrap"}}>
                        {row.inPdf?"📄 ":""}{row.source}
                      </span>
                    </td>
                    {/* Context snippet */}
                    <td style={{padding:"10px 12px",verticalAlign:"top"}}>
                      <p style={{fontSize:12,color:"var(--text2)",lineHeight:1.8,display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical",overflow:"hidden"}}>
                        <HL text={row.snippet} q={q}/>
                      </p>
                    </td>
                    {/* Page */}
                    <td style={{padding:"10px 12px",verticalAlign:"top",textAlign:"center"}}>
                      {row.inPdf&&row.page?(
                        <a href={fileViewUrl(row.fileName)+"#page="+row.page} target="_blank" rel="noreferrer"
                          onClick={e=>e.stopPropagation()}
                          style={{display:"inline-block",background:"#15803D",color:"#fff",fontSize:11,fontWeight:700,padding:"4px 10px",borderRadius:20,textDecoration:"none",whiteSpace:"nowrap"}}>
                          p.{row.page} →
                        </a>
                      ):row.page?(
                        <span style={{fontSize:11,color:"var(--text3)"}}>p.{row.page}</span>
                      ):(
                        <span style={{fontSize:11,color:"var(--text3)"}}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{padding:"8px 12px",borderTop:"1px solid var(--border)",fontSize:12,color:"var(--text3)"}}>{rows.length} passage{rows.length!==1?"s":""} found</div>
        </div>
      )}

      {/* NORMAL TABLE VIEW */}
      {!searching&&shownEntries.length>0&&(
        <div style={{background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",overflow:"auto",boxShadow:"var(--shadow)"}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:900}}>
            <thead>
              <tr style={{background:"var(--surface2)",borderBottom:"2px solid var(--border)"}}>
                {["Year","Month","Reference","Name","Notes PDF","Flashcards PDF","Summary PDF","Exam Material PDF"].map(h=>(
                  <th key={h} style={{padding:"10px 12px",textAlign:["Notes PDF","Flashcards PDF","Summary PDF","Exam Material PDF"].includes(h)?"center":"left",fontSize:11,fontWeight:700,color:"var(--text2)",whiteSpace:"nowrap",letterSpacing:"0.04em",textTransform:"uppercase"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>{shownEntries.map(it=><TableRow key={it.id} item={it} onClick={()=>onItem(it)} onMove={setMoveModal}/>)}</tbody>
          </table>
          <div style={{padding:"8px 12px",borderTop:"1px solid var(--border)",fontSize:12,color:"var(--text3)"}}>{shownEntries.length} {dt.label.toLowerCase()}</div>
        </div>
      )}
    </div>
  );
}
/* ─── AI Panel ───────────────────────────────────────────────────────────── */
function AIPanel({item,file,onClose}){
  const [mode,setMode]=useState(null);
  const [result,setResult]=useState("");
  const [loading,setLoading]=useState(false);
  const [quiz,setQuiz]=useState(null);
  const [sel,setSel]=useState(null);
  const [fb,setFb]=useState(null);
  const cat=item?TAX_CATS.find(c=>c.id===item.catId):null;
  const dt=item?DOC_TYPES.find(d=>d.id===item.docTypeId):null;
  const ctx=file
    ?`File: ${file.name}\nExtracted text:\n${(file.extractedText||"").slice(0,6000)}`
    :`Category: ${cat?.label}\nType: ${dt?.label}\nTitle: ${item?.title}\nRef: ${item?.reference||""} ${item?.decisionNo||""}\nSummary: ${item?.summary||""}\nFull Text: ${item?.fullText||""}\nNotes: ${item?.notes||""}`;

  async function run(action){
    setMode(action);setResult("");setLoading(true);setQuiz(null);setSel(null);setFb(null);
    try{
      let msgs;
      if(file){
        // Try to get file from server as base64
        try{
          const b64=await apiBase64(file.name);
          if(b64&&(file.name.endsWith(".pdf")||file.fileType==="application/pdf")){
            msgs=[{role:"user",content:[
              {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
              {type:"text",text:action==="summarize"?"Summarize this UAE tax document. Key provisions, thresholds, practical implications.":action==="quiz"?`Generate 5 advanced MCQ questions. JSON only: [{"q":"...","opts":{"A":"...","B":"...","C":"...","D":"..."},"ans":"A","exp":"..."}]`:action==="keypoints"?"Extract 7 most important key points as bullet list.":"Explain simply for UAE tax exam preparation."}
            ]}];
          } else {
            // Use extracted text
            msgs=[{role:"user",content:`${action==="quiz"?`Generate 5 MCQ questions JSON only: [{"q":"...","opts":{"A":"...","B":"...","C":"...","D":"..."},"ans":"A","exp":"..."}]`:action==="summarize"?"Summarize:":action==="keypoints"?"Key points:":"Explain:"}\n\n${ctx}`}];
          }
        }catch{
          msgs=[{role:"user",content:`${action==="quiz"?`Generate 5 MCQ JSON: [{"q":"...","opts":{"A":"...","B":"...","C":"...","D":"..."},"ans":"A","exp":"..."}]`:action==="summarize"?"Summarize:":action==="keypoints"?"Key points:":"Explain:"}\n\n${ctx}`}];
        }
      } else {
        const p=action==="summarize"?`Summarize for exam prep:\n${ctx}`:action==="quiz"?`Generate 5 advanced MCQ. JSON only (no markdown): [{"q":"...","opts":{"A":"...","B":"...","C":"...","D":"..."},"ans":"A","exp":"..."}]\n${ctx}`:action==="keypoints"?`Extract 7 key points:\n${ctx}`:`Explain simply with examples:\n${ctx}`;
        msgs=[{role:"user",content:p}];
      }
      const raw=await callClaude(msgs,"You are a UAE tax expert. Be precise, cite article numbers, exam-level depth.");
      if(action==="quiz"){try{setQuiz({questions:JSON.parse(raw.replace(/```json|```/g,"").trim()),idx:0,score:{c:0,t:0},done:false});}catch{setResult(raw);}}
      else setResult(raw);
    }catch(e){setResult("Error: "+e.message);}
    setLoading(false);
  }
  const q=quiz?.questions?.[quiz.idx];
  const ansQ=opt=>{if(sel)return;setSel(opt);const ok=opt===q.ans;setFb(ok);setQuiz(s=>({...s,score:{c:s.score.c+(ok?1:0),t:s.score.t+1}}));};
  const nextQ=()=>{const nx=quiz.idx+1;if(nx>=quiz.questions.length){setQuiz(s=>({...s,done:true}));return;}setQuiz(s=>({...s,idx:nx}));setSel(null);setFb(null);};
  const ACTS=[{id:"summarize",label:"Summarize",icon:"≡"},{id:"quiz",label:"Generate Quiz",icon:"?"},{id:"keypoints",label:"Key Points",icon:"★"},{id:"explain",label:"Explain Simply",icon:"◎"}];

  return(<Modal title={`AI — ${file?.name||item?.title}`} onClose={onClose} wide>
    <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
      {ACTS.map(a=><button key={a.id} onClick={()=>run(a.id)} style={{padding:"8px 16px",fontSize:13,background:mode===a.id?"var(--nav)":"#fff",color:mode===a.id?"#fff":"var(--text)",border:"1.5px solid",borderColor:mode===a.id?"var(--nav)":"var(--border2)",borderRadius:20,fontWeight:mode===a.id?600:400,cursor:"pointer"}}>{a.icon} {a.label}</button>)}
    </div>
    {!mode&&<div style={{padding:"3rem",textAlign:"center",color:"var(--text2)",background:"var(--surface2)",borderRadius:"var(--radius)"}}>Choose an AI action above</div>}
    {loading&&<div style={{display:"flex",alignItems:"center",gap:12,padding:"1.5rem",background:"var(--surface2)",borderRadius:"var(--radius)"}}><Spinner/><span style={{color:"var(--text2)"}}>Thinking...</span></div>}
    {!loading&&result&&<div style={{background:"var(--surface2)",borderRadius:"var(--radius)",padding:"1.25rem",fontSize:13,lineHeight:1.8,color:"var(--text)",whiteSpace:"pre-wrap",border:"1.5px solid var(--border)"}}>{result}</div>}
    {!loading&&quiz&&!quiz.done&&q&&(<div>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}><span style={{fontSize:12,color:"var(--text2)",fontWeight:600}}>Q{quiz.idx+1}/{quiz.questions.length}</span><span style={{fontSize:12,color:"var(--text2)"}}>{quiz.score.c}/{quiz.score.t}</span></div>
      <p style={{fontWeight:600,fontSize:15,lineHeight:1.6,marginBottom:14}}>{q.q}</p>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
        {Object.entries(q.opts).map(([o,t])=>{
          const col=!sel?{bg:"#fff",bd:"var(--border2)",c:"var(--text)"}:o===q.ans?{bg:"#D1FAE5",bd:"#6EE7B7",c:"#064E3B"}:o===sel?{bg:"#FEE2E2",bd:"#FCA5A5",c:"#7F1D1D"}:{bg:"var(--surface2)",bd:"var(--border)",c:"var(--text2)"};
          return<button key={o} onClick={()=>ansQ(o)} style={{background:col.bg,border:`1.5px solid ${col.bd}`,color:col.c,borderRadius:"var(--radius-sm)",padding:"10px 14px",textAlign:"left",cursor:sel?"default":"pointer",fontSize:13}}><strong style={{marginRight:8}}>{o}.</strong>{t}</button>;
        })}
      </div>
      {sel&&<div style={{background:fb?"#D1FAE5":"#FEE2E2",border:`1.5px solid ${fb?"#6EE7B7":"#FCA5A5"}`,borderRadius:"var(--radius-sm)",padding:"12px 14px",marginBottom:12}}>
        <p style={{fontWeight:700,fontSize:13,color:fb?"#064E3B":"#7F1D1D",marginBottom:4}}>{fb?"✓ Correct":"✗ Incorrect — "+q.ans}</p>
        <p style={{fontSize:12,lineHeight:1.6,color:fb?"#065F46":"#991B1B"}}>{q.exp}</p>
      </div>}
      {sel&&<Btn onClick={nextQ} variant="primary">Next →</Btn>}
    </div>)}
    {!loading&&quiz?.done&&<div style={{textAlign:"center",padding:"2.5rem",background:"var(--surface2)",borderRadius:"var(--radius)"}}>
      <p style={{fontSize:42,fontWeight:700,marginBottom:8}}>{quiz.score.c}/{quiz.questions.length}</p>
      <p style={{fontSize:14,color:"var(--text2)",marginBottom:20}}>{quiz.score.c===quiz.questions.length?"Perfect!":"Keep going!"}</p>
      <Btn onClick={()=>run("quiz")} variant="primary">Retry</Btn>
    </div>}
  </Modal>);
}

/* ─── AI Chat ────────────────────────────────────────────────────────────── */
function parseRefs(text){
  const refs=[];
  const cleaned=text.replace(/^\[REF\]\s*(.+)$/gm,(_,ref)=>{refs.push(ref.trim());return '';});
  return {cleaned:cleaned.replace(/\n{3,}/g,'\n\n').trim(),refs};
}

function findArticlePage(extractedText,articleNum){
  if(!extractedText||!articleNum) return null;
  const lines=extractedText.split('\n');
  let page=1;
  for(let i=0;i<lines.length;i++){
    const pm=lines[i].match(/\[Page (\d+)\]/i);
    if(pm) page=parseInt(pm[1]);
    if(new RegExp('Article\\s+'+articleNum+'[^0-9]','i').test(lines[i])) return page;
    if(new RegExp('Art\\.?\\s*'+articleNum+'[^0-9]','i').test(lines[i])) return page;
  }
  return null;
}

function InlineCite({cite,entries,files,onNavigate}){
  const c=cite.toLowerCase();
  const yearM=cite.match(/(20\d{2})/);
  const year=yearM?yearM[1]:'';
  const artM=cite.match(/Art(?:icle)?[.\s]+([0-9]+)/i);
  const artNum=artM?artM[1]:null;
  const match=entries.find(e=>{
    const t=(e.title||'').toLowerCase(),ey=e.year||'';
    const ok=(c.includes('decree-law')&&(t.includes('decree-law')||t.includes('federal law')))||
              (c.includes('cabinet')&&t.includes('cabinet'))||
              (c.includes('ministerial')&&t.includes('ministerial'))||
              (c.includes('fta')&&(t.includes('fta')||t.includes('guide')));
    return ok&&(!year||ey===year||t.includes(year));
  });
  const entryFile=match&&match.attachedFile?files.find(f=>f.name===match.attachedFile.name):null;
  const matchFile=!match&&files.find(f=>{
    const fn=(f.originalName||f.name||'').toLowerCase().replace(/[_.\-]+/g,' ');
    const ok=(c.includes('decree-law')&&fn.includes('decree'))||(c.includes('cabinet')&&fn.includes('cabinet'))||(c.includes('ministerial')&&fn.includes('ministerial'));
    return ok&&(!year||fn.includes(year));
  });
  const pdfFile=entryFile||matchFile;
  const page=artNum&&pdfFile?.extractedText?findArticlePage(pdfFile.extractedText,artNum):null;
  const hasLink=match||matchFile;
  const handleClick=()=>{
    if(pdfFile){
      const url=BASE_URL+'/api/file/'+encodeURIComponent(pdfFile.name)+(page?'#page='+page:'');
      window.open(url,'_blank');
    } else if(match&&onNavigate) onNavigate(match);
  };
  if(hasLink){
    return(
      <button onClick={handleClick} title={(page?'Jump to Article '+artNum+' p.'+page+' — ':'')+((match?match.title:pdfFile?.name)||'')}
        style={{display:'inline',background:'none',border:'none',padding:0,cursor:'pointer',verticalAlign:'middle'}}>
        <span style={{background:'#EFF6FF',color:'#1D4ED8',border:'1px solid #BFDBFE',borderRadius:4,padding:'1px 7px',fontSize:11.5,fontWeight:600,whiteSpace:'nowrap'}}>
          {cite}{page?' p.'+page:''} ↗
        </span>
      </button>
    );
  }
  return <span style={{background:'#FEF9EC',color:'#92400E',border:'1px solid #FCD34D',borderRadius:4,padding:'1px 6px',fontSize:11.5,fontWeight:600}}>{cite}</span>;
}

function inlineBold(text,entries,files,onNavigate){
  if(!text) return null;
  try{
    const parts=text.split(/(\*\*[^*]+\*\*|\[[^\]]{10,120}\])/g);
    return parts.map((part,i)=>{
      if(part.startsWith('**')&&part.endsWith('**')&&part.length>4)
        return <strong key={i} style={{color:'#1E3A5F'}}>{part.slice(2,-2)}</strong>;
      if(part.startsWith('[')&&part.endsWith(']')){
        const inner=part.slice(1,-1);
        if(/Art|Section|Decree|Cabinet|Ministerial|FTA/i.test(inner))
          return <InlineCite key={i} cite={inner} entries={entries||[]} files={files||[]} onNavigate={onNavigate}/>;
      }
      return <span key={i}>{part}</span>;
    });
  }catch(e){return <span>{text}</span>;}
}

function RefBadge({refText,entries,files,onNavigate}){
  const parts=refText.split('|').map(s=>s.trim());
  const docName=parts[0]||refText;
  const article=parts[1]||'';
  const topic=parts[2]||'';
  const match=entries.find(e=>{
    const t=(e.title||'').toLowerCase(),d=docName.toLowerCase();
    return t.includes(d.slice(0,20))||d.includes(t.slice(0,20));
  });
  const matchFile=!match&&files.find(f=>{
    const fn=(f.originalName||f.name||'').toLowerCase(),d=docName.toLowerCase();
    return fn.includes(d.slice(0,15))||d.includes(fn.slice(0,15));
  });
  const hasLink=match||matchFile;
  return(
    <div style={{display:'flex',alignItems:'flex-start',gap:8,padding:'8px 12px',background:hasLink?'#F0F9FF':'#F8FAFC',border:'1px solid '+(hasLink?'#BAE6FD':'#E2E8F0'),borderRadius:7,marginBottom:5}}>
      <span style={{fontSize:9,fontWeight:800,color:'#fff',background:hasLink?'#0369A1':'#94A3B8',padding:'2px 7px',borderRadius:3,flexShrink:0,marginTop:2,textTransform:'uppercase'}}>
        {hasLink?'Linked':'Ref'}
      </span>
      <div style={{flex:1}}>
        <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:5,marginBottom:2}}>
          <span style={{fontSize:12,fontWeight:700,color:'#1E3A5F'}}>{docName}</span>
          {article&&<span style={{fontSize:10,color:'#64748B',background:'#E8F0FE',padding:'2px 7px',borderRadius:3,fontWeight:600}}>{article}</span>}
        </div>
        {topic&&<p style={{fontSize:11,color:'#64748B',margin:'0 0 4px',lineHeight:1.4}}>{topic}</p>}
        {hasLink&&(
          <button onClick={()=>{if(match&&onNavigate)onNavigate(match);else if(matchFile)window.open(BASE_URL+'/api/file/'+encodeURIComponent(matchFile.name),'_blank');}}
            style={{padding:'3px 12px',background:'#0369A1',color:'#fff',border:'none',borderRadius:4,fontSize:10,fontWeight:700,cursor:'pointer'}}>
            {match?'→ Open in Knowledge Base':'→ View PDF'}
          </button>
        )}
        {!hasLink&&<p style={{fontSize:10,color:'#94A3B8',fontStyle:'italic',margin:0}}>Not yet in knowledge base</p>}
      </div>
    </div>
  );
}

function RenderResponse({text,onDownload,entries,files,onNavigate}){
  if(!text) return null;
  const {cleaned,refs}=parseRefs(text);
  return(
    <div>
      <div style={{display:'flex',justifyContent:'flex-end',marginBottom:10}}>
        <button onClick={onDownload} style={{padding:'5px 14px',background:'#1E3A5F',color:'#fff',border:'none',borderRadius:6,fontSize:11,fontWeight:600,cursor:'pointer'}}>
          ⬇ Download PDF
        </button>
      </div>
      {cleaned.split('\n').map((line,i)=>{
        if(line.startsWith('#### ')) return <p key={i} style={{fontSize:11,fontWeight:700,color:'#2D4A6E',margin:'10px 0 3px',textTransform:'uppercase',letterSpacing:'0.05em'}}>{line.slice(5)}</p>;
        if(line.startsWith('### ')) return <h3 key={i} style={{fontSize:13,fontWeight:700,color:'#2D4A6E',margin:'12px 0 4px'}}>{line.slice(4)}</h3>;
        if(line.startsWith('## ')) return <h2 key={i} style={{fontSize:15,fontWeight:800,color:'#1E3A5F',margin:'16px 0 5px',paddingBottom:4,borderBottom:'2px solid #E2E8F0'}}>{line.slice(3)}</h2>;
        if(line.startsWith('# ')) return <h1 key={i} style={{fontSize:17,fontWeight:800,color:'#1E3A5F',margin:'18px 0 6px',paddingBottom:5,borderBottom:'3px solid #1E3A5F'}}>{line.slice(2)}</h1>;
        if(/^\*\*[^*]+\*\*$/.test(line.trim())) return <p key={i} style={{fontWeight:700,color:'#1E3A5F',margin:'8px 0 2px',fontSize:13}}>{line.trim().slice(2,-2)}</p>;
        if(line.startsWith('- ')||line.startsWith('* ')){
          return(
            <div key={i} style={{display:'flex',gap:8,margin:'3px 0 3px 8px'}}>
              <span style={{color:'#C4973B',fontWeight:700,flexShrink:0,lineHeight:1.7}}>›</span>
              <span style={{fontSize:12.5,color:'#374151',lineHeight:1.7,flex:1}}>{inlineBold(line.slice(2),entries,files,onNavigate)}</span>
            </div>
          );
        }
        if(/^[0-9]+[.] /.test(line)){
          const m=line.match(/^([0-9]+)[.] (.*)/);
          return m?<div key={i} style={{display:'flex',gap:8,margin:'3px 0 3px 8px'}}><span style={{color:'#C4973B',fontWeight:700,flexShrink:0,lineHeight:1.7}}>{m[1]}.</span><span style={{fontSize:12.5,color:'#374151',lineHeight:1.7,flex:1}}>{inlineBold(m[2],entries,files,onNavigate)}</span></div>:null;
        }
        if(line.startsWith('---')) return <hr key={i} style={{border:'none',borderTop:'1px solid #E2E8F0',margin:'10px 0'}}/>;
        if(line.trim()==='') return <div key={i} style={{height:5}}/>;
        return <p key={i} style={{fontSize:12.5,color:'#374151',lineHeight:1.7,margin:'2px 0'}}>{inlineBold(line,entries,files,onNavigate)}</p>;
      })}
      {refs.length>0&&(
        <div style={{marginTop:18,padding:'14px 16px',background:'#F8FAFF',border:'2px solid #DBEAFE',borderRadius:10}}>
          <p style={{fontSize:10,fontWeight:800,color:'#1E3A5F',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:10}}>
            📚 References — Click to verify
          </p>
          {refs.map((ref,i)=><RefBadge key={i} refText={ref} entries={entries} files={files} onNavigate={onNavigate}/>)}
        </div>
      )}
    </div>
  );
}

function downloadResponsePDF(question,responseText,mode){
  const now=new Date();
  const dateStr=now.toLocaleDateString('en-AE',{day:'2-digit',month:'long',year:'numeric'});
  const htmlBody=responseText.split('\n').map(line=>{
    if(line.startsWith('## ')) return '<h2>'+line.slice(3)+'</h2>';
    if(line.startsWith('### ')) return '<h3>'+line.slice(4)+'</h3>';
    if(line.startsWith('- ')||line.startsWith('* ')) return '<li>'+line.slice(2)+'</li>';
    if(line.startsWith('---')) return '<hr/>';
    if(line.trim()==='') return '<br/>';
    return '<p>'+line+'</p>';
  }).join('\n');
  const html='<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Hassan Tax World</title>'
    +'<style>body{font-family:Arial,sans-serif;color:#1F2937;padding:40px 60px;max-width:800px;margin:0 auto}'
    +'.hdr{background:linear-gradient(135deg,#1E3A5F,#2D5A8E);color:#fff;padding:20px 32px;margin:-40px -60px 28px}'
    +'h2{font-size:14px;font-weight:800;color:#1E3A5F;margin:16px 0 4px;border-bottom:2px solid #E2E8F0;padding-bottom:3px}'
    +'p,li{font-size:12px;color:#374151;line-height:1.8;margin:3px 0}</style></head><body>'
    +'<div class="hdr"><h1 style="margin:0;font-size:18px">Hassan Tax World</h1><p style="margin:4px 0 0;opacity:0.7;font-size:11px">UAE Tax Knowledge Base · '+dateStr+'</p></div>'
    +'<div style="background:#F8FAFF;border:1px solid #DBEAFE;border-radius:8px;padding:12px 16px;margin-bottom:20px"><p style="font-size:10px;font-weight:700;color:#6B7280;margin-bottom:4px">QUESTION</p>'
    +'<p style="font-size:13px;font-weight:700;color:#1E3A5F;margin:0">'+question.replace(/</g,'&lt;')+'</p></div>'
    +htmlBody+'<script>window.onload=function(){window.print();}<\/script></body></html>';
  const blob=new Blob([html],{type:'text/html'});
  const url=URL.createObjectURL(blob);
  window.open(url,'_blank');
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}

function AIChat({entries,files,onNavigate}){
  const [msgs,setMsgs]=useState([{role:'assistant',content:'Hello Hassan! Ask me anything about UAE tax law — I will answer directly with specific law citations.'}]);
  const [input,setInput]=useState('');
  const [loading,setLoading]=useState(false);
  const [attach,setAttach]=useState(null);
  const [mode,setMode]=useState('research');
  const [lastQ,setLastQ]=useState('');
  const bottomRef=useRef();
  const fileRef=useRef();

  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth'});},[msgs,loading]);

  function buildKBContext(){
    return TAX_CATS.map(cat=>{
      const ces=entries.filter(e=>e.catId===cat.id);
      if(!ces.length) return null;
      return cat.label+'('+ces.length+'): '+ces.map(e=>e.title+(e.reference?' ('+e.reference+')':'')+(e.year?' ['+e.year+']':'')).join('; ');
    }).filter(Boolean).join('\n')||'No entries yet.';
  }

  function findRelevantPDFText(query){
    const qLower=query.toLowerCase();
    // Use longer words for better matching (min 4 chars), skip common words
    const stopWords=new Set(['that','this','with','from','have','which','were','will','what','when','before','after','about','their','there']);
    const words=qLower.split(/\s+/).filter(w=>w.length>3&&!stopWords.has(w));
    if(!words.length) return [];

    const relevant=[];
    entries.forEach(e=>{
      const fm=files.find(f=>f.name===e.attachedFile?.name);
      if(!fm?.extractedText) return;
      const lt=fm.extractedText.toLowerCase();

      // Score: how many query words appear in this document
      const matchedWords=words.filter(w=>lt.includes(w));
      const score=matchedWords.length;
      // Require at least 2 matching words, or 1 if query is short
      if(score<Math.min(2,words.length)) return;

      // Only get snippets that contain the matched words
      const snippets=[];
      const seen=new Set();
      matchedWords.forEach(w=>{
        let pos=lt.indexOf(w);
        while(pos>=0&&snippets.length<2){
          const key=Math.floor(pos/300);
          if(!seen.has(key)){
            seen.add(key);
            snippets.push(fm.extractedText.slice(Math.max(0,pos-150),pos+400));
          }
          pos=lt.indexOf(w,pos+1);
        }
      });

      if(!snippets.length) return;
      const cat=TAX_CATS.find(c=>c.id===e.catId);
      const dt=DOC_TYPES.find(d=>d.id===e.docTypeId);
      relevant.push({title:e.title,ref:e.reference,year:e.year,cat:cat?.label,dt:dt?.label,snippets,score});
    });

    // Sort by score descending, take top 4
    return relevant.sort((a,b)=>b.score-a.score).slice(0,4);
  }

  const baseSys='You are a UAE Tax Expert AI for Hassan Alhaj at RNI Consulting Dubai.\n\nCRITICAL: Answer ONLY what is asked. Do not answer a different question. If asked about pre-registration VAT claims, answer about pre-registration VAT claims — not TRN, not registration procedures, not anything else.\n\nSTEPS:\n1. Read the question carefully\n2. Answer that specific question directly in the first paragraph\n3. Use knowledge base passages ONLY if they are directly relevant to the question asked\n4. Ignore irrelevant passages even if they appear in the context\n\nFORMAT:\n- Use ## Answer, ## Legal Basis, ## Key Conditions, ## Practical Notes\n- Cite laws inline: [Federal Decree-Law No. 8/2017, Art. 55]\n- Bold key thresholds: **5 years**\n- End with [REF] lines for every cited law\n\nIf the knowledge base context does not contain relevant information, answer from your own UAE tax expertise — do not answer based on irrelevant passages.';


  async function send(){
    const text=input.trim();
    if(!text&&!attach) return;
    setInput('');setLastQ(text);
    let userContent='',displayContent='';
    if(attach){
      try{
        const b64=await apiBase64(attach.name);
        if(b64&&attach.name.toLowerCase().endsWith('.pdf'))
          userContent=[{type:'document',source:{type:'base64',media_type:'application/pdf',data:b64}},{type:'text',text:text||'Analyze this document with full law citations.'}];
        else userContent=text||'Analyze: '+attach.name;
      }catch{userContent=text||'Analyze: '+attach.name;}
      displayContent='📎 '+attach.name+(text?'\n'+text:'');
    } else if(mode==='research'){
      const relevant=findRelevantPDFText(text);
      let ctx='KNOWLEDGE BASE:\n'+buildKBContext()+'\n\n';
      if(relevant.length>0){
        ctx+='RELEVANT PDF PASSAGES ('+relevant.length+' docs):\n';
        relevant.forEach(r=>{
          ctx+='--- '+r.title+(r.ref?' ('+r.ref+')':'')+' ['+r.cat+'/'+r.dt+'] ---\n';
          r.snippets.forEach(s=>{ctx+=s+'\n...\n';});
        });
        ctx+='\nAnswer the question with specific law citations:\n';
      } else {
        ctx+='No matching documents found. Answer this question from your UAE tax expertise:\n';
      }
      if(ctx.length>14000) ctx=ctx.slice(0,14000)+'...[truncated]';
      userContent=ctx+'QUESTION: '+text;
      displayContent='🔬 '+text+(relevant.length>0?' ('+relevant.length+' docs)':'');
    } else {
      userContent='KNOWLEDGE BASE:\n'+buildKBContext()+'\n\nQUESTION: '+text;
      displayContent=text;
    }
    const history=msgs.filter(m=>m.role==='user'||m.role==='assistant').filter(m=>m._raw).slice(-6)
      .map(m=>({role:m.role,content:m._raw.length>6000?m._raw.slice(0,6000):m._raw}));
    const apiMsgs=[...history,{role:'user',content:userContent.length>14000?userContent.slice(0,14000):userContent}];
    setMsgs(p=>[...p,{role:'user',content:displayContent,_raw:userContent}]);
    setAttach(null);setLoading(true);
    try{
      const r=await callClaude(apiMsgs,baseSys);
      setMsgs(p=>[...p,{role:'assistant',content:r,_question:text,_raw:r}]);
    }catch(e){
      setMsgs(p=>[...p,{role:'assistant',content:'Error: '+e.message,_raw:''}]);
    }
    setLoading(false);
  }

  const suggestions=['Can we claim VAT on invoices before registration?','Small Business Relief — who qualifies?','Qualifying income for Free Zone persons?','Transfer pricing documentation requirements','De minimis threshold rules and consequences'];

  return(
    <div style={{display:'flex',flexDirection:'column',height:'calc(100vh - 80px)',maxWidth:900,margin:'0 auto',padding:'0 1rem'}}>
      <div style={{textAlign:'center',padding:'1rem 0 0.75rem',flexShrink:0}}>
        <h1 style={{fontSize:20,fontWeight:800,color:'#1E3A5F',marginBottom:3}}>◈ AI Research Assistant</h1>
        <p style={{fontSize:11,color:'#6B7280',marginBottom:10}}>Searches your PDFs · Cites laws & articles · Download as PDF</p>
        <div style={{display:'inline-flex',background:'#F3F4F6',borderRadius:8,padding:3,gap:2}}>
          {[{id:'research',label:'🔬 Research'},{id:'chat',label:'💬 Chat'}].map(m=>(
            <button key={m.id} onClick={()=>setMode(m.id)}
              style={{padding:'6px 18px',borderRadius:6,border:'none',cursor:'pointer',fontSize:12,fontWeight:600,
                background:mode===m.id?'#1E3A5F':'transparent',color:mode===m.id?'#fff':'#6B7280',transition:'all 0.15s'}}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{flex:1,overflowY:'auto',padding:'0.5rem 0',display:'flex',flexDirection:'column',gap:12}}>
        {msgs.map((m,i)=>(
          <div key={i} style={{display:'flex',justifyContent:m.role==='user'?'flex-end':'flex-start',gap:10,alignItems:'flex-start'}}>
            {m.role==='assistant'&&(
              <div style={{width:28,height:28,borderRadius:'50%',background:'#1E3A5F',display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:12,flexShrink:0,marginTop:2}}>◈</div>
            )}
            <div style={{maxWidth:'82%',padding:'10px 14px',borderRadius:12,fontSize:12.5,lineHeight:1.6,
              background:m.role==='user'?'#1E3A5F':'#fff',
              color:m.role==='user'?'#fff':'#374151',
              border:m.role==='user'?'none':'1.5px solid #E2E8F0',
              borderBottomRightRadius:m.role==='user'?4:12,
              borderBottomLeftRadius:m.role==='assistant'?4:12,
              boxShadow:m.role==='assistant'?'0 2px 8px rgba(0,0,0,0.06)':'none',
              whiteSpace:'pre-wrap'}}>
              {m.role==='assistant'&&!m.content.startsWith('Error:')?
                <RenderResponse text={m.content} onDownload={()=>downloadResponsePDF(m._question||lastQ,m.content,mode)} entries={entries} files={files} onNavigate={onNavigate}/>:
                m.content
              }
            </div>
          </div>
        ))}
        {loading&&(
          <div style={{display:'flex',gap:10,alignItems:'center'}}>
            <div style={{width:28,height:28,borderRadius:'50%',background:'#1E3A5F',display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:12}}>◈</div>
            <div style={{padding:'10px 14px',background:'#fff',border:'1.5px solid #E2E8F0',borderRadius:12,borderBottomLeftRadius:4}}>
              <div style={{display:'flex',gap:5,alignItems:'center'}}>
                {[0,1,2].map(j=><div key={j} style={{width:6,height:6,borderRadius:'50%',background:'#1E3A5F',opacity:0.5}}/>)}
                <span style={{fontSize:11,color:'#9CA3AF',marginLeft:6}}>{mode==='research'?'Searching documents...':'Thinking...'}</span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef}/>
      </div>

      {msgs.length<=1&&!loading&&(
        <div style={{padding:'0.5rem 0',flexShrink:0}}>
          <p style={{fontSize:10,color:'#9CA3AF',marginBottom:6,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.05em'}}>Try asking</p>
          <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
            {suggestions.map((s,i)=>(
              <button key={i} onClick={()=>{setInput(s);setMode('research');}}
                style={{padding:'5px 11px',background:'#fff',border:'1.5px solid #DBEAFE',borderRadius:20,fontSize:11,color:'#1E3A5F',cursor:'pointer',fontWeight:500}}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {attach&&(
        <div style={{padding:'6px 12px',background:'#FFFBEB',border:'1px solid #FCD34D',borderRadius:6,fontSize:11,color:'#854F0B',marginBottom:4,display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
          📎 {attach.name}
          <button onClick={()=>setAttach(null)} style={{background:'none',border:'none',cursor:'pointer',color:'#854F0B',fontSize:14}}>×</button>
        </div>
      )}

      <div style={{display:'flex',gap:8,padding:'0.75rem 0',flexShrink:0,borderTop:'1.5px solid #E5E7EB'}}>
        <button onClick={()=>fileRef.current?.click()}
          style={{padding:'0 12px',background:'#F9FAFB',border:'1.5px solid #E5E7EB',borderRadius:8,cursor:'pointer',fontSize:16,color:'#6B7280',flexShrink:0}}>
          📎
        </button>
        <input ref={fileRef} type="file" style={{display:'none'}} accept=".pdf,.txt"
          onChange={async e=>{const f=e.target.files[0];if(!f)return;const res=await apiUpload([f]);if(res.ok)setAttach(res.files[0]);e.target.value='';}}/>
        <input value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}}
          placeholder={mode==='research'?'Ask anything — AI searches your PDFs and cites laws...':'Ask about UAE tax...'}
          style={{flex:1,padding:'10px 14px',border:'1.5px solid #E5E7EB',borderRadius:8,fontSize:13,outline:'none',background:'#fff'}}/>
        <button onClick={send} disabled={loading||(!input.trim()&&!attach)}
          style={{padding:'10px 20px',background:'#1E3A5F',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontWeight:700,fontSize:12,flexShrink:0,opacity:loading?0.6:1}}>
          {mode==='research'?'🔬 Research':'Send'}
        </button>
      </div>
    </div>
  );
}


/* ─── File Library ───────────────────────────────────────────────────────── */
function FileLib({files,setFiles,entries,onAI}){
  const inputRef=useRef();
  const [uploading,setUploading]=useState(false);
  const [extracting,setExtracting]=useState(false);
  const [msg,setMsg]=useState("");
  const [viewFile,setViewFile]=useState(null);

  const safeFiles=Array.isArray(files)?files:[];
  const safeEntries=Array.isArray(entries)?entries:[];
  const searchable=safeFiles.filter(f=>f.extractedText&&f.extractedText.length>200).length;
  const pending=safeEntries.filter(e=>{
    if(!e.attachedFile?.name) return false;
    const fm=safeFiles.find(f=>f.name===e.attachedFile.name);
    return !fm||!fm.extractedText||fm.extractedText.length<200;
  }).length;

  async function doExtract(){
    const todo=safeEntries.filter(e=>{
      if(!e.attachedFile?.name) return false;
      const fm=safeFiles.find(f=>f.name===e.attachedFile.name);
      return !fm||!fm.extractedText||fm.extractedText.length<200;
    });
    if(!todo.length){setMsg("✓ All PDFs already extracted!");setTimeout(()=>setMsg(""),4000);return;}
    setExtracting(true);
    let done=0,fail=0;
    for(let i=0;i<todo.length;i++){
      const e=todo[i];
      setMsg("["+(i+1)+"/"+todo.length+"] "+e.title.slice(0,50)+"...");
      try{
        const b=await fetch(`${API.replace('/api','')}/api/file/${encodeURIComponent(e.attachedFile.name)}/base64`);
        if(!b.ok){fail++;continue;}
        const bj=await b.json();
        if(!bj.base64){fail++;continue;}
        const r=await extractPdfTextFromBase64(bj.base64);
        if(!r.text){fail++;continue;}
        const existing=safeFiles.find(f=>f.name===e.attachedFile.name);
        const meta={id:existing?.id||(e.id+"_m"),name:e.attachedFile.name,originalName:existing?.originalName||e.attachedFile.name,catId:e.catId,size:e.attachedFile.size||0,pages:r.pages||0,extractedText:r.text,createdAt:existing?.createdAt||new Date().toISOString()};
        await fetch(`${API}/files-meta`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify([meta])});
        done++;
      }catch(err){fail++;console.warn(err);}
    }
    const fr=await fetch(`${API}/files-meta`);
    if(fr.ok)setFiles(await fr.json());
    setMsg("✓ Done! "+done+" extracted"+(fail?" · "+fail+" failed":"")+". All content is now searchable.");
    setExtracting(false);
    setTimeout(()=>setMsg(""),12000);
  }

  async function upload(fileList){
    if(!fileList||!fileList.length)return;
    setUploading(true);setMsg("Uploading...");
    try{
      const res=await apiUpload(fileList);
      if(!res.ok)throw new Error(res.error||"failed");
      const metas=res.files.map(f=>({id:genId(),name:f.name,originalName:f.original||f.name,fileType:"application/pdf",size:f.size||0,catId:"",notes:"",pages:0,extractedText:"",createdAt:new Date().toISOString()}));
      await fetch(`${API}/files-meta`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(metas)});
      const fr=await fetch(`${API}/files-meta`);
      if(fr.ok)setFiles(await fr.json());
      setMsg("✓ "+res.files.length+" file(s) uploaded");
    }catch(e){setMsg("Error: "+e.message);}
    setUploading(false);
    setTimeout(()=>setMsg(""),5000);
  }

  async function del(f){
    if(!confirm("Delete "+f.name+"?"))return;
    try{await apiDelete(f.name);}catch{}
    const next=safeFiles.filter(x=>x.id!==f.id);
    setFiles(next);
    await fetch(`${API}/files-meta`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(next)});
  }

  const catOf=id=>TAX_CATS.find(c=>c.id===id)||TAX_CATS[TAX_CATS.length-1];

  return(
    <div style={{padding:0}}>
      {/* ── Header ── */}
      <div style={{background:"#1E3A5F",borderRadius:12,padding:"20px 24px",marginBottom:20,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
        <div>
          <h1 style={{fontSize:20,fontWeight:800,color:"#fff",marginBottom:4}}>📁 File Library</h1>
          <p style={{fontSize:12,color:"rgba(255,255,255,0.7)"}}>
            {safeFiles.length} files · {searchable} searchable
            {pending>0&&<span style={{color:"#FCD34D",fontWeight:700}}> · {pending} need extraction</span>}
          </p>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={doExtract} disabled={extracting}
            style={{padding:"9px 18px",background:extracting?"#64748B":"#10B981",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:extracting?"not-allowed":"pointer",whiteSpace:"nowrap"}}>
            {extracting?"⏳ Extracting...":("🔍 Extract All PDFs"+(pending>0?" ("+pending+" new)":""))}
          </button>
          <button onClick={()=>inputRef.current?.click()} disabled={uploading}
            style={{padding:"9px 18px",background:"#fff",color:"#1E3A5F",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>
            {uploading?"Uploading...":"+ Upload Files"}
          </button>
        </div>
      </div>

      <input ref={inputRef} type="file" multiple accept=".pdf,application/pdf" style={{display:"none"}}
        onChange={e=>{upload(e.target.files);e.target.value="";}}/>

      {/* ── Status ── */}
      {msg&&<div style={{marginBottom:12,padding:"10px 16px",background:msg.startsWith("✓")?"#F0FDF4":"#FFFBEB",border:"1px solid "+(msg.startsWith("✓")?"#86EFAC":"#FCD34D"),borderRadius:8,fontSize:12,fontWeight:600,color:msg.startsWith("✓")?"#166534":"#92400E"}}>{msg}</div>}

      {/* ── Drop zone ── */}
      <div onClick={()=>!uploading&&inputRef.current?.click()}
        onDrop={e=>{e.preventDefault();upload(e.dataTransfer.files);}}
        onDragOver={e=>e.preventDefault()}
        style={{border:"2px dashed #CBD5E1",borderRadius:10,padding:"20px",textAlign:"center",cursor:"pointer",marginBottom:20,background:"#F8FAFF"}}>
        <p style={{fontSize:13,color:"#64748B",fontWeight:600,margin:0}}>📂 Drop PDFs here or click to upload</p>
      </div>

      {/* ── Files grid ── */}
      {safeFiles.length===0?(
        <div style={{textAlign:"center",padding:"3rem",background:"#fff",borderRadius:12,border:"1.5px solid #E2E8F0"}}>
          <p style={{fontSize:32,marginBottom:8}}>📄</p>
          <p style={{fontWeight:700,color:"#1E3A5F",marginBottom:4}}>No files yet</p>
          <p style={{fontSize:12,color:"#94A3B8"}}>Upload PDFs using the button above</p>
        </div>
      ):(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
          {safeFiles.map(f=>{
            const cat=catOf(f.catId);
            const extracted=f.extractedText&&f.extractedText.length>200;
            return(
              <div key={f.id||f.name} style={{background:"#fff",border:"1.5px solid #E2E8F0",borderRadius:10,padding:14,display:"flex",flexDirection:"column",gap:8}}>
                <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                  <span style={{fontSize:24,flexShrink:0}}>📄</span>
                  <div style={{flex:1,minWidth:0}}>
                    <p style={{fontWeight:700,fontSize:12,lineHeight:1.4,color:"#1E3A5F",wordBreak:"break-word",margin:0}}>{f.originalName||f.name}</p>
                    <p style={{fontSize:10,color:"#94A3B8",marginTop:2}}>{fmtSize(f.size)}</p>
                  </div>
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                  <span style={{background:cat.color+"22",color:cat.color,fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:12}}>{cat.label}</span>
                  <span style={{fontSize:10,fontWeight:700,color:extracted?"#059669":"#D97706"}}>
                    {extracted?"✓ Searchable":"⏳ Not extracted"}
                  </span>
                </div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:4}}>
                  <a href={fileViewUrl(f.name)} target="_blank" rel="noreferrer"
                    style={{padding:"4px 10px",background:"#F1F5F9",border:"1px solid #E2E8F0",borderRadius:6,fontSize:11,fontWeight:600,textDecoration:"none",color:"#374151"}}>👁 Open</a>
                  <button onClick={()=>downloadFile(f.name)}
                    style={{padding:"4px 10px",background:"#1E40AF",color:"#fff",border:"none",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer"}}>⬇</button>
                  <button onClick={()=>onAI(null,f)}
                    style={{padding:"4px 10px",background:"#F5F3FF",color:"#7C3AED",border:"1px solid #DDD6FE",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer"}}>◈ AI</button>
                  <button onClick={()=>setViewFile(f)}
                    style={{padding:"4px 10px",background:"#F1F5F9",border:"1px solid #E2E8F0",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",color:"#374151"}}>✏</button>
                  <button onClick={()=>del(f)}
                    style={{padding:"4px 10px",background:"#FEF2F2",color:"#DC2626",border:"1px solid #FECACA",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer"}}>🗑</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewFile&&(
        <Modal title="Edit File" onClose={()=>setViewFile(null)}>
          <Field label="Tax Category">
            <select style={SEL} value={viewFile.catId||"gen"} onChange={e=>setViewFile(p=>({...p,catId:e.target.value}))}>
              {TAX_CATS.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Notes"><textarea style={TA} value={viewFile.notes||""} onChange={e=>setViewFile(p=>({...p,notes:e.target.value}))}/></Field>
          <div style={{display:"flex",gap:8}}>
            <Btn variant="primary" onClick={async()=>{
              const next=safeFiles.map(f=>f.id===viewFile.id?{...f,...viewFile}:f);
              setFiles(next);
              await fetch(`${API}/files-meta`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(next)});
              setViewFile(null);
            }}>Save</Btn>
            <Btn onClick={()=>setViewFile(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}


/* ─── Search ─────────────────────────────────────────────────────────────── */
function SearchPage({entries,files=[],onItem,onNavigate,onFileAI,initialQ=""}){
  const [q,setQ]=useState(initialQ||"");
  const [filterCat,setFilterCat]=useState("all");
  const [filterType,setFilterType]=useState("all");

  const qLow=q.trim().toLowerCase();
  const textKeys=["title","reference","articleNo","decisionNo","publicationRef","summary","fullText","notes","flashcards","examNotes","tags"];

  const pdfText=(ref)=>{
    if(!ref) return "";
    if(ref.extractedText) return ref.extractedText;
    const f=files.find(f=>f.name===ref.name);
    return f?.extractedText||"";
  };

  // Build flat rows across ALL entries
  const buildRows=()=>{
    if(!qLow) return [];
    const rows=[];
    entries
      .filter(e=>filterCat==="all"||e.catId===filterCat)
      .filter(e=>filterType==="all"||e.docTypeId===filterType)
      .forEach(e=>{
        const cat=TAX_CATS.find(c=>c.id===e.catId);
        const dt=DOC_TYPES.find(d=>d.id===e.docTypeId);
        // Text field matches
        textKeys.forEach(k=>{
          if(!e[k]||!e[k].toLowerCase().includes(qLow)) return;
          const snips=getPagedSnippets(e[k],q);
          if(snips.length>0){
            snips.slice(0,2).forEach(ps=>{
              rows.push({entry:e,cat,dt,source:k==="title"?"Title":k==="summary"?"Summary":k==="fullText"?"Full Text":k==="notes"?"Notes":k==="flashcards"?"Flashcards":k==="examNotes"?"Exam":k,snippet:ps.snippet,page:ps.page,fileName:null,inPdf:false});
            });
          } else {
            rows.push({entry:e,cat,dt,source:k==="title"?"Title":k==="summary"?"Summary":k==="fullText"?"Full Text":k==="notes"?"Notes":k==="flashcards"?"Flashcards":k==="examNotes"?"Exam":k,snippet:hilite(e[k]||"",q),page:null,fileName:null,inPdf:false});
          }
        });
        // PDF matches
        [{ref:e.attachedFile,label:"Law PDF"},{ref:e.notesFile,label:"Notes PDF"},{ref:e.flashFile,label:"Flash PDF"},{ref:e.summaryFile,label:"Summary PDF"},{ref:e.examFile,label:"Exam PDF"}]
          .filter(x=>x.ref)
          .forEach(({ref,label})=>{
            const txt=pdfText(ref);
            if(!txt.toLowerCase().includes(qLow)) return;
            const passages=getPagedSnippets(txt,q);
            if(passages.length>0){
              passages.slice(0,4).forEach(ps=>{
                rows.push({entry:e,cat,dt,source:label,snippet:ps.snippet,page:ps.page,fileName:ref.name,inPdf:true});
              });
            } else {
              rows.push({entry:e,cat,dt,source:label,snippet:hilite(txt,q),page:null,fileName:ref.name,inPdf:true});
            }
          });
      });
    return rows;
  };

  const rows=buildRows();

  // Filter pill counts
  const catCounts=qLow?TAX_CATS.map(cat=>({...cat,count:rows.filter(r=>r.cat?.id===cat.id).length})).filter(c=>c.count>0):[];
  const typeCounts=qLow?DOC_TYPES.map(dt=>({...dt,count:rows.filter(r=>r.dt?.id===dt.id).length})).filter(d=>d.count>0):[];

  return(<div>
    <h1 style={{fontSize:22,fontWeight:700,marginBottom:4}}>Search</h1>
    <p style={{fontSize:13,color:"var(--text2)",marginBottom:16}}>Searches all categories, document types, notes, flashcards, and inside PDFs</p>

    {/* Search box */}
    <div style={{position:"relative",marginBottom:16}}>
      <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",color:"var(--text3)",fontSize:18,pointerEvents:"none"}}>⌕</span>
      <input value={q} onChange={e=>{setQ(e.target.value);setFilterCat("all");setFilterType("all");}}
        placeholder="Type any keyword, article number, name, tag..."
        style={{...IS,paddingLeft:46,fontSize:15,padding:"13px 16px 13px 46px",borderRadius:"var(--radius)"}} autoFocus/>
      {q&&<button onClick={()=>{setQ("");setFilterCat("all");setFilterType("all");}} style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",background:"var(--surface2)",border:"none",borderRadius:"50%",width:22,height:22,fontSize:15,color:"var(--text2)",cursor:"pointer"}}>×</button>}
    </div>

    {/* Filters */}
    {catCounts.length>0&&(
      <div style={{marginBottom:8}}>
        <p style={{fontSize:10,fontWeight:700,color:"var(--text3)",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.08em"}}>Category</p>
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
          <button onClick={()=>setFilterCat("all")} style={{padding:"3px 11px",fontSize:11,borderRadius:20,cursor:"pointer",background:filterCat==="all"?"#0F172A":"#fff",color:filterCat==="all"?"#fff":"var(--text2)",border:"1.5px solid",borderColor:filterCat==="all"?"#0F172A":"var(--border2)",fontWeight:filterCat==="all"?700:400}}>All</button>
          {catCounts.map(cat=><button key={cat.id} onClick={()=>setFilterCat(cat.id)} style={{padding:"3px 11px",fontSize:11,borderRadius:20,cursor:"pointer",background:filterCat===cat.id?cat.color:"#fff",color:filterCat===cat.id?"#fff":cat.color,border:"1.5px solid "+cat.color,fontWeight:filterCat===cat.id?700:400}}>{cat.label} ({cat.count})</button>)}
        </div>
      </div>
    )}
    {typeCounts.length>0&&(
      <div style={{marginBottom:16}}>
        <p style={{fontSize:10,fontWeight:700,color:"var(--text3)",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.08em"}}>Document type</p>
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
          <button onClick={()=>setFilterType("all")} style={{padding:"3px 11px",fontSize:11,borderRadius:20,cursor:"pointer",background:filterType==="all"?"#0F172A":"#fff",color:filterType==="all"?"#fff":"var(--text2)",border:"1.5px solid",borderColor:filterType==="all"?"#0F172A":"var(--border2)",fontWeight:filterType==="all"?700:400}}>All types</button>
          {typeCounts.map(dt=><button key={dt.id} onClick={()=>setFilterType(dt.id)} style={{padding:"3px 11px",fontSize:11,borderRadius:20,cursor:"pointer",background:filterType===dt.id?"#0F172A":"#fff",color:filterType===dt.id?"#fff":"var(--text2)",border:"1.5px solid",borderColor:filterType===dt.id?"#0F172A":"var(--border2)",fontWeight:filterType===dt.id?700:400}}>{dt.icon} {dt.label} ({dt.count})</button>)}
        </div>
      </div>
    )}

    {/* Empty state */}
    {!qLow&&<div style={{textAlign:"center",padding:"4rem 2rem",background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)"}}>
      <p style={{fontSize:36,marginBottom:12}}>⌕</p>
      <p style={{fontWeight:700,fontSize:15,color:"var(--text)",marginBottom:8}}>Search your entire knowledge base</p>
      <p style={{fontSize:13,color:"var(--text2)",lineHeight:1.8}}>Laws · Cabinet &amp; Ministerial Decisions · FTA Decisions<br/>Guidelines · Public Clarifications · Bulletins · Procedures<br/>HM Notes · Exam Material · Notes · Flashcards · Summaries · PDFs</p>
    </div>}

    {qLow&&rows.length===0&&<div style={{textAlign:"center",padding:"3rem",background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)"}}>
      <p style={{fontSize:24,marginBottom:8}}>🔍</p>
      <p style={{fontWeight:600,color:"var(--text)",marginBottom:4}}>No results for "{q}"</p>
    </div>}

    {/* RESULTS TABLE */}
    {rows.length>0&&(
      <div>
        <p style={{fontSize:12,color:"var(--text2)",marginBottom:10,fontWeight:500}}>
          <strong>{rows.length}</strong> passage{rows.length!==1?"s":""} found for "<strong>{q}</strong>"
        </p>
        <div style={{background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",overflow:"auto",boxShadow:"var(--shadow)"}}>
          <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed"}}>
            <colgroup>
              <col style={{width:"14%"}}/>
              <col style={{width:"13%"}}/>
              <col style={{width:"11%"}}/>
              <col style={{width:"50%"}}/>
              <col style={{width:"12%"}}/>
            </colgroup>
            <thead>
              <tr style={{background:"var(--surface2)",borderBottom:"2px solid var(--border)"}}>
                {["Category","Doc Type","Source","Context (3 lines)","Page"].map(h=>(
                  <th key={h} style={{padding:"10px 12px",textAlign:h==="Page"?"center":"left",fontSize:11,fontWeight:700,color:"var(--text2)",letterSpacing:"0.05em",textTransform:"uppercase"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row,ri)=>{
                const isNewEntry=ri===0||rows[ri-1].entry.id!==row.entry.id||rows[ri-1].source!==row.source;
                return(
                  <tr key={ri}
                    onClick={()=>onItem(row.entry)}
                    onMouseEnter={e=>e.currentTarget.style.background="#F8FAFF"}
                    onMouseLeave={e=>e.currentTarget.style.background="#fff"}
                    style={{borderBottom:"1px solid var(--border)",cursor:"pointer",transition:"background 0.1s"}}>
                    {/* Category */}
                    <td style={{padding:"10px 12px",verticalAlign:"top"}}>
                      {row.cat&&<span style={{background:row.cat.color,color:"#fff",fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:20,display:"inline-block"}}>{row.cat.label}</span>}
                    </td>
                    {/* Doc Type */}
                    <td style={{padding:"10px 12px",verticalAlign:"top"}}>
                      {isNewEntry&&row.dt&&(
                        <div>
                          <span style={{background:"var(--nav)",color:"#fff",fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20,display:"inline-block",marginBottom:4}}>{row.dt.icon} {row.dt.label}</span>
                          <p style={{fontWeight:700,fontSize:11,color:"var(--text)",lineHeight:1.3}}><HL text={row.entry.title} q={q}/></p>
                          {(row.entry.reference||row.entry.decisionNo)&&<p style={{fontSize:10,color:"var(--text3)",marginTop:2}}>{row.entry.reference||row.entry.decisionNo}</p>}
                          {row.entry.year&&<p style={{fontSize:10,color:"var(--text3)"}}>{row.entry.year}{row.entry.month?" · "+row.entry.month:""}</p>}
                        </div>
                      )}
                    </td>
                    {/* Source */}
                    <td style={{padding:"10px 12px",verticalAlign:"top"}}>
                      <span style={{fontSize:10,fontWeight:700,color:"#fff",background:row.inPdf?"#059669":"var(--nav)",padding:"2px 8px",borderRadius:20,whiteSpace:"nowrap",display:"inline-block"}}>
                        {row.inPdf?"📄 ":""}{row.source}
                      </span>
                    </td>
                    {/* Context */}
                    <td style={{padding:"10px 12px",verticalAlign:"top"}}>
                      <p style={{fontSize:12,color:"var(--text2)",lineHeight:1.8,display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical",overflow:"hidden"}}>
                        <HL text={row.snippet} q={q}/>
                      </p>
                    </td>
                    {/* Page */}
                    <td style={{padding:"10px 12px",verticalAlign:"top",textAlign:"center"}}>
                      {row.inPdf&&row.page?(
                        <a href={fileViewUrl(row.fileName)+"#page="+row.page} target="_blank" rel="noreferrer"
                          onClick={e=>e.stopPropagation()}
                          style={{display:"inline-block",background:"#15803D",color:"#fff",fontSize:11,fontWeight:700,padding:"4px 10px",borderRadius:20,textDecoration:"none",whiteSpace:"nowrap"}}>
                          p.{row.page} →
                        </a>
                      ):row.page?(
                        <span style={{fontSize:11,color:"var(--text3)"}}>p.{row.page}</span>
                      ):(
                        <span style={{fontSize:11,color:"var(--text3)"}}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{padding:"8px 12px",borderTop:"1px solid var(--border)",fontSize:12,color:"var(--text3)"}}>{rows.length} passage{rows.length!==1?"s":""} · click any row to open the full entry</div>
        </div>
      </div>
    )}
  </div>);
}
/* ─── Dashboard ──────────────────────────────────────────────────────────── */
function Dashboard({entries,files,onCat,onSearch}){
  return(<div>
    <h1 style={{fontSize:26,fontWeight:800,marginBottom:4}}>Dashboard</h1>
    <p style={{fontSize:13,color:"var(--text2)",marginBottom:24}}>Hassan Tax World · UAE Tax Knowledge Base</p>
    <div style={{display:"flex",gap:10,marginBottom:28}}>
      <div style={{flex:1,position:"relative"}}>
        <span style={{position:"absolute",left:13,top:"50%",transform:"translateY(-50%)",color:"var(--text3)",fontSize:16}}>⌕</span>
        <input placeholder="Search everything..." style={{...IS,paddingLeft:42,fontSize:14,padding:"11px 14px 11px 42px"}} onFocus={onSearch} readOnly/>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:14,marginBottom:32}}>
      {TAX_CATS.map(cat=>{
        const ces=entries.filter(e=>e.catId===cat.id);
        const tabs=docTypesForCat(cat.id);
        const counts=Object.fromEntries(tabs.map(d=>[d.id,ces.filter(e=>e.docTypeId===d.id).length]));
        return<button key={cat.id} onClick={()=>onCat(cat.id)}
          onMouseEnter={e=>{e.currentTarget.style.borderColor=cat.color;e.currentTarget.style.boxShadow="var(--shadow-md)";}}
          onMouseLeave={e=>{e.currentTarget.style.borderColor=cat.color+"30";e.currentTarget.style.boxShadow="var(--shadow)";}}
          style={{background:"#fff",border:`1.5px solid ${cat.color}30`,borderRadius:"var(--radius)",padding:"1.25rem",textAlign:"left",cursor:"pointer",boxShadow:"var(--shadow)",transition:"all 0.15s"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:cat.color}}/>
            <span style={{fontSize:26,fontWeight:800,color:cat.color}}>{ces.length}</span>
          </div>
          <p style={{fontWeight:700,fontSize:15,color:"var(--text)",marginBottom:10}}>{cat.label}</p>
          <div style={{display:"flex",flexDirection:"column",gap:3}}>
            {tabs.filter(d=>counts[d.id]>0).slice(0,5).map(d=>(
              <div key={d.id} style={{display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:11,color:"var(--text2)"}}>{d.icon} {d.label}</span>
                <span style={{fontSize:11,fontWeight:600,color:"var(--text2)"}}>{counts[d.id]}</span>
              </div>
            ))}
          </div>
        </button>;
      })}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:12}}>
      {[["Total",entries.length,"📚"],["Files",files.length,"📁"],["Laws",entries.filter(e=>e.docTypeId==="laws").length,"⚖"],["Cabinet Dec.",entries.filter(e=>e.docTypeId==="cabinet").length,"🏛"],["Ministerial",entries.filter(e=>e.docTypeId==="ministerial").length,"📜"],["FTA Dec.",entries.filter(e=>e.docTypeId==="fta").length,"🏢"],["HM Notes",entries.filter(e=>e.docTypeId==="hmnotes").length,"✏"],["Exam",entries.filter(e=>e.docTypeId==="hmexam").length,"🎓"]].map(([l,c,i])=>(
        <div key={l} style={{background:"#fff",border:"1.5px solid var(--border)",borderRadius:"var(--radius)",padding:"1rem",boxShadow:"var(--shadow)"}}>
          <span style={{fontSize:20}}>{i}</span>
          <p style={{fontSize:24,fontWeight:700,margin:"4px 0 2px"}}>{c}</p>
          <p style={{fontSize:11,color:"var(--text2)"}}>{l}</p>
        </div>
      ))}
    </div>
  </div>);
}

/* ─── Main App ───────────────────────────────────────────────────────────── */
export default function LoginScreen({onLogin}){
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);

  async function login(e){
    e.preventDefault();
    if(!username.trim()||!password.trim()){setError("Please enter username and password");return;}
    setLoading(true);setError("");
    try{
      const r=await fetch(API+"/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:username.trim(),password})});
      const d=await r.json();
      if(d.ok){
        localStorage.setItem("htw_token",d.token);
        localStorage.setItem("htw_name",d.name||username);
        window.location.reload();
      } else {
        setError(d.error||"Invalid credentials");
      }
    }catch(e2){setError("Cannot reach server. Make sure it is running.");}
    setLoading(false);
  }

  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0F2847 0%,#1E3A5F 50%,#0F2847 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:"#fff",borderRadius:16,padding:"40px 48px",width:"100%",maxWidth:400,boxShadow:"0 25px 80px rgba(0,0,0,0.4)"}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{fontSize:48,marginBottom:12}}>◈</div>
          <h1 style={{fontSize:24,fontWeight:800,color:"#1E3A5F",marginBottom:6}}>Hassan Tax World</h1>
          <p style={{fontSize:13,color:"#94A3B8"}}>UAE Tax Knowledge Base</p>
        </div>
        <form onSubmit={login}>
          <div style={{marginBottom:16}}>
            <label style={{fontSize:11,fontWeight:700,color:"#64748B",textTransform:"uppercase",letterSpacing:"0.08em",display:"block",marginBottom:6}}>Username</label>
            <input value={username} onChange={e=>setUsername(e.target.value)} placeholder="Enter your username"
              style={{width:"100%",padding:"11px 14px",border:"1.5px solid #E2E8F0",borderRadius:8,fontSize:14,outline:"none",boxSizing:"border-box"}}
              autoFocus autoComplete="username"/>
          </div>
          <div style={{marginBottom:24}}>
            <label style={{fontSize:11,fontWeight:700,color:"#64748B",textTransform:"uppercase",letterSpacing:"0.08em",display:"block",marginBottom:6}}>Password</label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Enter your password"
              style={{width:"100%",padding:"11px 14px",border:"1.5px solid #E2E8F0",borderRadius:8,fontSize:14,outline:"none",boxSizing:"border-box"}}
              autoComplete="current-password"/>
          </div>
          {error&&<div style={{background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#DC2626",marginBottom:16,fontWeight:600}}>{error}</div>}
          <button type="submit" disabled={loading}
            style={{width:"100%",padding:"13px",background:"#1E3A5F",color:"#fff",border:"none",borderRadius:8,fontSize:14,fontWeight:700,cursor:loading?"not-allowed":"pointer",opacity:loading?0.7:1}}>
            {loading?"Signing in...":"Sign In"}
          </button>
        </form>
        <p style={{textAlign:"center",fontSize:11,color:"#CBD5E1",marginTop:24}}>
          Hassan Tax World · RNI Consulting Dubai
        </p>
      </div>
    </div>
  );
}

function App(){
  const [token,setToken]=useState(()=>localStorage.getItem("htw_token")||"");
  const [userName,setUserName]=useState(()=>localStorage.getItem("htw_name")||"");
  const [entries,setEntries]=useState([]);
  const [files,setFiles]=useState([]);
  const [loaded,setLoaded]=useState(false);


  const [nav,setNav]=useState({view:"dashboard"});
  const [globalSearchQ,setGlobalSearchQ]=useState("");
  const [expanded,setExpanded]=useState({});
  const [modal,setModal]=useState(null);
  const [detail,setDetail]=useState(null);
  const [aiTarget,setAiTarget]=useState(null);

  useEffect(()=>{
    (async()=>{
      try{
        const [e,f]=await Promise.all([lsGet(STORE_KEY),lsGet(FILES_KEY)]);
        if(e)setEntries(e);
        if(f)setFiles(f);
        try{
          const serverFiles=await apiListFiles();
          if(f&&serverFiles.length>0){
            const existingNames=new Set((f||[]).map(x=>x.name));
            const missing=serverFiles.filter(sf=>!existingNames.has(sf.name));
            if(missing.length>0){
              const newMeta=missing.map(sf=>({id:genId(),name:sf.name,fileType:"application/pdf",size:sf.size,catId:"gen",notes:"",pages:0,extractedText:"",createdAt:new Date(sf.modified).toISOString()}));
              const next=[...(f||[]),...newMeta];
              setFiles(next);await lsSet(FILES_KEY,next);
            }
          }
        }catch{}
      }catch{}
      setLoaded(true);
    })();
  },[token]);

// Downloads polling removed

  const saveEntry=async item=>{
    const nx=modal?.editing?entries.map(x=>x.id===item.id?item:x):[item,...entries];
    setEntries(nx);await lsSet(STORE_KEY,nx);
  };
  const deleteEntry=async id=>{
    const nx=entries.filter(x=>x.id!==id);setEntries(nx);await lsSet(STORE_KEY,nx);setDetail(null);
  };
  // ── Backup / Restore ─────────────────────────────────────────────
  async function exportBackup(){
    let entries=[], files2=[];
    try{
      const er=await fetch(`${API}/entries`);
      if(er.ok) entries=await er.json();
      const fr=await fetch(`${API}/files-meta`);
      if(fr.ok) files2=await fr.json();
    }catch(e){
      entries=JSON.parse(localStorage.getItem("kb-entries-v2")||"[]");
      files2=JSON.parse(localStorage.getItem("kb-files-meta-v2")||"[]");
    }
    const data={
      entries, files:files2,
      exportedAt:new Date().toISOString(),version:"2"
    };
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download="hassan-tax-backup-"+new Date().toISOString().slice(0,10)+".json";
    a.click();URL.revokeObjectURL(url);
  }
  function importBackup(file){
    const reader=new FileReader();
    reader.onload=async e=>{
      try{
        const data=JSON.parse(e.target.result);
        const entries=data.entries||[];
        const files2=data.files||[];
        if(!entries.length&&!files2.length){alert("No data found in backup file.");return;}
        if(!window.confirm("Replace current data with "+entries.length+" entries from this backup?"))return;
        // Save to server
        try{
          await fetch(`${API}/entries`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(entries)});
          await fetch(`${API}/files-meta`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(files2)});
        }catch(e){console.warn("Server restore failed, using localStorage");}
        // Also save to localStorage as backup
        try{localStorage.setItem("kb-entries-v2",JSON.stringify(entries));}catch{}
        try{localStorage.setItem("kb-files-meta-v2",JSON.stringify(files2));}catch{}
        setEntries(entries);setFiles(files2);
        alert("Restored "+entries.length+" entries and "+files2.length+" files!");
      }catch{alert("Error reading backup file.");}
    };reader.readAsText(file);
  }

  const goCat=(catId)=>{
    const tabs=docTypesForCat(catId);
    setNav({view:"cat",catId,docTypeId:tabs[0].id});
    setExpanded(p=>({...p,[catId]:true}));
  };

  if(!token) return <LoginScreen onLogin={(t,n)=>{setToken(t);setUserName(n);setLoaded(false);}}/>;
  if(!loaded)return<div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:"#F0F2F5"}}><Spinner size={36}/></div>;
  const navCat=nav.catId?TAX_CATS.find(c=>c.id===nav.catId):null;

  return(<div style={{display:"flex",minHeight:"100vh"}}>
    
    <style>{G}</style>

    {/* ── Sidebar ───────────────────────────────────────────────────── */}
    <div style={{width:220,background:"var(--nav)",display:"flex",flexDirection:"column",flexShrink:0,position:"sticky",top:0,height:"100vh",overflow:"auto"}}>
      {/* Logo */}
      <div style={{padding:"1.1rem 1rem",borderBottom:"1px solid rgba(255,255,255,0.07)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:36,height:36,background:"var(--accent)",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>⚖</div>
          <div><p style={{color:"#fff",fontWeight:700,fontSize:14}}>UAE Tax</p><p style={{color:"rgba(255,255,255,0.35)",fontSize:11}}>Hassan Tax World</p></div>
        </div>
      </div>
      {/* Top nav */}
      <div style={{padding:"0.5rem 0.5rem 0"}}>
        {[{id:"dashboard",label:"Dashboard",icon:"⊞"},{id:"search",label:"Search",icon:"⌕"},{id:"alldocs",label:"All Documents",icon:"🗂"}].map(n=>(
          <button key={n.id} onClick={()=>setNav({view:n.id})} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"8px 12px",marginBottom:2,borderRadius:7,background:nav.view===n.id?"var(--nav-active)":"transparent",border:"none",cursor:"pointer",textAlign:"left",color:nav.view===n.id?"var(--accent)":"rgba(255,255,255,0.58)",fontWeight:nav.view===n.id?600:400,fontSize:13}}>
            <span style={{fontSize:14,width:18,textAlign:"center"}}>{n.icon}</span>{n.label}
          </button>
        ))}
      </div>
      {/* Tax Categories */}
      <div style={{padding:"0.25rem 0.5rem",flex:1}}>
        <p style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.22)",letterSpacing:"0.1em",padding:"10px 12px 5px",textTransform:"uppercase"}}>Tax Categories</p>
        {TAX_CATS.map(cat=>{
          const isOpen=expanded[cat.id];
          const isActiveCat=nav.view==="cat"&&nav.catId===cat.id;
          const cnt=entries.filter(e=>e.catId===cat.id).length;
          const tabs=docTypesForCat(cat.id);
          return(<div key={cat.id}>
            <button onClick={()=>setExpanded(p=>({...p,[cat.id]:!p[cat.id]}))} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderRadius:7,background:isActiveCat&&!isOpen?"var(--nav-active)":"transparent",border:"none",cursor:"pointer",textAlign:"left",color:isActiveCat?"var(--accent)":"rgba(255,255,255,0.65)",fontWeight:isActiveCat?600:400,fontSize:13,marginBottom:1}}>
              <span style={{width:8,height:8,borderRadius:"50%",background:cat.color,flexShrink:0}}/>
              <span style={{flex:1}}>{cat.label}</span>
              {cnt>0&&<span style={{fontSize:10,color:"rgba(255,255,255,0.3)",background:"rgba(255,255,255,0.06)",padding:"1px 7px",borderRadius:20}}>{cnt}</span>}
              <span style={{fontSize:11,color:"rgba(255,255,255,0.3)",transform:isOpen?"rotate(180deg)":"none",transition:"transform 0.2s",display:"inline-block"}}>▾</span>
            </button>
            {isOpen&&<div style={{marginLeft:8,marginBottom:4,borderLeft:"1px solid rgba(255,255,255,0.08)",paddingLeft:8}}>
              {tabs.map(dt=>{
                const isActive=nav.view==="cat"&&nav.catId===cat.id&&nav.docTypeId===dt.id;
                const c=entries.filter(e=>e.catId===cat.id&&e.docTypeId===dt.id).length;
                return<button key={dt.id} onClick={()=>setNav({view:"cat",catId:cat.id,docTypeId:dt.id})} style={{width:"100%",display:"flex",alignItems:"center",gap:7,padding:"6px 10px",borderRadius:6,background:isActive?"var(--nav-active)":"transparent",border:"none",cursor:"pointer",textAlign:"left",color:isActive?"var(--accent)":"rgba(255,255,255,0.48)",fontWeight:isActive?600:400,fontSize:12,marginBottom:1}}>
                  <span style={{fontSize:12}}>{dt.icon}</span>
                  <span style={{flex:1}}>{dt.label}</span>
                  {c>0&&<span style={{fontSize:10,color:"rgba(255,255,255,0.25)"}}>{c}</span>}
                </button>;
              })}
            </div>}
          </div>);
        })}
      </div>
      {/* Tools */}
      <div style={{padding:"0.4rem 0.5rem",borderTop:"1px solid rgba(255,255,255,0.07)"}}>
        <div style={{marginTop:"auto",borderTop:"1px solid rgba(255,255,255,0.1)",paddingTop:12,marginBottom:8}}>
          <div style={{padding:"6px 12px",fontSize:11,color:"rgba(255,255,255,0.5)",marginBottom:4}}>Logged in as <strong style={{color:"rgba(255,255,255,0.8)"}}>{userName}</strong></div>
          <button onClick={async()=>{
            try{await fetch(API+"/logout",{method:"POST",headers:{"x-auth-token":token}});}catch{}
            localStorage.removeItem("htw_token");localStorage.removeItem("htw_name");
            setToken("");setUserName("");setEntries([]);setFiles([]);setLoaded(false);
          }} style={{width:"100%",padding:"7px 12px",background:"rgba(255,255,255,0.1)",border:"none",borderRadius:6,color:"rgba(255,255,255,0.7)",fontSize:12,cursor:"pointer",textAlign:"left",fontWeight:600}}>
            🚪 Sign Out
          </button>
        </div>
        {[{id:"files",label:"File Library",icon:"📁"},{id:"ai",label:"AI Assistant",icon:"◈"}].map(n=>(
          <button key={n.id} onClick={()=>setNav({view:n.id})} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"8px 12px",marginBottom:2,borderRadius:7,background:nav.view===n.id?"var(--nav-active)":"transparent",border:"none",cursor:"pointer",textAlign:"left",color:nav.view===n.id?"var(--accent)":"rgba(255,255,255,0.55)",fontWeight:nav.view===n.id?600:400,fontSize:13}}>
            <span style={{fontSize:14,width:18,textAlign:"center"}}>{n.icon}</span>{n.label}
          </button>
        ))}
      </div>

      {/* Backup / Restore */}
      <div style={{padding:"0.5rem",borderTop:"1px solid rgba(255,255,255,0.07)",marginTop:"auto"}}>
        <p style={{fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.22)",letterSpacing:"0.1em",padding:"4px 8px 4px",textTransform:"uppercase"}}>Data Backup</p>
        <button onClick={exportBackup}
          style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"7px 10px",marginBottom:2,borderRadius:6,background:"rgba(16,185,129,0.15)",border:"1px solid rgba(16,185,129,0.3)",cursor:"pointer",textAlign:"left",color:"#6EE7B7",fontSize:12,fontWeight:600}}>
          <span>💾</span> Export Backup
        </button>
        <label style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"7px 10px",borderRadius:6,background:"rgba(59,130,246,0.12)",border:"1px solid rgba(59,130,246,0.25)",cursor:"pointer",color:"#93C5FD",fontSize:12,fontWeight:600}}>
          <span>📂</span> Restore Backup
          <input type="file" accept=".json" style={{display:"none"}} onChange={e=>{if(e.target.files[0]){importBackup(e.target.files[0]);e.target.value="";}}}/>
        </label>
      </div>
    </div>

    {/* ── Main content ─────────────────────────────────────────────── */}
    <main style={{flex:1,background:"var(--bg)",padding:"1.25rem 1.5rem",overflow:"auto",minWidth:0}}>
      {nav.view==="dashboard"&&<Dashboard entries={entries} files={files} onCat={goCat} onSearch={()=>setNav({view:"search"})}/>}
      {nav.view==="alldocs"&&(
        <div>
          <h1 style={{fontSize:22,fontWeight:700,marginBottom:16}}>All Documents</h1>
          <div style={{display:"grid",gap:10}}>
            {entries.map(it=><EntryCard key={it.id} item={it} onClick={()=>setDetail(it)}/>)}
          </div>
          {entries.length===0&&<div style={{textAlign:"center",padding:"3rem",background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",color:"var(--text2)"}}>No entries yet.</div>}
        </div>
      )}
      {nav.view==="cat"&&navCat&&(
        <CatPage cat={navCat} entries={entries} files={files} activeType={nav.docTypeId||docTypesForCat(navCat.id)[0].id}
          onChangeType={dt=>setNav(p=>({...p,docTypeId:dt}))}
          onAdd={()=>setModal({catId:nav.catId,docTypeId:nav.docTypeId,editing:null})}
          onBulkSave={async newEntries=>{
            try{
              const er=await fetch(`${API}/entries`);
              if(er.ok) setEntries(await er.json());
              const fr=await fetch(`${API}/files-meta`);
              if(fr.ok) setFiles(await fr.json());
            }catch(err){ console.error("State refresh error:",err); }
          }}
          onItem={it=>{
              if(it._moveAction){
                // Move entry to new cat/docType
                const {catId,docTypeId}=it._moveAction;
                const updated=entries.map(e=>e.id===it.id?{...e,catId,docTypeId,updatedAt:new Date().toISOString()}:e);
                setEntries(updated);
                lsSet(STORE_KEY,updated);
                fetch(`${API}/entries`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(updated)}).catch(()=>{});
              } else {
                setDetail(it);
              }
            }}
          onSearchAll={term=>{setGlobalSearchQ(term);setNav({view:"search"});}}/>
      )}
      {nav.view==="files"&&<FileLib files={files} setFiles={setFiles} entries={entries} onAI={(item,file)=>setAiTarget({item,file})}/>}
      {nav.view==="ai"&&<div style={{height:"100%",display:"flex",flexDirection:"column"}}><AIChat entries={entries} files={files} onNavigate={it=>{setDetail(it);setNav({view:"cat",catId:it.catId,docTypeId:it.docTypeId});}}/></div>}
      {nav.view==="search"&&<SearchPage key={globalSearchQ} initialQ={globalSearchQ} entries={entries} files={files}
        onItem={it=>{
          // Open the entry detail AND navigate sidebar to its section
          setExpanded(p=>({...p,[it.catId]:true}));
          setDetail(it);
        }}
        onNavigate={(catId,docTypeId)=>setNav({view:"cat",catId,docTypeId})}
        onFileAI={(i,f)=>setAiTarget({item:i,file:f})}/>}
    </main>

    {/* ── Modals ────────────────────────────────────────────────────── */}
    {modal&&(
      <Modal title={`${modal.editing?"Edit":"Add"} — ${TAX_CATS.find(c=>c.id===modal.catId)?.label} › ${DOC_TYPES.find(d=>d.id===modal.docTypeId)?.label}`} onClose={()=>setModal(null)}>
        <EntryForm catId={modal.catId} docTypeId={modal.docTypeId} initial={modal.editing}
          onSave={item=>{saveEntry(item);setModal(null);}} onClose={()=>setModal(null)}/>
      </Modal>
    )}
    {detail&&(
      <DetailModal item={detail} onClose={()=>setDetail(null)}
        onEdit={()=>{setModal({catId:detail.catId,docTypeId:detail.docTypeId,editing:detail});setDetail(null);}}
        onDelete={()=>{if(!confirm("Delete this entry?"))return;deleteEntry(detail.id);}}
        onAI={()=>{setAiTarget({item:detail,file:null});setDetail(null);}}/>
    )}
    {aiTarget&&<AIPanel item={aiTarget.item} file={aiTarget.file} onClose={()=>setAiTarget(null)}/>}
  </div>);
}
