<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'

type Clip = {
  buffer: AudioBuffer
  startSec: number
  gain: number
  peaks?: number[]
}

class Track {
  private ctx: AudioContext
  private output: GainNode
  private filter: BiquadFilterNode
  private activeSources: AudioBufferSourceNode[] = []
  public clips: Clip[] = []

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.output = ctx.createGain()
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = 20000
    this.output.connect(this.filter)
    this.filter.connect(ctx.destination)
  }

  setGain(value: number) {
    this.output.gain.value = value
  }

  setFilterFrequency(freq: number) {
    this.filter.frequency.value = freq
  }

  addClip(clip: Clip) {
    this.clips.push(clip)
  }

  scheduleAll(positionSec: number, projectLengthSec: number) {
    const now = this.ctx.currentTime
    for (const clip of this.clips) {
      const startSeconds = clip.startSec
      const offsetToPosition = startSeconds - positionSec
      const when = Math.max(now + offsetToPosition, now)
      const projectLengthSeconds = projectLengthSec
      if (startSeconds >= projectLengthSeconds) continue
      const source = this.ctx.createBufferSource()
      source.buffer = clip.buffer
      const gain = this.ctx.createGain()
      gain.gain.value = clip.gain
      source.connect(gain)
      gain.connect(this.output)
      const offsetInBuffer = Math.max(0, positionSec - startSeconds)
      const bufferRemaining = Math.max(0, source.buffer.duration - offsetInBuffer)
      const endLimit = Math.max(0, projectLengthSeconds - Math.max(startSeconds, positionSec))
      const playSeconds = Math.min(bufferRemaining, endLimit)
      if (playSeconds <= 0) continue
      source.start(when, offsetInBuffer, playSeconds)
      this.activeSources.push(source)
    }
  }

  stopAll() {
    for (const s of this.activeSources) {
      try { s.stop() } catch {}
      try { s.disconnect() } catch {}
    }
    this.activeSources = []
  }
}

class AudioEngine {
  public ctx: AudioContext
  public isPlaying = false
  public positionSec = 0
  public tracks: Track[] = []
  public playStartTime = 0

  constructor() {
    this.ctx = new AudioContext()
  }

  async ensureRunning() {
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  createTrack() {
    const track = new Track(this.ctx)
    this.tracks.push(track)
    return track
  }

  async play(projectLengthSec: number) {
    await this.ensureRunning()
    for (const t of this.tracks) t.stopAll()
    this.isPlaying = true
    this.playStartTime = this.ctx.currentTime - this.positionSec
    for (const t of this.tracks) t.scheduleAll(this.positionSec, projectLengthSec)
  }

  pause() {
    if (!this.isPlaying) return
    const elapsed = this.ctx.currentTime - this.playStartTime
    this.positionSec = this.positionSec + elapsed
    this.isPlaying = false
    for (const t of this.tracks) t.stopAll()
  }

  stop() {
    const elapsed = this.ctx.currentTime - this.playStartTime
    this.positionSec = this.positionSec + (this.isPlaying ? elapsed : 0)
    this.isPlaying = false
    for (const t of this.tracks) t.stopAll()
    this.positionSec = 0
  }

  

  async fileToBuffer(file: File): Promise<AudioBuffer> {
    const arr = await file.arrayBuffer()
    return await this.ctx.decodeAudioData(arr)
  }
}

const engine = new AudioEngine()

const tracks = reactive<{ track: Track; gain: number; name: string; fx: { lp: number } }[]>([])
const SEC_PX = 80
const ROW_H = 56
const playheadPx = ref(0)
let raf: number | null = null
const projectLengthSec = ref(60)
const timelineRef = ref<HTMLElement | null>(null)
const currentSeconds = ref(0)
const totalSeconds = ref(0)

function addTrack() {
  const t = engine.createTrack()
  tracks.push({ track: t, gain: 0.8, name: `Track ${tracks.length + 1}`, fx: { lp: 20000 } })
  t.setGain(0.8)
}

async function onFilesSelected(e: Event, itemIndex: number) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return
  const t = tracks[itemIndex].track
  const existingEnd = t.clips.reduce((max, c) => Math.max(max, c.startSec + c.buffer.duration), 0)
  let cursor = Math.round(existingEnd)
  for (const file of Array.from(files)) {
    const buffer = await engine.fileToBuffer(file)
    const durationSec = buffer.duration
    const peaks = computePeaks(buffer, 300)
    t.addClip({ buffer, startSec: cursor, gain: tracks[itemIndex].gain, peaks })
    cursor = Math.round(cursor + durationSec + 1)
  }
}

function onGainChange(value: number, itemIndex: number) {
  tracks[itemIndex].gain = value
  tracks[itemIndex].track.setGain(value)
}

