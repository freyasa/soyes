import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(cors());
app.use(express.json());

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".");
const OUT_DIR = path.join(ROOT, "generated");
fs.mkdirSync(OUT_DIR, { recursive: true });

function createWaveWriter(filePath, { sampleRate, channels, bitDepth }) {
  const fd = fs.openSync(filePath, "w");
  fs.writeSync(fd, Buffer.alloc(44));
  let dataLength = 0;
  function finalizeHeader() {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    const byteRate = sampleRate * channels * (bitDepth / 8);
    header.writeUInt32LE(byteRate, 28);
    const blockAlign = channels * (bitDepth / 8);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataLength, 40);
    fs.writeSync(fd, header, 0, 44, 0);
  }
  return {
    write(buffer) {
      dataLength += buffer.length;
      fs.writeSync(fd, buffer);
    },
    close() {
      finalizeHeader();
      fs.closeSync(fd);
    },
  };
}

app.use("/files", express.static(OUT_DIR));

app.post("/api/music/generate", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "Missing GEMINI_API_KEY" });
      return;
    }
    const { prompts, duration, bpm, guidance, density, brightness, scale, mode, outputName } = req.body || {};
    if (!Array.isArray(prompts) || prompts.length === 0) {
      res.status(400).json({ error: "prompts is required" });
      return;
    }
    const parsedPrompts = prompts.map((p) => ({ text: String(p.text || "").trim(), weight: Number(p.weight || 1) })).filter((p) => p.text && Number.isFinite(p.weight));
    if (!parsedPrompts.length) {
      res.status(400).json({ error: "invalid prompts" });
      return;
    }
    const durationSec = Math.max(1, Number(duration || 20));
    const sampleRate = 48000;
    const channels = 2;
    const bitDepth = 16;
    const outFile = path.join(OUT_DIR, outputName ? String(outputName) : `audio_${Date.now()}.wav`);
    const writer = createWaveWriter(outFile, { sampleRate, channels, bitDepth });
    const client = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });

    const cfg = {};
    if (bpm !== undefined) cfg.bpm = Number(bpm);
    if (guidance !== undefined) cfg.guidance = Number(guidance);
    if (density !== undefined) cfg.density = Number(density);
    if (brightness !== undefined) cfg.brightness = Number(brightness);
    if (scale !== undefined) cfg.scale = String(scale);
    if (mode !== undefined) cfg.music_generation_mode = String(mode);
    Object.keys(cfg).forEach((k) => {
      const v = cfg[k];
      if (v === undefined || (typeof v === "number" && Number.isNaN(v))) delete cfg[k];
    });

    let finished = false;
    let chunkBudget = Math.max(1, Math.round(durationSec / 2));
    const session = await client.live.music.connect({
      model: "models/lyria-realtime-exp",
      callbacks: {
        onmessage: (message) => {
          const chunks = message?.serverContent?.audioChunks ?? [];
          if (!chunks.length) {
            if (message?.serverContent?.error && !finished) {
              finished = true;
              try { writer.close(); } catch {}
              res.status(502).json({ error: message.serverContent.error });
            }
            return;
          }
          for (const chunk of chunks) {
            const audioBuffer = Buffer.from(chunk.data, "base64");
            writer.write(audioBuffer);
            chunkBudget -= 1;
            if (chunkBudget <= 0 && !finished) {
              finished = true;
              try { session.stop(); } catch {}
              try { writer.close(); } catch {}
              const url = `/files/${path.basename(outFile)}`;
              res.json({ url, sampleRate, channels, bitDepth, durationSec });
              break;
            }
          }
        },
        onerror: (error) => {
          if (finished) return;
          finished = true;
          try { writer.close(); } catch {}
          res.status(502).json({ error: String(error) });
        },
        onclose: (evt) => {
          if (!finished) {
            finished = true;
            try { writer.close(); } catch {}
            res.status(502).json({ error: `closed ${evt?.code ?? "unknown"}` });
          }
        },
      },
    });

    await session.setWeightedPrompts({ weightedPrompts: parsedPrompts });
    if (Object.keys(cfg).length) {
      await session.setMusicGenerationConfig({ musicGenerationConfig: cfg });
    }
    await session.play();
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {});

