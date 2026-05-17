import { useState, useEffect, useRef, useCallback } from "react";

/* ─── API helpers — talks to local Express server ────────────────────────── */
const API = "http://localhost:3001/api";

async function apiListFiles() {
  try { const r = await fetch(`${API}/files`); return await r.json(); }
  catch { return []; }
}
async function apiUpload(fileList) {
  const fd = new FormData();
  for (const f of fileList) fd.append("files", f);
  const r = await fetch(`${API}/upload`, { method: "POST", body: fd });
  return await r.json();
}
async function apiDelete(name) {
  await fetch(`${API}/file/${encodeURIComponent(name)}`, { method: "DELETE" });
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
async function lsSet(key,val){ try{localStorage.setItem(key,JSON.stringify(val));}catch{} }
async function lsGet(key){ try{const v=localStorage.getItem(key);return v?JSON.parse(v):null;}catch{return null;} }

async function callClaude(messages, system="") {
  try {
    const res=await fetch("http://localhost:3001/api/ai",{
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
    if(e.message==="Failed to fetch") throw new Error("Cannot reach server — make sure npm run dev is running");
    throw e;
  }
}

/* ─── Global CSS ─────────────────────────────────────────────────────────── */
const G = `
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
const hilite  = (text,q) => {
  if(!q||!text) return (text||"").slice(0,120)+"...";
  const i=text.toLowerCase().indexOf(q.toLowerCase());
  if(i===-1) return text.slice(0,120)+"...";
  const s=Math.max(0,i-60),e=Math.min(text.length,i+q.length+60);
  return(s>0?"...":"")+text.slice(s,e)+(e<text.length?"...":"");
};

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
      <div style={{padding:"1.5rem",overflow:"auto"}}>{children}</div>
    </div>
  </div>
);

/* ─── Status Badge ───────────────────────────────────────────────────────── */
const STS={Active:{bg:"#D1FAE5",c:"#064E3B"},Amended:{bg:"#FEF3C7",c:"#78350F"},Superseded:{bg:"#FEE2E2",c:"#7F1D1D"},Draft:{bg:"#E0E7FF",c:"#3730A3"}};
const SBadge=({s})=>{ const st=STS[s]||STS.Active; return<span style={{background:st.bg,color:st.c,fontSize:11,fontWeight:600,padding:"2px 9px",borderRadius:20,whiteSpace:"nowrap"}}>{s}</span>; };

/* ─── Entry Form ─────────────────────────────────────────────────────────── */
function EntryForm({catId,docTypeId,initial,onSave,onClose}){
  const cat=TAX_CATS.find(c=>c.id===catId);
  const dt=DOC_TYPES.find(d=>d.id===docTypeId);
  const isNote=["hmnotes","hmexam"].includes(docTypeId);
  const [f,setF]=useState(initial||{title:"",reference:"",articleNo:"",publicationRef:"",decisionNo:"",effectiveDate:"",issueDate:"",year:"",month:"",status:"Active",summary:"",fullText:"",notes:"",flashcards:"",tags:"",attachedFile:null,summaryFile:null,examFile:null});
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
      // Save to file library too
      const meta={id:genId(),name:saved.name,originalName:saved.original,fileType:file.type,size:saved.size,catId,notes:"",pages,extractedText,createdAt:new Date().toISOString()};
      // Store meta in localStorage
      const existing=JSON.parse(localStorage.getItem("kb-files-meta-v2")||"[]");
      localStorage.setItem("kb-files-meta-v2",JSON.stringify([meta,...existing]));
      s("attachedFile",{name:saved.name,pages,size:saved.size});
      setUploadMsg(`✓ ${saved.name} attached${pages>0?` · ${pages} pages extracted`:""}`);
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
          onDrop={e=>{e.preventDefault();if(!uploading)handleAttach(e.dataTransfer.files);}}
          onDragOver={e=>e.preventDefault()}
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

    <Field label={isNote?"Content":"Summary"}><textarea style={TA} value={f.summary} onChange={e=>s("summary",e.target.value)} placeholder={isNote?"Write your content, study notes, exam insights...":"Brief summary of this provision..."}/></Field>
    {!isNote&&<Field label="Full Text / Verbatim"><textarea style={{...TA,minHeight:120}} value={f.fullText} onChange={e=>s("fullText",e.target.value)} placeholder="Paste the complete legal text here (or leave blank if PDF attached above)..."/></Field>}
    <Field label="HM Personal Notes"><textarea style={TA} value={f.notes} onChange={e=>s("notes",e.target.value)} placeholder="Your personal observations, exam tips, exceptions..."/></Field>
    <Field label="Flashcards"><textarea style={{...TA,minHeight:70}} value={f.flashcards} onChange={e=>s("flashcards",e.target.value)} placeholder="Flashcard content — key points to memorize..."/></Field>
    <Field label="Tags (comma separated)"><input style={IS} value={f.tags} onChange={e=>s("tags",e.target.value)} placeholder="e.g. threshold, relief, exemption, small business"/></Field>

    {/* Summary PDF upload */}
    <Field label="AI Summary PDF / My Summary">
      {f.summaryFile?(
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"#EFF6FF",border:"1.5px solid #93C5FD",borderRadius:"var(--radius-sm)"}}>
          <span>📄</span>
          <span style={{fontSize:13,fontWeight:600,color:"#1D4ED8",flex:1,wordBreak:"break-word"}}>{f.summaryFile.name}</span>
          <a href={fileViewUrl(f.summaryFile.name)} target="_blank" rel="noreferrer" style={{fontSize:12,color:"#1D4ED8",textDecoration:"none"}}>View</a>
          <button onClick={()=>s("summaryFile",null)} style={{fontSize:12,color:"#7F1D1D",background:"none",border:"none",cursor:"pointer"}}>✕</button>
        </div>
      ):(
        <div onClick={()=>document.getElementById("summaryFileInput").click()}
          style={{border:"2px dashed #93C5FD",borderRadius:"var(--radius-sm)",padding:"0.75rem",textAlign:"center",cursor:"pointer",background:"#F8FAFF"}}>
          <p style={{fontSize:12,color:"#3B82F6",fontWeight:500}}>📎 Upload AI summary or your own summary PDF</p>
          <input id="summaryFileInput" type="file" accept=".pdf,.png,.jpg" style={{display:"none"}} onChange={async e=>{
            const file=e.target.files[0];if(!file)return;
            const res=await apiUpload([file]);
            if(res.ok)s("summaryFile",{name:res.files[0].name,size:res.files[0].size});
            e.target.value="";
          }}/>
        </div>
      )}
    </Field>

    {/* Exam material PDF upload */}
    <Field label="Exam Material PDF">
      {f.examFile?(
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"#FDF4FF",border:"1.5px solid #D8B4FE",borderRadius:"var(--radius-sm)"}}>
          <span>📄</span>
          <span style={{fontSize:13,fontWeight:600,color:"#7C3AED",flex:1,wordBreak:"break-word"}}>{f.examFile.name}</span>
          <a href={fileViewUrl(f.examFile.name)} target="_blank" rel="noreferrer" style={{fontSize:12,color:"#7C3AED",textDecoration:"none"}}>View</a>
          <button onClick={()=>s("examFile",null)} style={{fontSize:12,color:"#7F1D1D",background:"none",border:"none",cursor:"pointer"}}>✕</button>
        </div>
      ):(
        <div onClick={()=>document.getElementById("examFileInput").click()}
          style={{border:"2px dashed #D8B4FE",borderRadius:"var(--radius-sm)",padding:"0.75rem",textAlign:"center",cursor:"pointer",background:"#FDF8FF"}}>
          <p style={{fontSize:12,color:"#7C3AED",fontWeight:500}}>📎 Upload your exam material PDF</p>
          <input id="examFileInput" type="file" accept=".pdf,.png,.jpg" style={{display:"none"}} onChange={async e=>{
            const file=e.target.files[0];if(!file)return;
            const res=await apiUpload([file]);
            if(res.ok)s("examFile",{name:res.files[0].name,size:res.files[0].size});
            e.target.value="";
          }}/>
        </div>
      )}
    </Field>

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
        </div>
      </div>
    )}

    <DBlock l="Summary / Content" v={item.summary}/>
    <DBlock l="Full Text"         v={item.fullText}/>
    {item.flashcards&&<DBlock l="Flashcards 🃏" v={item.flashcards}/>}
    <DBlock l="HM Personal Notes" v={item.notes} accent/>
    {item.tags&&<p style={{fontSize:12,color:"var(--text2)",marginTop:12}}>🏷 {item.tags}</p>}

    {/* File attachments summary */}
    {(item.summaryFile||item.examFile)&&(
      <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
        {item.summaryFile&&<a href={fileViewUrl(item.summaryFile.name)} target="_blank" rel="noreferrer" style={{background:"#EFF6FF",color:"#1D4ED8",fontSize:12,fontWeight:600,padding:"5px 12px",borderRadius:20,textDecoration:"none"}}>📄 Open Summary PDF</a>}
        {item.examFile&&<a href={fileViewUrl(item.examFile.name)} target="_blank" rel="noreferrer" style={{background:"#FDF4FF",color:"#7C3AED",fontSize:12,fontWeight:600,padding:"5px 12px",borderRadius:20,textDecoration:"none"}}>📄 Open Exam Material</a>}
      </div>
    )}
    <div style={{display:"flex",gap:10,marginTop:20,paddingTop:16,borderTop:"1.5px solid var(--border)"}}>
      <Btn onClick={onEdit} variant="default">Edit</Btn>
      <Btn onClick={onDelete} variant="danger">Delete</Btn>
    </div>
  </Modal>);
}

/* ─── Table Row ──────────────────────────────────────────────────────────── */
function TableRow({item,onClick}){
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
        {item.flashcards
          ?<span title={item.flashcards} style={{background:"#FEF3C7",color:"#92400E",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20}}>✓ Cards</span>
          :<span style={{color:"var(--text3)",fontSize:12}}>—</span>}
      </td>
      <td style={{padding:"10px 12px",textAlign:"center"}}>
        {item.summaryFile
          ?<a href={fileViewUrl(item.summaryFile.name)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{background:"#EFF6FF",color:"#1D4ED8",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20,textDecoration:"none"}}>📄 PDF</a>
          :item.aiSummary
          ?<span style={{background:"#ECFDF5",color:"#065F46",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20}}>◈ AI</span>
          :<span style={{color:"var(--text3)",fontSize:12}}>—</span>}
      </td>
      <td style={{padding:"10px 12px",textAlign:"center"}}>
        {item.examFile
          ?<a href={fileViewUrl(item.examFile.name)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{background:"#FDF4FF",color:"#7C3AED",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20,textDecoration:"none"}}>📄 PDF</a>
          :item.attachedFile
          ?<a href={fileViewUrl(item.attachedFile.name)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{background:"#F0FDF4",color:"#15803D",fontSize:11,fontWeight:700,padding:"3px 9px",borderRadius:20,textDecoration:"none"}}>📄 Law</a>
          :<span style={{color:"var(--text3)",fontSize:12}}>—</span>}
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
/* ─── Category Page ──────────────────────────────────────────────────────── */
function CatPage({cat,entries,onAdd,onItem,activeType,onChangeType}){
  const [q,setQ]=useState("");
  const tabs=docTypesForCat(cat.id);
  const dt=tabs.find(d=>d.id===activeType)||tabs[0];
  const catEntries=entries.filter(e=>e.catId===cat.id);
  const typeEntries=catEntries.filter(e=>e.docTypeId===dt.id);
  const filtered=q.trim()?typeEntries.filter(e=>[e.title,e.reference,e.summary,e.fullText,e.notes,e.tags,e.publicationRef,e.decisionNo,e.articleNo].some(f=>f?.toLowerCase().includes(q.toLowerCase()))):typeEntries;
  const counts=Object.fromEntries(tabs.map(d=>[d.id,catEntries.filter(e=>e.docTypeId===d.id).length]));

  return(<div>
    {/* Banner */}
    <div style={{background:`linear-gradient(135deg,${cat.color}18,${cat.color}08)`,border:`1px solid ${cat.color}25`,borderRadius:"var(--radius)",padding:"1.25rem 1.5rem",marginBottom:20}}>
      <h1 style={{fontSize:28,fontWeight:800,color:cat.color,marginBottom:4}}>{cat.label}</h1>
      <p style={{fontSize:13,color:"var(--text2)"}}>Browse laws, clarifications, guides, notes and documents · {catEntries.length} total entries</p>
    </div>
    {/* Tabs */}
    <div style={{background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",padding:"6px",display:"flex",gap:4,marginBottom:20,flexWrap:"wrap",boxShadow:"var(--shadow)"}}>
      {tabs.map(d=>(
        <button key={d.id} onClick={()=>onChangeType(d.id)} style={{
          padding:"7px 14px",borderRadius:"var(--radius-sm)",fontSize:13,
          fontWeight:activeType===d.id?700:400,
          background:activeType===d.id?"var(--nav)":"transparent",
          color:activeType===d.id?"#fff":"var(--text2)",
          border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:5,
          transition:"all 0.15s",whiteSpace:"nowrap"
        }}>
          <span>{d.icon}</span>{d.label}
          {counts[d.id]>0&&<span style={{fontSize:10,background:activeType===d.id?"rgba(255,255,255,0.2)":"var(--surface2)",color:activeType===d.id?"#fff":"var(--text2)",padding:"1px 7px",borderRadius:20,fontWeight:600}}>{counts[d.id]}</span>}
        </button>
      ))}
    </div>
    {/* Search + Add */}
    <div style={{display:"flex",gap:10,marginBottom:16}}>
      <div style={{flex:1,position:"relative"}}>
        <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:"var(--text3)",fontSize:15,pointerEvents:"none"}}>⌕</span>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder={`Search ${dt.label.toLowerCase()}...`} style={{...IS,paddingLeft:36}}/>
      </div>
      <Btn onClick={onAdd} variant="primary" style={{whiteSpace:"nowrap"}}>+ Add {dt.label}</Btn>
    </div>
    {/* Table */}
    {filtered.length===0?(
      <div style={{textAlign:"center",padding:"3rem",background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",color:"var(--text2)"}}>
        {typeEntries.length===0
          ?<><p style={{fontSize:32,marginBottom:12}}>{dt.icon}</p><p style={{fontWeight:600,marginBottom:6}}>No {dt.label} yet for {cat.label}</p><p style={{fontSize:12,color:"var(--text3)"}}>Click "+ Add {dt.label}" to get started</p></>
          :<p>No results match "{q}"</p>}
      </div>
    ):(
      <div style={{background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",overflow:"auto",boxShadow:"var(--shadow)"}}>
        <table style={{width:"100%",borderCollapse:"collapse",minWidth:900}}>
          <thead>
            <tr style={{background:"var(--surface2)",borderBottom:"2px solid var(--border)"}}>
              {["Year","Month","Reference","Name","Notes","Flashcards","Summary","Exam Material"].map(h=>(
                <th key={h} style={{padding:"10px 12px",textAlign:h==="Flashcards"||h==="Summary"||h==="Exam Material"?"center":"left",fontSize:12,fontWeight:700,color:"var(--text2)",whiteSpace:"nowrap",letterSpacing:"0.04em",textTransform:"uppercase"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map(it=><TableRow key={it.id} item={it} onClick={()=>onItem(it)}/>)}
          </tbody>
        </table>
        <div style={{padding:"8px 12px",borderTop:"1px solid var(--border)",fontSize:12,color:"var(--text3)"}}>{filtered.length} {dt.label.toLowerCase()}</div>
      </div>
    )}
  </div>);
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
function AIChat({entries,files}){
  const [msgs,setMsgs]=useState([{role:"assistant",content:"Hello Hassan! I have full access to your knowledge base. Ask me to quiz you, summarize anything, compare entries, or help with exam prep. You can also attach a file to chat."}]);
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  const [attach,setAttach]=useState(null);
  const bottomRef=useRef();
  const fileRef=useRef();

  const kbCtx=TAX_CATS.map(cat=>{
    const ces=entries.filter(e=>e.catId===cat.id);
    return`${cat.label}(${ces.length}): `+ces.map(e=>`[${DOC_TYPES.find(d=>d.id===e.docTypeId)?.label}] ${e.title}${e.reference?`—${e.reference}`:""}${e.summary?`—${e.summary.slice(0,60)}`:""}`).join("|");
  }).join("\n")+`\nFiles(${files.length}):${files.map(f=>f.name).join(",")}`;

  const sys=`You are a UAE tax expert AI in Hassan's Knowledge Base (Hassan Tax World). Reference KB entries when relevant. Help with CT, VAT, TP, Free Zone at exam level.\n\n${kbCtx}`;

  async function send(){
    const text=input.trim();if(!text&&!attach)return;setInput("");
    let raw;
    if(attach){
      try{
        const b64=await apiBase64(attach.name);
        if(b64&&attach.name.endsWith(".pdf"))
          raw=[{type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},{type:"text",text:text||"Analyze this file."}];
        else raw=text||`Analyze file: ${attach.name}`;
      }catch{ raw=text||`Analyze file: ${attach.name}`; }
    } else raw=text;
    const display=attach?`📎 ${attach.name}${text?"\n"+text:""}`:text;
    const apiMsgs=[...msgs.filter(m=>m._raw||m.role==="assistant").map(m=>({role:m.role,content:m._raw||m.content})),{role:"user",content:raw}];
    setMsgs(p=>[...p,{role:"user",content:display,_raw:raw}]);
    setAttach(null);setLoading(true);
    try{const r=await callClaude(apiMsgs,sys);setMsgs(p=>[...p,{role:"assistant",content:r}]);}
    catch(e){setMsgs(p=>[...p,{role:"assistant",content:"Error: "+e.message}]);}
    setLoading(false);
    setTimeout(()=>bottomRef.current?.scrollIntoView({behavior:"smooth"}),100);
  }

  return(<div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 130px)"}}>
    <div style={{flex:1,overflow:"auto",paddingBottom:16}}>
      {msgs.map((m,i)=>(
        <div key={i} style={{marginBottom:14,display:"flex",flexDirection:"column",alignItems:m.role==="user"?"flex-end":"flex-start"}}>
          {m.role==="assistant"&&<div style={{width:26,height:26,background:"var(--accent)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,marginBottom:5,color:"#fff",fontWeight:700}}>◈</div>}
          <div style={{maxWidth:"82%",padding:"11px 15px",borderRadius:m.role==="user"?"14px 14px 3px 14px":"14px 14px 14px 3px",fontSize:13,lineHeight:1.8,background:m.role==="user"?"var(--nav)":"#fff",color:m.role==="user"?"#fff":"var(--text)",border:m.role==="user"?"none":"1.5px solid var(--border)",boxShadow:"var(--shadow)",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{m.content}</div>
        </div>
      ))}
      {loading&&<div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <div style={{width:26,height:26,background:"var(--accent)",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,fontSize:12}}>◈</div>
        <div style={{padding:"11px 15px",background:"#fff",border:"1.5px solid var(--border)",borderRadius:"14px 14px 14px 3px"}}><Dots/></div>
      </div>}
      <div ref={bottomRef}/>
    </div>
    {msgs.length===1&&<div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
      {["Quiz me on Corporate Tax","Summarize VAT Ministerial Decisions","Explain QFZP de minimis","What are my HM exam notes?"].map(c=><button key={c} onClick={()=>setInput(c)} style={{padding:"5px 12px",fontSize:12,borderRadius:20,background:"#fff",border:"1.5px solid var(--border2)",color:"var(--text)",cursor:"pointer"}}>{c}</button>)}
    </div>}
    {attach&&<div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:"#FFF8EC",borderRadius:"var(--radius-sm)",marginBottom:8,border:"1.5px solid #FCD34D"}}>
      <span style={{fontSize:13,color:"#854F0B",fontWeight:600}}>📎 {attach.name}</span>
      <button onClick={()=>setAttach(null)} style={{marginLeft:"auto",fontSize:18,color:"var(--text2)",cursor:"pointer"}}>×</button>
    </div>}
    <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
      <button onClick={async()=>{
        const fs=await apiListFiles();
        if(fs.length===0){alert("No files on server yet. Upload from File Library first.");return;}
        const name=prompt("File name to attach:\n"+fs.map(f=>f.name).join("\n"));
        if(name){const found=fs.find(f=>f.name===name);if(found)setAttach(found);else alert("File not found");}
      }} style={{padding:"10px 12px",background:"#fff",border:"1.5px solid var(--border2)",borderRadius:"var(--radius-sm)",fontSize:16,color:"var(--text2)",cursor:"pointer",flexShrink:0}} title="Attach a file from library">📎</button>
      <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}} placeholder="Ask anything... (Enter to send)" style={{...TA,flex:1,minHeight:44,maxHeight:120}} rows={1}/>
      <button onClick={send} disabled={loading||(!input.trim()&&!attach)} style={{padding:"10px 18px",background:"var(--accent)",border:"none",color:"#fff",borderRadius:"var(--radius-sm)",fontWeight:700,cursor:"pointer",opacity:loading?0.6:1,flexShrink:0}}>Send</button>
    </div>
  </div>);
}

/* ─── File Library ───────────────────────────────────────────────────────── */
function FileLib({files,setFiles,onAI}){
  const inputRef=useRef();
  const [uploading,setUploading]=useState(false);
  const [status,setStatus]=useState("");
  const [progress,setProgress]=useState(0);
  const [serverOk,setServerOk]=useState(null);
  const [viewFile,setViewFile]=useState(null);
  const typeIcon=t=>(t==="application/pdf"||t?.endsWith("pdf"))?"📄":t?.startsWith("image/")?"🖼":"📎";

  // Check if server is running
  useEffect(()=>{
    apiListFiles().then(f=>setServerOk(Array.isArray(f))).catch(()=>setServerOk(false));
  },[]);

  async function handleFiles(fileList){
    if(!serverOk){alert("File server is not running! See instructions below.");return;}
    setUploading(true);setStatus("Uploading to your PC...");setProgress(10);
    try{
      // Upload to local server
      const res=await apiUpload(fileList);
      setProgress(40);
      if(!res.ok){throw new Error("Upload failed: "+(res.error||"unknown"));}

      // For each uploaded file, extract text client-side if PDF
      const newMeta=[];
      for(let i=0;i<res.files.length;i++){
        const sf=res.files[i];
        setStatus(`Extracting text from ${sf.name}... (${i+1}/${res.files.length})`);
        setProgress(40+Math.round((i/res.files.length)*50));
        let extractedText="",pages=0;
        if(sf.name.toLowerCase().endsWith(".pdf")){
          try{
            const b64=await apiBase64(sf.name);
            if(b64){const r=await extractPdfTextFromBase64(b64);extractedText=r.text;pages=r.pages;}
          }catch(e){console.warn("Text extraction failed:",e);}
        }
        const orig=Array.from(fileList).find(f=>f.name===sf.original||f.name===sf.name);
        newMeta.push({id:genId(),name:sf.name,originalName:sf.original,fileType:orig?.type||"application/octet-stream",size:sf.size,catId:"gen",notes:"",pages,extractedText,createdAt:new Date().toISOString()});
      }
      const next=[...newMeta,...files];
      setFiles(next);
      await lsSet(FILES_KEY,next.map(m=>({...m})));
      setProgress(100);
      setStatus(`✓ ${res.files.length} file(s) saved to your PC`);
      setTimeout(()=>{setUploading(false);setStatus("");setProgress(0);},2000);
    }catch(e){
      setStatus("Error: "+e.message);
      setTimeout(()=>{setUploading(false);setStatus("");setProgress(0);},3000);
    }
  }

  async function del(file){
    if(!confirm(`Delete "${file.name}"?`))return;
    try{await apiDelete(file.name);}catch{}
    const next=files.filter(f=>f.id!==file.id);
    setFiles(next);
    await lsSet(FILES_KEY,next);
  }

  async function saveEdit(u){
    const next=files.map(f=>f.id===u.id?{...f,...u}:f);
    setFiles(next);await lsSet(FILES_KEY,next);
  }

  const cat4=id=>TAX_CATS.find(c=>c.id===id)||TAX_CATS[TAX_CATS.length-1];

  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
      <div><h1 style={{fontSize:22,fontWeight:700,marginBottom:4}}>📁 File Library</h1><p style={{fontSize:13,color:"var(--text2)"}}>{files.length} files stored on your PC · fully searchable</p></div>
      <div style={{display:"flex",gap:8}}>
        <button onClick={apiOpenFolder} style={{padding:"8px 14px",background:"#fff",border:"1.5px solid var(--border2)",borderRadius:"var(--radius-sm)",fontSize:13,cursor:"pointer",color:"var(--text)"}}>📂 Open Folder</button>
        <Btn onClick={()=>inputRef.current?.click()} variant="primary">{uploading?"Uploading...":"+ Upload Files"}</Btn>
      </div>
    </div>
    <input type="file" ref={inputRef} multiple onChange={e=>{handleFiles(e.target.files);e.target.value="";}} accept=".pdf,application/pdf,.png,.jpg,.jpeg,.txt,image/*" style={{display:"none"}}/>

    {/* Server status */}
    {serverOk===false&&(
      <div style={{background:"#FEE2E2",border:"1.5px solid #FECACA",borderRadius:"var(--radius)",padding:"1rem 1.25rem",marginBottom:16}}>
        <p style={{fontWeight:700,color:"#7F1D1D",marginBottom:8}}>⚠️ File server not running</p>
        <p style={{fontSize:13,color:"#991B1B",lineHeight:1.7}}>The file server needs to be running. Open a <strong>second terminal</strong>, go to your project folder, and run:<br/><code style={{background:"#FEF2F2",padding:"2px 8px",borderRadius:4,fontFamily:"monospace"}}>node server.js</code><br/>Keep both terminals open while using the app.</p>
      </div>
    )}
    {serverOk===true&&(
      <div style={{background:"#ECFDF5",border:"1.5px solid #6EE7B7",borderRadius:"var(--radius-sm)",padding:"10px 14px",marginBottom:16,display:"flex",gap:8,alignItems:"center"}}>
        <span style={{color:"#059669",fontWeight:700}}>✓</span>
        <p style={{fontSize:12,color:"#065F46"}}>File server is running · Files are stored in the <strong>tax-files/</strong> folder in your project</p>
      </div>
    )}

    {/* Drop zone */}
    <div
      onDrop={e=>{e.preventDefault();if(!uploading)handleFiles(e.dataTransfer.files);}}
      onDragOver={e=>e.preventDefault()}
      onClick={()=>!uploading&&inputRef.current?.click()}
      style={{border:"2px dashed var(--border2)",borderRadius:"var(--radius)",padding:"2.5rem",textAlign:"center",marginBottom:20,cursor:uploading?"default":"pointer",background:"#fff"}}
      onMouseEnter={e=>{if(!uploading)e.currentTarget.style.background="var(--surface2)";}}
      onMouseLeave={e=>e.currentTarget.style.background="#fff"}>
      {uploading?(
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:14}}>
          <Spinner size={30}/>
          <p style={{fontSize:14,color:"var(--text2)",fontWeight:600}}>{status}</p>
          <div style={{width:"100%",maxWidth:320,background:"var(--surface2)",borderRadius:20,height:8,overflow:"hidden"}}>
            <div style={{width:`${progress}%`,height:"100%",background:"var(--accent)",borderRadius:20,transition:"width 0.4s"}}/>
          </div>
        </div>
      ):(
        <>
          <p style={{fontSize:32,marginBottom:10}}>📂</p>
          <p style={{fontSize:15,fontWeight:700,color:"var(--text)",marginBottom:6}}>Drop PDF files here</p>
          <p style={{fontSize:13,color:"var(--text2)"}}>Files are saved to your PC · Text extracted for search · Any size</p>
        </>
      )}
    </div>

    {files.length===0&&!uploading&&(
      <div style={{textAlign:"center",padding:"3rem",background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",color:"var(--text2)"}}>
        <p style={{fontSize:32,marginBottom:12}}>📄</p>
        <p style={{fontWeight:600,marginBottom:6}}>No files yet</p>
        <p style={{fontSize:12,color:"var(--text3)"}}>Upload your FTA laws, guidelines, and clarifications</p>
      </div>
    )}

    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
      {files.map(f=>{
        const cat=cat4(f.catId);
        return(<div key={f.id} style={{background:"#fff",border:"1.5px solid var(--border)",borderRadius:"var(--radius)",padding:"1rem",display:"flex",flexDirection:"column",gap:10,boxShadow:"var(--shadow)"}}>
          <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
            <span style={{fontSize:28,flexShrink:0}}>{typeIcon(f.fileType)}</span>
            <div style={{flex:1,minWidth:0}}>
              <p style={{fontWeight:700,fontSize:13,lineHeight:1.4,color:"var(--text)",wordBreak:"break-word"}}>{f.name}</p>
              <p style={{fontSize:11,color:"var(--text2)",marginTop:2}}>{fmtSize(f.size)} · {fmt(f.createdAt)}{f.pages>0&&<span style={{marginLeft:6,background:"#DBEAFE",color:"#1E3A8A",padding:"1px 6px",borderRadius:10,fontSize:10,fontWeight:700}}>{f.pages}p</span>}</p>
            </div>
          </div>
          <span style={{background:cat.color+"18",color:cat.color,fontSize:11,fontWeight:700,padding:"2px 9px",borderRadius:20,alignSelf:"flex-start"}}>{cat.label}</span>
          {f.extractedText?<p style={{fontSize:11,color:"#059669",fontWeight:700}}>✓ Text extracted · searchable</p>:<p style={{fontSize:11,color:"var(--text3)"}}>No text extracted</p>}
          {f.notes&&<p style={{fontSize:12,color:"var(--text2)"}}>{f.notes}</p>}
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:"auto"}}>
            <a href={fileViewUrl(f.name)} target="_blank" rel="noreferrer" style={{padding:"5px 11px",fontSize:12,background:"var(--surface2)",border:"1px solid var(--border2)",borderRadius:"var(--radius-sm)",cursor:"pointer",color:"var(--text)",textDecoration:"none"}}>👁 View</a>
            <button onClick={()=>onAI(null,f)} style={{padding:"5px 11px",fontSize:12,background:"#FFF8EC",border:"1px solid #FCD34D",borderRadius:"var(--radius-sm)",color:"#854F0B",fontWeight:700,cursor:"pointer"}}>◈ AI</button>
            <button onClick={()=>setViewFile(f)} style={{padding:"5px 11px",fontSize:12,background:"var(--surface2)",border:"1px solid var(--border2)",borderRadius:"var(--radius-sm)",cursor:"pointer"}}>Edit</button>
            <button onClick={()=>del(f)} style={{padding:"5px 11px",fontSize:12,background:"#FEE2E2",border:"1px solid #FECACA",borderRadius:"var(--radius-sm)",color:"#7F1D1D",marginLeft:"auto",cursor:"pointer"}}>✕</button>
          </div>
        </div>);
      })}
    </div>

    {viewFile&&<Modal title="Edit File Details" onClose={()=>setViewFile(null)}>
      <Field label="Tax Category">
        <select style={SEL} value={viewFile.catId||"gen"} onChange={e=>setViewFile(p=>({...p,catId:e.target.value}))}>
          {TAX_CATS.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </Field>
      <Field label="Notes"><textarea style={TA} value={viewFile.notes||""} onChange={e=>setViewFile(p=>({...p,notes:e.target.value}))} placeholder="Notes about this file..."/></Field>
      <div style={{display:"flex",gap:10}}><Btn onClick={()=>{saveEdit(viewFile);setViewFile(null);}} variant="primary">Save</Btn><Btn onClick={()=>setViewFile(null)} variant="default">Cancel</Btn></div>
    </Modal>}
  </div>);
}

