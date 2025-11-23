<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'

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
  private panner: StereoPannerNode
  private hpFilter: BiquadFilterNode
  private compressor: DynamicsCompressorNode
  private activeSources: AudioBufferSourceNode[] = []
  public clips: Clip[] = []

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.output = ctx.createGain()
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = 20000
    this.panner = ctx.createStereoPanner()
    this.hpFilter = ctx.createBiquadFilter()
    this.hpFilter.type = 'highpass'
    this.hpFilter.frequency.value = 20
    this.compressor = ctx.createDynamicsCompressor()
    this.output.connect(this.panner)
    this.panner.connect(this.filter)
    this.filter.connect(this.hpFilter)
    this.hpFilter.connect(this.compressor)
    this.compressor.connect(ctx.destination)
  }

  setGain(value: number) {
    this.output.gain.value = value
  }

  setFilterFrequency(freq: number) {
    this.filter.frequency.value = freq
  }

  setPan(value: number) {
    this.panner.pan.value = value
  }

  setHpFrequency(freq: number) {
    this.hpFilter.frequency.value = freq
  }

  setCompressorThreshold(db: number) {
    this.compressor.threshold.value = db
  }

  setCompressorRatio(ratio: number) {
    this.compressor.ratio.value = ratio
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

const tracks = reactive<{ track: Track; gain: number; name: string; fx: { lp: number; hp: number; comp: { threshold: number; ratio: number } }; color: string; muted: boolean; solo: boolean; pan: number; expanded: boolean }[]>([])
const secPx = ref(80)
const rowH = ref(56)
const playheadPx = ref(0)
let raf: number | null = null
const projectLengthSec = ref(60)
const timelineRef = ref<HTMLElement | null>(null)
const currentSeconds = ref(0)
const totalSeconds = ref(0)
const workspaceRef = ref<HTMLElement | null>(null)
const rowsRef = ref<HTMLElement | null>(null)
const sidebarW = ref(360)
const resizing = ref(false)
const compact = computed(() => sidebarW.value < 260)

function addTrack() {
  const t = engine.createTrack()
  const palette = ['#7c4dff', '#00c2ff', '#ff5c8a', '#00d084', '#ffcf66'] as const
  const color = palette[tracks.length % palette.length] as string
  tracks.push({ track: t, gain: 0.8, name: `Track ${tracks.length + 1}`, fx: { lp: 20000, hp: 20, comp: { threshold: -24, ratio: 2 } }, color, muted: false, solo: false, pan: 0, expanded: false })
  t.setGain(0.8)
}

async function onFilesSelected(e: Event, itemIndex: number) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return
  const item = tracks[itemIndex]
  if (!item) return
  const t = item.track
  const existingEnd = t.clips.reduce((max, c) => Math.max(max, c.startSec + c.buffer.duration), 0)
  let cursor = Math.round(existingEnd)
  for (const file of Array.from(files)) {
    const buffer = await engine.fileToBuffer(file)
    const durationSec = buffer.duration
    const peaks = computePeaks(buffer, 300)
    t.addClip({ buffer, startSec: cursor, gain: item.gain, peaks })
    cursor = Math.round(cursor + durationSec + 1)
  }
}

function onGainChange(value: number, itemIndex: number) {
  const item = tracks[itemIndex]
  if (!item) return
  item.gain = value
  item.track.setGain(value)
  updateSoloMute()
}

function onLpChange(value: number, itemIndex: number) {
  const item = tracks[itemIndex]
  if (!item) return
  item.fx.lp = value
  item.track.setFilterFrequency(value)
}

function onPanChange(value: number, itemIndex: number) {
  const item = tracks[itemIndex]
  if (!item) return
  item.pan = value
  item.track.setPan(value)
}

function onHpChange(value: number, itemIndex: number) {
  const item = tracks[itemIndex]
  if (!item) return
  item.fx.hp = value
  item.track.setHpFrequency(value)
}

function onCompThresholdChange(value: number, itemIndex: number) {
  const item = tracks[itemIndex]
  if (!item) return
  item.fx.comp.threshold = value
  item.track.setCompressorThreshold(value)
}

function onCompRatioChange(value: number, itemIndex: number) {
  const item = tracks[itemIndex]
  if (!item) return
  item.fx.comp.ratio = value
  item.track.setCompressorRatio(value)
}