function onLpChange(value: number, itemIndex: number) {
  tracks[itemIndex].fx.lp = value
  tracks[itemIndex].track.setFilterFrequency(value)
}

async function play() {
  await engine.play(projectLengthSec.value)
  startTick()
}

function stop() {
  engine.stop()
  stopTick()
}

if (tracks.length === 0) addTrack()

const dragging = reactive<{ active: boolean; tIdx: number; cIdx: number; startX: number; startSec: number }>({ active: false, tIdx: -1, cIdx: -1, startX: 0, startSec: 0 })
const playheadDrag = reactive<{ active: boolean }>({ active: false })

function onClipMouseDown(tIdx: number, cIdx: number, e: MouseEvent) {
  dragging.active = true
  dragging.tIdx = tIdx
  dragging.cIdx = cIdx
  dragging.startX = e.clientX
  dragging.startSec = tracks[tIdx].track.clips[cIdx].startSec
}

function onPointerMove(e: PointerEvent) {
  if (dragging.active) {
    const dx = e.clientX - dragging.startX
    const secStep = Math.round(dx / SEC_PX)
    const clip = tracks[dragging.tIdx].track.clips[dragging.cIdx]
    clip.startSec = Math.max(0, Math.min(projectLengthSec.value, dragging.startSec + secStep))
    return
  }
  if (playheadDrag.active) {
    setPlayheadByClientX(e.clientX)
  }
}

function onPointerUp() {
  dragging.active = false
  playheadDrag.active = false
}

function startTick() {
  stopTick()
  const tick = () => {
    const elapsed = engine.ctx.currentTime - engine.playStartTime
    const sec = elapsed
    const maxPx = projectLengthSec.value * SEC_PX
    playheadPx.value = Math.min(sec * SEC_PX, maxPx)
    currentSeconds.value = sec
    totalSeconds.value = projectLengthSec.value
    ensurePlayheadVisible()
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

function stopTick() {
  if (raf !== null) cancelAnimationFrame(raf)
  raf = null
}

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('keydown', onKeyDown)
  stopTick()
})

function setPlayheadByClientX(clientX: number) {
  const el = timelineRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const posPx = el.scrollLeft + clientX - rect.left
  const sec = Math.max(0, Math.min(projectLengthSec.value, Math.floor(posPx / SEC_PX)))
  engine.positionSec = sec
  playheadPx.value = sec * SEC_PX
  currentSeconds.value = sec
}

function ensurePlayheadVisible() {
  const el = timelineRef.value
  if (!el) return
  const margin = 80
  const left = playheadPx.value
  const viewLeft = el.scrollLeft
  const viewRight = viewLeft + el.clientWidth
  if (left < viewLeft + margin) el.scrollLeft = Math.max(0, left - margin)
  else if (left > viewRight - margin) el.scrollLeft = left - el.clientWidth + margin
}

function onTimelineMouseDown(e: MouseEvent) {
  playheadDrag.active = true
  setPlayheadByClientX(e.clientX)
}

function onKeyDown(e: KeyboardEvent) {
  if (e.code === 'Space') {
    e.preventDefault()
    if (engine.isPlaying) {
      engine.pause()
      stopTick()
    } else {
      play()
    }
  }
}

function computePeaks(buffer: AudioBuffer, samples = 200): number[] {
  const chData = [] as Float32Array[]
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) chData.push(buffer.getChannelData(ch))
  const len = buffer.length
  const block = Math.floor(len / samples)
  const peaks: number[] = []
  for (let i = 0; i < samples; i++) {
    const start = i * block
    const end = Math.min(len, start + block)
    let max = 0
    for (let j = start; j < end; j++) {
      let v = 0
      for (let ch = 0; ch < chData.length; ch++) v += Math.abs(chData[ch][j])
      v /= chData.length
      if (v > max) max = v
    }
    peaks.push(max)
  }
  return peaks
}

function formatTime(s: number) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}
</script>