/* ─── Search ─────────────────────────────────────────────────────────────── */
function SearchPage({entries,files,onItem,onFileAI}){
  const [q,setQ]=useState("");
  const results=useCallback(()=>{
    if(!q.trim())return[];
    const lq=q.toLowerCase();
    const eHits=entries.filter(e=>[e.title,e.reference,e.summary,e.fullText,e.notes,e.tags,e.publicationRef,e.decisionNo,e.articleNo].some(f=>f?.toLowerCase().includes(lq))).map(e=>({...e,_type:"entry"}));
    const fHits=files.map(f=>{
      if(f.name.toLowerCase().includes(lq)||f.notes?.toLowerCase().includes(lq))return{...f,_type:"file"};
      if(f.extractedText?.toLowerCase().includes(lq))return{...f,_type:"file",_matchIn:"text"};
      return null;
    }).filter(Boolean);
    return[...eHits,...fHits];
  },[q,entries,files]);
  const res=results();
  return(<div>
    <h1 style={{fontSize:22,fontWeight:700,marginBottom:16}}>Search</h1>
    <div style={{position:"relative",marginBottom:6}}>
      <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:"var(--text3)",fontSize:15}}>⌕</span>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search across all sections and inside PDFs..." style={{...IS,paddingLeft:36,fontSize:15,padding:"12px 14px 12px 36px"}} autoFocus/>
    </div>
    <p style={{fontSize:12,color:"var(--text3)",marginBottom:20}}>Searches all tax categories, document types, and extracted PDF text</p>
    {!q.trim()&&<div style={{textAlign:"center",padding:"4rem",background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",color:"var(--text2)"}}>Start typing to search</div>}
    {q.trim()&&res.length===0&&<div style={{textAlign:"center",padding:"4rem",background:"#fff",borderRadius:"var(--radius)",border:"1.5px solid var(--border)",color:"var(--text2)"}}>No results for "{q}"</div>}
    {res.length>0&&<>
      <p style={{fontSize:12,color:"var(--text2)",marginBottom:14,fontWeight:500}}>{res.length} result{res.length!==1?"s":""}</p>
      <div style={{display:"grid",gap:10}}>
        {res.map(r=>{
          const cat=TAX_CATS.find(c=>c.id===r.catId);
          if(r._type==="file") return(
            <div key={r.id} onClick={()=>onFileAI(null,r)} onMouseEnter={e=>e.currentTarget.style.borderColor="#94A3B8"} onMouseLeave={e=>e.currentTarget.style.borderColor="var(--border)"} style={{background:"#fff",border:"1.5px solid var(--border)",borderRadius:"var(--radius)",padding:"1rem 1.25rem",cursor:"pointer",boxShadow:"var(--shadow)"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <p style={{fontWeight:600,fontSize:14}}>📄 {r.name}</p>
                <span style={{fontSize:10,background:"var(--surface2)",color:"var(--text2)",padding:"2px 8px",borderRadius:20,border:"1px solid var(--border)"}}>file{r._matchIn?" · inside PDF":""}</span>
              </div>
              {cat&&<span style={{background:cat.color+"18",color:cat.color,fontSize:11,fontWeight:700,padding:"2px 9px",borderRadius:20}}>{cat.label}</span>}
              {r._matchIn&&<p style={{fontSize:12,color:"#065F46",background:"#ECFDF5",padding:"4px 10px",borderRadius:4,lineHeight:1.6,fontStyle:"italic",marginTop:8}}>...{hilite(r.extractedText,q)}...</p>}
            </div>
          );
          const dt=DOC_TYPES.find(d=>d.id===r.docTypeId);
          return(
            <div key={r.id} onClick={()=>onItem(r)} onMouseEnter={e=>e.currentTarget.style.borderColor="#94A3B8"} onMouseLeave={e=>e.currentTarget.style.borderColor="var(--border)"} style={{background:"#fff",border:"1.5px solid var(--border)",borderRadius:"var(--radius)",padding:"1rem 1.25rem",cursor:"pointer",boxShadow:"var(--shadow)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:8}}>
                <p style={{fontWeight:600,fontSize:14}}>{dt?.icon} {r.title}</p>
                {r.status&&<SBadge s={r.status}/>}
              </div>
              <div style={{display:"flex",gap:6,marginBottom:r.summary?8:0,flexWrap:"wrap"}}>
                {cat&&<span style={{background:cat.color+"18",color:cat.color,fontSize:11,fontWeight:700,padding:"2px 9px",borderRadius:20}}>{cat.label}</span>}
                {dt&&<span style={{background:"var(--surface2)",color:"var(--text2)",fontSize:11,padding:"2px 9px",borderRadius:20}}>{dt.label}</span>}
              </div>
              {r.summary&&<p style={{fontSize:12,color:"var(--text2)",lineHeight:1.55,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{r.summary}</p>}
            </div>
          );
        })}
      </div>
    </>}
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
export default function App(){
  const [entries,setEntries]=useState([]);
  const [files,setFiles]=useState([]);
  const [loaded,setLoaded]=useState(false);
  const [nav,setNav]=useState({view:"dashboard"});
  const [expanded,setExpanded]=useState({});
  const [modal,setModal]=useState(null);
  const [detail,setDetail]=useState(null);
  const [aiTarget,setAiTarget]=useState(null);

  useEffect(()=>{
    (async()=>{
      const [e,f]=await Promise.all([lsGet(STORE_KEY),lsGet(FILES_KEY)]);
      if(e)setEntries(e);
      if(f)setFiles(f);
      // Also sync file list from server
      try{
        const serverFiles=await apiListFiles();
        if(f&&serverFiles.length>0){
          // Add any server files not yet in metadata
          const existingNames=new Set((f||[]).map(x=>x.name));
          const missing=serverFiles.filter(sf=>!existingNames.has(sf.name));
          if(missing.length>0){
            const newMeta=missing.map(sf=>({id:genId(),name:sf.name,fileType:"application/pdf",size:sf.size,catId:"gen",notes:"",pages:0,extractedText:"",createdAt:new Date(sf.modified).toISOString()}));
            const next=[...(f||[]),...newMeta];
            setFiles(next);await lsSet(FILES_KEY,next);
          }
        }
      }catch{}
      setLoaded(true);
    })();
  },[]);

  const saveEntry=async item=>{
    const nx=modal?.editing?entries.map(x=>x.id===item.id?item:x):[item,...entries];
    setEntries(nx);await lsSet(STORE_KEY,nx);
  };
  const deleteEntry=async id=>{
    const nx=entries.filter(x=>x.id!==id);setEntries(nx);await lsSet(STORE_KEY,nx);setDetail(null);
  };
  const goCat=(catId)=>{
    const tabs=docTypesForCat(catId);
    setNav({view:"cat",catId,docTypeId:tabs[0].id});
    setExpanded(p=>({...p,[catId]:true}));
  };

  if(!loaded)return<div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:"#F0F2F5"}}><Spinner size={36}/></div>;
  const navCat=nav.catId?TAX_CATS.find(c=>c.id===nav.catId):null;

  return(<div style={{display:"flex",minHeight:"100vh"}}>
    <style>{G}</style>

    {/* ── Sidebar ───────────────────────────────────────────────────── */}
    <div style={{width:240,background:"var(--nav)",display:"flex",flexDirection:"column",flexShrink:0,position:"sticky",top:0,height:"100vh",overflow:"auto"}}>
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
        {[{id:"files",label:"File Library",icon:"📁"},{id:"ai",label:"AI Assistant",icon:"◈"}].map(n=>(
          <button key={n.id} onClick={()=>setNav({view:n.id})} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"8px 12px",marginBottom:2,borderRadius:7,background:nav.view===n.id?"var(--nav-active)":"transparent",border:"none",cursor:"pointer",textAlign:"left",color:nav.view===n.id?"var(--accent)":"rgba(255,255,255,0.55)",fontWeight:nav.view===n.id?600:400,fontSize:13}}>
            <span style={{fontSize:14,width:18,textAlign:"center"}}>{n.icon}</span>{n.label}
          </button>
        ))}
      </div>
    </div>

    {/* ── Main content ─────────────────────────────────────────────── */}
    <main style={{flex:1,background:"var(--bg)",padding:"2rem",overflow:"auto",minWidth:0}}>
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
        <CatPage cat={navCat} entries={entries} activeType={nav.docTypeId||docTypesForCat(navCat.id)[0].id}
          onChangeType={dt=>setNav(p=>({...p,docTypeId:dt}))}
          onAdd={()=>setModal({catId:nav.catId,docTypeId:nav.docTypeId,editing:null})}
          onItem={it=>setDetail(it)}/>
      )}
      {nav.view==="files"&&<FileLib files={files} setFiles={setFiles} onAI={(item,file)=>setAiTarget({item,file})}/>}
      {nav.view==="ai"&&<div><h1 style={{fontSize:22,fontWeight:700,marginBottom:4}}>◈ AI Assistant</h1><p style={{fontSize:13,color:"var(--text2)",marginBottom:20}}>Quiz · Summarize · Analyze files · Exam prep</p><AIChat entries={entries} files={files}/></div>}
      {nav.view==="search"&&<SearchPage entries={entries} files={files} onItem={it=>setDetail(it)} onFileAI={(i,f)=>setAiTarget({item:i,file:f})}/>}
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

