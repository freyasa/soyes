// soyes/src/lib/lyria.ts
import { GoogleGenAI } from "@google/genai";

type WeightedPrompt = { text: string; weight: number };
type Config = {
  prompts: WeightedPrompt[];
  duration: number;
  bpm?: number;
  guidance?: number;
  density?: number;
  brightness?: number;
  scale?: string;
  mode?: string;
};

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const MODEL_ID = "models/lyria-realtime-exp";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function createWavBlob(parts: Uint8Array[]): Blob {
  const dataLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, CHANNELS, true);
  v.setUint32(24, SAMPLE_RATE, true);
  const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
  v.setUint32(28, byteRate, true);
  const blockAlign = CHANNELS * (BIT_DEPTH / 8);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, BIT_DEPTH, true);
  writeStr(36, "data");
  v.setUint32(40, dataLength, true);
  return new Blob([header, ...parts], { type: "audio/wav" });
}

export async function generateMusic(cfg: Config): Promise<{ url: string; sampleRate: number; channels: number; bitDepth: number; durationSec: number }> {
  const apiKey = "AIzaSyDJXuePaFSqNBvs4msBcpFcbHJMyRRiwKI";
  if (!apiKey) throw new Error("Missing VITE_GEMINI_API_KEY");
  if (!cfg.prompts?.length) throw new Error("prompts required");
  const durationSec = Math.max(1, Math.round(cfg.duration || 20));
  const chunkBudgetInit = Math.max(1, Math.round(durationSec / 2));
  const client = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });
  const chunks: Uint8Array[] = [];
  let finished = false;
  let chunkBudget = chunkBudgetInit;

  const session = await client.live.music.connect({
    model: MODEL_ID,
    callbacks: {
      onmessage: (message: any) => {
        const audioChunks = message?.serverContent?.audioChunks || [];
        if (!audioChunks.length) {
          if (message?.serverContent?.error && !finished) {
            finished = true;
            throw new Error(JSON.stringify(message.serverContent.error));
          }
          return;
        }
        for (const c of audioChunks) {
          const part = b64ToBytes(c.data);
          chunks.push(part);
          if (--chunkBudget <= 0 && !finished) {
            finished = true;
            try { session.stop(); } catch {}
          }
        }
      },
      onerror: (err: any) => {
        if (!finished) {
          finished = true;
          throw err instanceof Error ? err : new Error(String(err));
        }
      },
      onclose: (_evt: any) => {
        // allow close after we exhausted chunk budget
      },
    },
  });

  const musicCfg: any = {};
  if (cfg.bpm !== undefined) musicCfg.bpm = Number(cfg.bpm);
  if (cfg.guidance !== undefined) musicCfg.guidance = Number(cfg.guidance);
  if (cfg.density !== undefined) musicCfg.density = Number(cfg.density);
  if (cfg.brightness !== undefined) musicCfg.brightness = Number(cfg.brightness);
  if (cfg.scale !== undefined) musicCfg.scale = String(cfg.scale);
  if (cfg.mode !== undefined) musicCfg.music_generation_mode = String(cfg.mode);

  await session.setWeightedPrompts({ weightedPrompts: cfg.prompts });
  if (Object.keys(musicCfg).length) await session.setMusicGenerationConfig({ musicGenerationConfig: musicCfg });
  await session.play();

  // Wait briefly until we either exhausted chunk budget or connection closes
  // In browser we don't have a direct completion promise, so poll a bit.
  const deadline = Date.now() + durationSec * 1200;
  while (!finished && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  const blob = createWavBlob(chunks);
  const url = URL.createObjectURL(blob);
  return { url, sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: BIT_DEPTH, durationSec };
}