<template>
  <div class="app">
    <header class="transport">
      <div></div>
      <div class="center">
        <button class="btn primary" @click="play">▶︎ 播放</button>
        <button class="btn" @click="engine.pause(); stopTick()">⏸ 暂停</button>
        <button class="btn danger" @click="stop">■ 停止</button>
        <div class="time">{{ formatTime(currentSeconds) }} / {{ formatTime(totalSeconds) }}</div>
      </div>
      <div class="right">
        <label>长度(秒)
          <input type="number" v-model.number="projectLengthSec" min="4" max="3600" />
        </label>
      </div>
    </header>
    <main class="workspace">
      <div class="sidebar">
        <div class="tracks-header">
          <span>Tracks</span>
          <button class="btn" @click="addTrack">＋ 添加轨道</button>
        </div>
        <div class="track-row" v-for="(item, idx) in tracks" :key="idx" :style="{ height: ROW_H + 'px' }">
          <input class="name-input" v-model="item.name" />
          <input class="gain" type="range" min="0" max="1" step="0.01" :value="item.gain" @input="onGainChange(($event.target as HTMLInputElement).valueAsNumber, idx)" />
          <input class="lp" type="range" min="50" max="20000" step="1" :value="item.fx.lp" @input="onLpChange(($event.target as HTMLInputElement).valueAsNumber, idx)" />
          <label class="file btn">选择音频
            <input type="file" accept="audio/*" multiple @change="(e) => onFilesSelected(e, idx)" />
          </label>
          <button class="btn danger" @click="tracks.splice(idx, 1)">删除</button>
        </div>
      </div>
      <section class="timeline" ref="timelineRef" @mousedown.self="onTimelineMouseDown">
        <div class="ruler" :style="{ gridTemplateColumns: 'repeat(' + projectLengthSec + ', ' + SEC_PX + 'px)' }">
          <div v-for="n in projectLengthSec" :key="n" class="beat">{{ n }}s</div>
        </div>
        <div class="rows">
          <div v-for="(item, idx) in tracks" :key="idx" class="clip-row" :style="{ height: ROW_H + 'px' }">
            <div class="clip" v-for="(clip, cIdx) in item.track.clips" :key="cIdx"
              @mousedown="(e) => onClipMouseDown(idx, cIdx, e)"
              :style="{ left: clip.startSec * SEC_PX + 'px', width: (Math.min(clip.buffer.duration, Math.max(0, projectLengthSec - clip.startSec))) * SEC_PX + 'px' }">
              <div class="wave" v-if="clip.peaks" :style="{ '--bars': clip.peaks.length }">
                <span v-for="(p, i) in clip.peaks" :key="i" :style="{ height: Math.max(2, Math.floor(28 * p)) + 'px' }"></span>
              </div>
            </div>
          </div>
        </div>
        <div class="playhead" :style="{ left: playheadPx + 'px' }" @mousedown.stop="playheadDrag.active = true"></div>
        <div class="project-progress" :style="{ width: Math.min(playheadPx, projectLengthSec * SEC_PX) + 'px' }"></div>
      </section>
    </main>
  </div>
  
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; color: #e6e8eb; background: #0b0f14; }
.transport { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid #1a212b; background: #10151c; }
.center { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
.time { margin-left: 12px; font-variant-numeric: tabular-nums; opacity: 0.9; }
.btn { padding: 6px 10px; border: 1px solid #2a3442; background: #131922; color: #e6e8eb; border-radius: 6px; margin-right: 6px; cursor: pointer; }
.btn.primary { border-color: #7c4dff; background: #1a152b; color: #dcd3ff; }
.btn.danger { border-color: #ff4d4f; color: #ffb3b6; background: #241317; }
.workspace { display: grid; grid-template-columns: 360px 1fr; height: calc(100vh - 52px); }
.sidebar { border-right: 1px solid #1a212b; padding: 8px; overflow-y: auto; background: #0d131b; }
.tracks-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.track-row { display: grid; grid-template-columns: 1fr 110px 150px 120px 80px; align-items: center; gap: 8px; border-bottom: 1px dashed #1a212b; padding: 6px 0; }
.name-input { width: 100%; padding: 6px 8px; border: 1px solid #1a212b; border-radius: 6px; background: #0b0f14; color: #e6e8eb; }
.timeline { position: relative; overflow: auto; background: #0b0f14; }
.ruler { position: sticky; top: 0; display: grid; align-items: center; grid-auto-rows: 24px; border-bottom: 1px solid #1a212b; background: #0d131b; z-index: 2; }
.beat { padding: 4px; border-left: 1px solid #1a212b; font-size: 12px; color: #a6acb2; }
.rows { position: relative; }
.clip-row { position: relative; border-bottom: 1px dashed #1a212b; }
.clip { position: absolute; top: 8px; height: 32px; background: #7c4dff22; border: 1px solid #7c4dff55; border-radius: 6px; cursor: grab; }
.clip:active { cursor: grabbing; }
.wave { position: absolute; inset: 2px 4px; display: grid; grid-template-columns: repeat(var(--bars), 1fr); align-items: end; gap: 1px; }
.wave span { display: block; width: auto; background: #9a7aff; border-radius: 1px; }
.file { position: relative; display: inline-flex; align-items: center; justify-content: center; }
.file input { position: absolute; inset: 0; opacity: 0.001; cursor: pointer; }
.playhead { position: absolute; top: 24px; bottom: 0; width: 0; border-left: 2px solid #ffcf66; }
.project-progress { position: absolute; top: 24px; height: 2px; background: #ffcf6644; left: 0; }
</style>
