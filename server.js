const express = require("express");
const multer  = require("multer");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const app       = express();
const PORT      = 3001;
const FILES_DIR = path.join(__dirname, "tax-files"); // all PDFs stored here

// Create storage folder if it doesn't exist
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Multer — save uploaded files directly to tax-files/
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FILES_DIR),
  filename: (req, file, cb) => {
    // Keep original name, avoid duplicates by adding timestamp if needed
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dest  = path.join(FILES_DIR, safe);
    if (fs.existsSync(dest)) {
      const ext  = path.extname(safe);
      const base = path.basename(safe, ext);
      cb(null, `${base}_${Date.now()}${ext}`);
    } else {
      cb(null, safe);
    }
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500 MB max

// ── LIST files ──────────────────────────────────────────────────────────────
app.get("/api/files", (req, res) => {
  try {
    const files = fs.readdirSync(FILES_DIR).map(name => {
      const fp   = path.join(FILES_DIR, name);
      const stat = fs.statSync(fp);
      return { name, size: stat.size, modified: stat.mtime };
    });
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── UPLOAD files ─────────────────────────────────────────────────────────────
app.post("/api/upload", upload.array("files", 50), (req, res) => {
  const saved = req.files.map(f => ({
    name:     f.filename,
    original: f.originalname,
    size:     f.size,
    path:     f.path,
  }));
  res.json({ ok: true, files: saved });
});

// ── SERVE a file (for viewing in browser) ────────────────────────────────────
app.get("/api/file/:name", (req, res) => {
  const fp = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.sendFile(fp);
});

// ── READ file as base64 (for AI analysis) ────────────────────────────────────
app.get("/api/file/:name/base64", (req, res) => {
  const fp = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  const buf = fs.readFileSync(fp);
  res.json({ base64: buf.toString("base64"), size: buf.length });
});

// ── DELETE a file ─────────────────────────────────────────────────────────────
app.delete("/api/file/:name", (req, res) => {
  const fp = path.join(FILES_DIR, req.params.name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ── OPEN folder in Explorer/Finder ───────────────────────────────────────────
app.get("/api/open-folder", (req, res) => {
  const { exec } = require("child_process");
  const cmd = process.platform === "win32"  ? `explorer "${FILES_DIR}"`
            : process.platform === "darwin" ? `open "${FILES_DIR}"`
            : `xdg-open "${FILES_DIR}"`;
  exec(cmd);
  res.json({ ok: true, path: FILES_DIR });
});

app.listen(PORT, () => {
  console.log(`\n✅ Hassan Tax World — File Server running`);
  console.log(`   Files folder: ${FILES_DIR}`);
  console.log(`   API:          http://localhost:${PORT}/api/files\n`);
});
