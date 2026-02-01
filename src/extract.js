import { createWorker } from "tesseract.js";
import express from "express";
import multer from "multer";
import cors from "cors";
import sharp from "sharp";
import { performance } from "perf_hooks";

const app = express();
const upload = multer();

app.use(cors());

let imgBufferArray = [];
let zoneXBounds, quesSeqStyle;

function resetSession() {
  imgBufferArray = [];
  zoneXBounds = null;
  quesSeqStyle = null;

  console.log("🧹 Session reset");
}

// 🔥 SINGLE OCR WORKER
let worker;
(async () => {
  worker = await createWorker("eng");
  console.log("🤖 OCR Worker ready");
})();

// -------------------- IMAGE UPLOAD --------------------
app.post("/upload-image", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).send("No image");

  imgBufferArray.push(req.file.buffer);

  console.log("✅ Image received", imgBufferArray.length);
  res.send(`Image received. Total images: ${imgBufferArray.length}`);
});

// -------------------- SET ZONE --------------------
app.post("/confirm-zone", express.json(), async (req, res) => {
  ({ zoneXBounds, quesSeqStyle } = req.body.payload);

  res.send({ status: "ok, zone confirmed" });
});

// -------------------- STREAM QUESTIONS --------------------
app.get("/stream-questions", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write("event: connected\ndata: ok\n\n");

  if (!zoneXBounds) {
    res.write("event: error\ndata: Zone not set\n\n");
    res.end();
    return;
  }

  const ZONE_X = {
    x1: zoneXBounds.x1,
    x2: zoneXBounds.x2,
  };

  for (let i = 0; i < imgBufferArray.length; i++) {
    await getCroppedQuestions(imgBufferArray[i], ZONE_X, i, res);
  }

  res.write("event: done\ndata: all done\n\n");
  res.end();

  req.on("close", () => {
    console.log("❌ Client disconnected");
    resetSession();
  });

  resetSession();
});

// -------------------- SANITIZE & REGEX --------------------
function buildStrictQuestionRegex(questionSeqStyle) {
  const escaped = questionSeqStyle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\d+/g, "\\d+");
  return new RegExp(`^${pattern}$`);
}

function sanitize(text) {
  let s = text.trim().toLowerCase();

  // remove junk symbols
  s = s.replace(/[()[\]{}|]/g, "");

  // ---- CONTEXT-AWARE ZERO FIX ----
  s = s.replace(/0/g, (m, i) => {
    const prev = s[i - 1];
    const next = s[i + 1];
    return /\d/.test(prev) || /\d/.test(next) ? "0" : "q";
  });

  // OCR mistakes: O / ® → q
  s = s.replace(/[o®](?=\d|\.)/g, "q");

  // q.14 → q14
  s = s.replace(/^q\./, "q");

  // keep only q, digits, dot
  s = s.replace(/[^\dq.]/g, "");

  return s;
}

// -------------------- MAIN PIPELINE --------------------
async function getCroppedQuestions(pageBuffer, ZONE_X, PAGE_INDEX, res) {
  const ZONE_IMAGE = await getQuesZoneImg(pageBuffer, ZONE_X.x1, ZONE_X.x2);

  const pageMeta = await sharp(pageBuffer).metadata();
  const PAGE_WIDTH = pageMeta.width;
  const PAGE_HEIGHT = pageMeta.height;

  const zoneMeta = await sharp(ZONE_IMAGE).metadata();
  if (zoneMeta.height < 100) {
    console.log("❌ Zone too narrow");
    return;
  }

  const UPSCALE = 5;

  const processedZone = await sharp(ZONE_IMAGE)
    .greyscale()
    .normalize()
    .linear(4, -150)
    .threshold(100)
    .resize(zoneMeta.width * UPSCALE, zoneMeta.height * UPSCALE)
    .png()
    .toBuffer();

  const { data } = await worker.recognize(processedZone, {}, { tsv: true });
  if (!data.tsv) return;

  const lines = data.tsv.trim().split("\n").slice(1);

  const words = lines
    .map((l) => {
      const c = l.split("\t");
      return {
        level: +c[0],
        text: c[11].trim(),
        top: +c[7],
      };
    })
    .filter((w) => w.level === 5 && w.text !== "");

  const questionSeqStyle = sanitize(quesSeqStyle); // USER FORMAT
  const questionRegex = buildStrictQuestionRegex(questionSeqStyle);

  const qWords = words
    .map((w) => ({ ...w, clean: sanitize(w.text) }))
    .filter((w) => questionRegex.test(w.clean))
    .sort((a, b) => a.top - b.top);

  if (!qWords.length) {
    console.log("❌ No question numbers detected");
    return;
  }

  const starts = qWords.map((w) => Math.round(w.top / UPSCALE));

  for (let i = 0; i < qWords.length; i++) {
    const top = starts[i];
    const nextTop = starts[i + 1] ?? PAGE_HEIGHT;
    const height = nextTop - top;

    if (height <= 0) continue;

    const croppedImgBuffer = await sharp(pageBuffer)
      .extract({
        left: 0,
        top: Math.max(top - 5, 0),
        width: PAGE_WIDTH,
        height,
      })
      .png()
      .toBuffer();

    if (!croppedImgBuffer) continue;

    const base64 = croppedImgBuffer.toString("base64");

    const data = {
      quesNumber: qWords[i].clean,
      imgSRC: base64,
    };

    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// -------------------- CROP SINGLE ZONE --------------------
async function getQuesZoneImg(pageImg, x1, x2) {
  const meta = await sharp(pageImg).metadata();
  const height = meta.height;

  return sharp(pageImg)
    .extract({
      left: Math.round(x1),
      top: 0,
      width: Math.round(x2 - x1),
      height,
    })
    .png()
    .toBuffer();
}

// -------------------- SERVER --------------------
app.listen(3000, () => console.log("🚀 Server running on 3000"));