function toggleMute(itemIndex: number) {
  const item = tracks[itemIndex]
  if (!item) return
  item.muted = !item.muted
  updateSoloMute()
}

function toggleSolo(itemIndex: number) {
  const item = tracks[itemIndex]
  if (!item) return
  item.solo = !item.solo
  updateSoloMute()
}

function updateSoloMute() {
  const anySolo = tracks.some(t => t.solo)
  tracks.forEach(t => {
    const shouldMute = t.muted || (anySolo && !t.solo)
    t.track.setGain(shouldMute ? 0 : t.gain)
    t.track.setPan(t.pan)
    t.track.setFilterFrequency(t.fx.lp)
    t.track.setHpFrequency(t.fx.hp)
    t.track.setCompressorThreshold(t.fx.comp.threshold)
    t.track.setCompressorRatio(t.fx.comp.ratio)
  })
}

async function play() {
  await engine.play(projectLengthSec.value)
  playheadPx.value = engine.positionSec * secPx.value
  startTick()
}

function stop() {
  engine.stop()
  stopTick()
}

if (tracks.length === 0) addTrack()

const dragging = reactive<{ active: boolean; tIdx: number; cIdx: number; startX: number; startSec: number } & { cross?: boolean }>({ active: false, tIdx: -1, cIdx: -1, startX: 0, startSec: 0, cross: false })
const playheadDrag = reactive<{ active: boolean }>({ active: false })

function onClipMouseDown(tIdx: number, cIdx: number, e: MouseEvent) {
  dragging.active = true
  dragging.tIdx = tIdx
  dragging.cIdx = cIdx
  dragging.startX = e.clientX
  const item = tracks[tIdx]
  const clip = item?.track.clips[cIdx]
  dragging.startSec = clip ? clip.startSec : 0
  dragging.cross = true
}

function onPointerMove(e: PointerEvent) {
  if (dragging.active) {
    const dx = e.clientX - dragging.startX
    const secStep = Math.round(dx / secPx.value)
    const item = tracks[dragging.tIdx]
    const clip = item?.track.clips[dragging.cIdx]
    if (clip) clip.startSec = Math.max(0, Math.min(projectLengthSec.value, dragging.startSec + secStep))
    if (dragging.cross) {
      const targetIdx = getTargetTrackIndex(e.clientY)
      if (targetIdx !== -1 && targetIdx !== dragging.tIdx) {
        const fromTrack = item?.track
        const toTrack = tracks[targetIdx]?.track
        const clipObj = fromTrack?.clips[dragging.cIdx]
        if (fromTrack && toTrack && clipObj) {
          fromTrack.clips.splice(dragging.cIdx, 1)
          toTrack.clips.push(clipObj)
        }
        dragging.tIdx = targetIdx
        dragging.cIdx = toTrack ? toTrack.clips.length - 1 : -1
      }
    }
    return
  }
  if (playheadDrag.active) {
    setPlayheadByClientX(e.clientX)
  }
}

function onPointerUp() {
  dragging.active = false
  playheadDrag.active = false
  resizing.value = false
}

function startTick() {
  stopTick()
  const tick = () => {
    const elapsed = engine.ctx.currentTime - engine.playStartTime
    const sec = elapsed
    const maxPx = projectLengthSec.value * secPx.value
    playheadPx.value = Math.min(sec * secPx.value, maxPx)
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
  window.addEventListener('mousemove', onMouseMove)
  updateSoloMute()
})

onUnmounted(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('mousemove', onMouseMove)
  stopTick()
})

