import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { meansNone } from '../../lib/errors.shared.ts'
import {
  OPENAI_SECRET as SECRET,
  openaiSecretOrNonOAuthKey,
  openaiError,
  openaiTranscribe,
} from '../../lib/openai.ts'
import type { JsonObject } from '@earendil-works/pi-durable'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import { SetSettingsAction, SettingsAction, StatusAction, TranscribeAction } from './refs.ts'
import type { DictationSettings } from './refs.ts'

const LOGIN = 'openai-codex'
const NO_CREDENTIAL = `Voice needs a ChatGPT login or an OpenAI API key: sign in with ChatGPT, or add ${SECRET} in ⌘K → Secrets`
const TOO_LARGE = 'The recording is too large to transcribe'
const TIMEOUT_MS = 65_000

const action12MbAudioLimit = 8 * 1024 * 1024
export { action12MbAudioLimit as MAX_AUDIO_BYTES }

const CHATGPT_LOGIN_ONLY_ENDPOINT = 'https://chatgpt.com/backend-api/transcribe'

export const secrets = [
  {
    name: SECRET,
    description: 'OpenAI API key for voice input in the composer (speech to text)',
    url: 'https://platform.openai.com/api-keys',
    provider: 'openai',
  },
]

type VoiceHost = Pick<ExtensionHost, 'userHome' | 'modelRuntime'>

type Credential = { kind: 'login'; token: string } | { kind: 'key'; key: string }

async function credentialsLoginFirst(host: VoiceHost, signal?: AbortSignal): Promise<Credential[]> {
  const found: Credential[] = []
  const runtime = host.modelRuntime
  if (runtime.getProviderAuthStatus(LOGIN).configured) {
    const loginAccessToken = await runtime.getAuth(LOGIN, { signal }).catch(meansNone)
    if (loginAccessToken?.auth.apiKey)
      found.push({ kind: 'login', token: loginAccessToken.auth.apiKey })
  }
  const key = await openaiSecretOrNonOAuthKey(host, signal).catch(meansNone)
  if (key) found.push({ kind: 'key', key })
  return found
}

type Attempt = { status: number; text?: string; detail?: string }

async function transcribe(
  credential: Credential,
  audio: Blob,
  signal: AbortSignal,
): Promise<Attempt> {
  if (credential.kind === 'key') return openaiTranscribe(credential.key, audio, signal)
  const form = new FormData()
  const extension = audio.type.split('/')[1]?.split(';')[0] || 'webm'
  form.set('file', audio, `recording.${extension}`)
  form.set('model', 'gpt-transcribe')
  const response = await fetch(CHATGPT_LOGIN_ONLY_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential.token}` },
    body: form,
    signal,
  })
  if (!response.ok) {
    const { status, message } = await openaiError(response)
    return { status, detail: message }
  }
  const answer: { text?: unknown } | undefined = await response.json().catch(meansNone)
  return typeof answer?.text === 'string'
    ? { status: response.status, text: answer.text }
    : { status: 502, detail: 'no text in the answer' }
}

function failure(credential: Credential, { status, detail }: Attempt) {
  const said = detail ? ` (${detail})` : ''
  if (status === 413) return TOO_LARGE
  if (credential.kind === 'login') {
    if (status === 401) return `OpenAI refused the ChatGPT login${said}: sign in with ChatGPT again`
    if (status === 403)
      return `ChatGPT refused the transcription (HTTP 403)${said}: try again, or add ${SECRET} in ⌘K → Secrets`
    if (status === 429)
      return `ChatGPT is rate-limiting transcription${said}: try again in a minute`
    return `Transcription through the ChatGPT login failed (HTTP ${status})${detail ? `: ${detail}` : ''}`
  }
  if (status === 401) return `OpenAI rejected the API key: check ${SECRET} in ⌘K → Secrets`
  if (status === 429) return `OpenAI is rate-limiting transcription${said}: try again in a minute`
  return `Transcription failed (HTTP ${status})${detail ? `: ${detail}` : ''}`
}

const nextCredentialMayServe = (status: number) =>
  status === 401 || status === 403 || status === 429

async function attempt(credential: Credential, audio: Blob, deadline: AbortSignal) {
  return transcribe(credential, audio, deadline).catch((error: unknown) => {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new Error('Transcription timed out: try a shorter recording')
    throw new Error(
      `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

async function voiceText(host: VoiceHost, signal: AbortSignal, audio: Blob): Promise<string> {
  const [best, next] = await credentialsLoginFirst(host, signal)
  if (!best) throw new Error(NO_CREDENTIAL)
  const deadlineSharedByFallback = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
  const first = await attempt(best, audio, deadlineSharedByFallback)
  if (first.text !== undefined) return first.text.trim()
  if (next && nextCredentialMayServe(first.status)) {
    const second = await attempt(next, audio, deadlineSharedByFallback)
    if (second.text !== undefined) return second.text.trim()
    throw new Error(`${failure(best, first)} · ${failure(next, second)}`)
  }
  throw new Error(failure(best, first))
}

const DEFAULTS: DictationSettings = { talk: 'tap', shortcut: 'mod+shift+space', cues: true }

function dictationSettings(settings: JsonObject): DictationSettings {
  const stored = settings.dictation
  const { talk, shortcut, cues } =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  return {
    talk: talk === 'hold' || talk === 'tap' ? talk : DEFAULTS.talk,
    shortcut: typeof shortcut === 'string' && shortcut.trim() ? shortcut : DEFAULTS.shortcut,
    cues: typeof cues === 'boolean' ? cues : DEFAULTS.cues,
  }
}

export default defineExtension({ name: 'dictation' })

export const actions = {
  status: implementAction(StatusAction, async (_args, { host, signal }) =>
    (await credentialsLoginFirst(host, signal)).length
      ? { available: true as const }
      : { available: false as const, reason: NO_CREDENTIAL },
  ),

  settings: implementAction(SettingsAction, async (_args, { host }) =>
    dictationSettings(await readSettings(userSettingsPath(host.userHome))),
  ),

  setSettings: implementAction(SetSettingsAction, async (args, { host }) => {
    const { talk, shortcut, cues } =
      args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (
      (talk !== undefined && talk !== 'hold' && talk !== 'tap') ||
      (shortcut !== undefined && (typeof shortcut !== 'string' || !shortcut.trim())) ||
      (cues !== undefined && typeof cues !== 'boolean')
    )
      throw new Error('Expected { talk?: "hold" | "tap", shortcut?: string, cues?: boolean }')
    let next = DEFAULTS
    await updateSettings(userSettingsPath(host.userHome), (settings) => {
      const stored = settings.dictation
      const dictation: JsonObject =
        stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
      if (talk !== undefined) dictation.talk = talk
      if (shortcut !== undefined) dictation.shortcut = shortcut
      if (cues !== undefined) dictation.cues = cues
      settings.dictation = dictation
      next = dictationSettings(settings)
    })
    return next
  }),

  transcribe: implementAction(TranscribeAction, async (args, { host, signal }) => {
    const { audio, mimeType } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof audio !== 'string' || !audio || typeof mimeType !== 'string' || !mimeType)
      throw new Error('Expected { audio: base64, mimeType }')
    const bytes = Buffer.from(audio, 'base64')
    const audioOverActionLimit = bytes.byteLength > action12MbAudioLimit
    if (audioOverActionLimit) throw new Error(TOO_LARGE)
    return { text: await voiceText(host, signal, new Blob([bytes], { type: mimeType })) }
  }),
}
