const express  = require("express");
const multer   = require("multer");
const cors     = require("cors");
const fs       = require("fs");
const path     = require("path");
const https    = require("https");
const { exec } = require("child_process");

const app       = express();
const PORT      = 3001;
const FILES_DIR = path.join(__dirname, "tax-files");

// ── ADD YOUR API KEY HERE ───────────────────────────────────────────────────
const ANTHROPIC_API_KEY = "YOUR_API_KEY_HERE";
// ───────────────────────────────────────────────────────────────────────────

console.log("Starting Hassan Tax World Server...");
console.log("Files folder:", FILES_DIR);

if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  console.log("Created tax-files folder");
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Test endpoint
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, message: "Server is running!", filesDir: FILES_DIR });
});

// AI proxy
app.post("/api/ai", (req, res) => {
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === "YOUR_API_KEY_HERE") {
    return res.status(400).json({ error: "Add your Anthropic API key to server.cjs" });
  }
  const body = JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2000, ...req.body });
  const options = {
    hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(body)
    }
  };
  const apiReq = https.request(options, (apiRes) => {
    let data = "";
    apiRes.on("data", chunk => data += chunk);
    apiRes.on("end", () => {
      try { res.json(JSON.parse(data)); }
      catch { res.status(500).json({ error: "Bad response from Anthropic" }); }
    });
  });
  apiReq.on("error", e => res.status(500).json({ error: e.message }));
  apiReq.write(body);
  apiReq.end();
});

// File storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    console.log("Saving file:", file.originalname);
    cb(null, FILES_DIR);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dest = path.join(FILES_DIR, safe);
    if (fs.existsSync(dest)) {
      const ext = path.extname(safe), base = path.basename(safe, ext);
      cb(null, `${base}_${Date.now()}${ext}`);
    } else {
      cb(null, safe);
    }
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.get("/api/files", (req, res) => {
  try {
    const files = fs.readdirSync(FILES_DIR).map(name => {
      const stat = fs.statSync(path.join(FILES_DIR, name));
      return { name, size: stat.size, modified: stat.mtime };
    });
    res.json(files);
  } catch (e) {
    console.error("Error listing files:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/upload", upload.array("files", 50), (req, res) => {
  console.log("Upload received:", req.files?.length, "files");
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ ok: false, error: "No files received" });
  }
  const saved = req.files.map(f => ({
    name: f.filename, original: f.originalname, size: f.size
  }));
  console.log("Saved:", saved.map(f => f.name));
  res.json({ ok: true, files: saved });
});

app.get("/api/file/:name", (req, res) => {
  const fp = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.sendFile(fp);
});

app.get("/api/file/:name/base64", (req, res) => {
  const fp = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  try {
    const buf = fs.readFileSync(fp);
    res.json({ base64: buf.toString("base64") });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/file/:name", (req, res) => {
  const fp = path.join(FILES_DIR, req.params.name);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

app.get("/api/open-folder", (req, res) => {
  exec(`explorer "${FILES_DIR}"`);
  res.json({ ok: true, path: FILES_DIR });
});

app.listen(PORT, () => {
  console.log("\n========================================");
  console.log("  Hassan Tax World Server READY");
  console.log("  Port    : " + PORT);
  console.log("  Files   : " + FILES_DIR);
  console.log("  Test URL: http://localhost:3001/api/ping");
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === "YOUR_API_KEY_HERE") {
    console.log("  AI      : NOT SET (add key to server.cjs)");
  } else {
    console.log("  AI      : Key set OK");
  }
  console.log("========================================\n");
});