function setPlayheadByClientX(clientX: number) {
  const el = timelineRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const posPx = el.scrollLeft + clientX - rect.left
  const sec = Math.max(0, Math.min(projectLengthSec.value, Math.floor(posPx / secPx.value)))
  engine.positionSec = sec
  playheadPx.value = sec * secPx.value
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

function onSplitterMouseDown() {
  resizing.value = true
}

function withAlpha(hex: string, alpha: string) {
  return hex.length === 7 ? hex + alpha : hex
}

function getTargetTrackIndex(clientY: number) {
  const rows = rowsRef.value
  if (!rows) return -1
  const rect = rows.getBoundingClientRect()
  const y = clientY - rect.top
  const idx = Math.floor(y / rowH.value)
  return Math.max(0, Math.min(idx, tracks.length - 1))
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

function onMouseMove(e: MouseEvent) {
  if (!resizing.value) return
  const ws = workspaceRef.value
  if (!ws) return
  const rect = ws.getBoundingClientRect()
  const x = e.clientX - rect.left
  sidebarW.value = Math.max(160, Math.min(560, x))
}

function onSidebarScroll(e: Event) {
  const rows = rowsRef.value
  const el = e.target as HTMLElement
  if (!rows) return
  rows.scrollTop = el.scrollTop
}

function onRowsScroll(e: Event) {
  const sidebar = document.querySelector('.sidebar') as HTMLElement | null
  const el = e.target as HTMLElement
  if (!sidebar) return
  sidebar.scrollTop = el.scrollTop
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
      for (let ch = 0; ch < chData.length; ch++) {
        const channel = chData[ch]!
        const sample = channel[j] ?? 0
        v += Math.abs(sample)
      }
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
        <label>缩放
          <input type="range" :min="Math.max(20, Math.floor((timelineRef?.clientWidth || 600) / Math.max(1, projectLengthSec)))" max="240" step="5" v-model.number="secPx" />
        </label>
        <label>纵向
          <input type="range" min="32" max="96" step="4" v-model.number="rowH" />
        </label>
      </div>
    </header>
    <main class="workspace" ref="workspaceRef">
      <div class="sidebar" :style="{ width: sidebarW + 'px' }" @scroll="onSidebarScroll">
        <div class="tracks-header">
          <span>Tracks</span>
          <button class="btn" @click="addTrack">＋ 添加轨道</button>
        </div>
        <div class="track-row" v-for="(item, idx) in tracks" :key="idx" :style="{ height: rowH + 'px' }">
          <div class="cell name">
            <input class="name-input" v-model="item.name" :class="{ compact }" />
          </div>
          <div class="cell ms">
            <button class="btn small" :class="{ active: item.muted }" @click="toggleMute(idx)">M</button>
            <button class="btn small" :class="{ active: item.solo }" @click="toggleSolo(idx)">S</button>
          </div>
          <div class="cell pan" v-if="!compact">
            <input type="range" min="-1" max="1" step="0.01" :value="item.pan" @input="onPanChange(($event.target as HTMLInputElement).valueAsNumber, idx)" />
          </div>
          <div class="cell actions">
            <button class="btn small" @click="item.expanded = !item.expanded">▼</button>
          </div>
          <div class="details" v-if="item.expanded">
            <div class="detail-row">
              <label>音量</label>
              <input class="gain" type="range" min="0" max="1" step="0.01" :value="item.gain" @input="onGainChange(($event.target as HTMLInputElement).valueAsNumber, idx)" />
            </div>
            <div class="detail-row">
              <label>低通</label>
              <input class="lp" type="range" min="50" max="20000" step="1" :value="item.fx.lp" @input="onLpChange(($event.target as HTMLInputElement).valueAsNumber, idx)" />
            </div>
            <div class="detail-row">
              <label>高通</label>
              <input type="range" min="20" max="2000" step="1" :value="item.fx.hp" @input="onHpChange(($event.target as HTMLInputElement).valueAsNumber, idx)" />
            </div>
            <div class="detail-row">
              <label>压缩</label>
              <div style="display:flex; gap:8px; align-items:center;">
                <input type="range" min="-60" max="0" step="1" :value="item.fx.comp.threshold" @input="onCompThresholdChange(($event.target as HTMLInputElement).valueAsNumber, idx)" />
                <input type="range" min="1" max="20" step="1" :value="item.fx.comp.ratio" @input="onCompRatioChange(($event.target as HTMLInputElement).valueAsNumber, idx)" />
              </div>
            </div>
            <div class="detail-row">
              <label class="file btn">选择音频
                <input type="file" accept="audio/*" multiple @change="(e) => onFilesSelected(e, idx)" />
              </label>
              <button class="btn danger" @click="tracks.splice(idx, 1)">删除</button>
            </div>
          </div>
        </div>
      </div>
      <div class="splitter" @mousedown="onSplitterMouseDown"></div>
      <section class="timeline" ref="timelineRef" @mousedown.self="onTimelineMouseDown">
        <div class="ruler" :style="{ gridTemplateColumns: 'repeat(' + projectLengthSec + ', ' + secPx + 'px)' }">
          <div v-for="n in projectLengthSec" :key="n" class="beat">{{ n }}s</div>
        </div>
        <div class="rows" ref="rowsRef" @scroll="onRowsScroll">
          <div v-for="(item, idx) in tracks" :key="idx" class="clip-row" :style="{ height: rowH + 'px' }">
            <div class="clip" v-for="(clip, cIdx) in item.track.clips" :key="cIdx"
              @mousedown="(e) => onClipMouseDown(idx, cIdx, e)"
              :style="{ left: clip.startSec * secPx + 'px', width: (Math.min(clip.buffer.duration, Math.max(0, projectLengthSec - clip.startSec))) * secPx + 'px', borderColor: withAlpha(item.color, '55'), background: withAlpha(item.color, '22') }">
              <div class="wave" v-if="clip.peaks" :style="{ '--bars': clip.peaks.length }">
                <span v-for="(p, i) in clip.peaks" :key="i" :style="{ height: Math.max(2, Math.floor(28 * p)) + 'px' }"></span>
              </div>
            </div>
          </div>
        </div>
        <div class="playhead" :style="{ left: playheadPx + 'px' }" @mousedown.stop="playheadDrag.active = true"></div>
        <div class="project-progress" :style="{ width: Math.min(playheadPx, projectLengthSec * secPx) + 'px' }"></div>
      </section>
    </main>
  </div>
  
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; color: #e6e8eb; background: #0b0f14; }
.transport { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid #1a212b; background: linear-gradient(180deg, #141a23, #0f141c); box-shadow: 0 2px 0 #0a0f14; }
.center { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
.time { margin-left: 12px; font-variant-numeric: tabular-nums; opacity: 0.9; }
.btn { padding: 6px 10px; border: 1px solid #2a3442; background: #131922; color: #e6e8eb; border-radius: 999px; margin-right: 6px; cursor: pointer; }
.btn.primary { border-color: #7c4dff; background: #1a152b; color: #dcd3ff; }
.btn.danger { border-color: #ff4d4f; color: #ffb3b6; background: #241317; }
.btn.small { padding: 4px 8px; border-radius: 999px; }
.btn.small.active { background: #263043; border-color: #7c4dff; }
.workspace { display: grid; grid-template-columns: auto 6px 1fr; height: calc(100vh - 52px); }
.sidebar { border-right: 1px solid #1a212b; padding: 8px; overflow-y: auto; background: #0d131b; }
.splitter { background: #1a212b; cursor: col-resize; }
.tracks-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.tracks-header { position: sticky; top: 0; height: 24px; background: #0d131b; z-index: 3; }
.track-row { position: relative; display: grid; grid-template-columns: 1fr 80px 140px 60px; align-items: center; gap: 8px; border-bottom: 1px dashed #1a212b; padding: 6px 0; }
.name-input { width: 100%; padding: 6px 8px; border: 1px solid #1a212b; border-radius: 6px; background: #0b0f14; color: #e6e8eb; }
.name-input.compact { padding: 6px 8px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
.details { position: absolute; left: 8px; right: 8px; top: 40px; grid-column: 1 / -1; display: grid; gap: 8px; background: #0b0f14; border: 1px solid #1a212b; border-radius: 8px; padding: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.35); z-index: 10; }
.detail-row { display: grid; grid-template-columns: 80px 1fr auto; align-items: center; gap: 8px; }
.timeline { position: relative; overflow: auto; background: #0b0f14; }
.ruler { position: sticky; top: 0; display: grid; align-items: center; grid-auto-rows: 24px; border-bottom: 1px solid #1a212b; background: #0d131b; z-index: 2; }
.beat { padding: 4px; border-left: 1px solid #1a212b; font-size: 12px; color: #a6acb2; }
.rows { position: relative; }
.clip-row { position: relative; border-bottom: 1px dashed #1a212b; }
.clip { position: absolute; top: 8px; height: 32px; border: 1px solid; border-radius: 6px; cursor: grab; }
.clip:active { cursor: grabbing; }
.wave { position: absolute; inset: 2px 4px; display: grid; grid-template-columns: repeat(var(--bars), 1fr); align-items: end; gap: 1px; }
.wave span { display: block; width: auto; background: #9a7aff; border-radius: 1px; }
.file { position: relative; display: inline-flex; align-items: center; justify-content: center; }
.file input { position: absolute; inset: 0; opacity: 0.001; cursor: pointer; }
.playhead { position: absolute; top: 24px; bottom: 0; width: 0; border-left: 2px solid #ffcf66; }
.project-progress { position: absolute; top: 24px; height: 2px; background: #ffcf6644; left: 0; }
</style>
