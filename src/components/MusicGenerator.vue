<script setup lang="ts">
import { ref } from 'vue'
import { generateMusic } from '../lib/lyria'

const promptsText = ref('piano:1.0,danceable:0.8')
const duration = ref(24)
const bpm = ref(110)
const guidance = ref(3)
const outputName = ref('my_song.wav')
const loading = ref(false)
const errorMsg = ref('')
const resultUrl = ref('')

function parsePrompts(input: string) {
  return input.split(',').map(s => {
    const [t, w] = s.split(':')
    return { text: (t || '').trim(), weight: Number(w || 1) }
  }).filter(p => p.text && Number.isFinite(p.weight) && p.weight !== 0)
}

async function generate() {
  loading.value = true
  errorMsg.value = ''
  resultUrl.value = ''
  try {
    const data = await generateMusic({
      prompts: parsePrompts(promptsText.value),
      duration: duration.value,
      bpm: bpm.value,
      guidance: guidance.value,
    })
    resultUrl.value = data.url
    const ev = new CustomEvent('music-generated', { detail: data })
    window.dispatchEvent(ev)
  } catch (e: any) {
    errorMsg.value = String(e)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="gen">
    <div class="row">
      <label>Prompts</label>
      <input v-model="promptsText" />
    </div>
    <div class="row">
      <label>Duration</label>
      <input type="number" v-model.number="duration" />
    </div>
    <div class="row">
      <label>BPM</label>
      <input type="number" v-model.number="bpm" />
    </div>
    <div class="row">
      <label>Guidance</label>
      <input type="number" v-model.number="guidance" />
    </div>
    <div class="row">
      <label>输出文件名</label>
      <input v-model="outputName" />
    </div>
    <div class="row">
      <button class="btn primary" @click="generate" :disabled="loading">{{ loading ? '生成中...' : '生成音乐' }}</button>
      <span v-if="errorMsg" class="err">{{ errorMsg }}</span>
      <a v-if="resultUrl" :href="resultUrl" :download="outputName" target="_blank">下载</a>
    </div>
  </div>
</template>

<style scoped>
.gen { display: grid; gap: 8px; padding: 8px; border: 1px solid #1a212b; border-radius: 8px; }
.row { display: grid; grid-template-columns: 120px 1fr auto; gap: 8px; align-items: center; }
.err { color: #ff4d4f; }
input { padding: 6px 8px; border: 1px solid #1a212b; border-radius: 6px; background: #0b0f14; color: #e6e8eb; }
.btn { padding: 6px 10px; border: 1px solid #2a3442; background: #131922; color: #e6e8eb; border-radius: 999px; cursor: pointer; }
.btn.primary { border-color: #7c4dff; background: #1a152b; color: #dcd3ff; }
</style>
