import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import memoryJarLogo from './assets/memoryjar.png'
import './App.css'

type Memory = { memoryId: string; text: string; date: string; color: string; createdAt: string; updatedAt: string }
type ApiResult<T> = { message?: string; memories?: T[]; memory?: T }
const colors = ['#f4c7cf', '#f8df9b', '#c7dced', '#d8c8eb', '#d0e3c8']
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '')
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
declare global { interface Window { google?: { accounts: { id: { initialize: (options: { client_id: string; callback: (response: { credential?: string }) => void }) => void; renderButton: (element: HTMLElement, options: { theme: string; size: string; shape: string; text: string }) => void } } } } }
const today = () => new Date().toISOString().slice(0, 10)

async function request<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!apiBaseUrl) throw new Error('The API is not configured. Set VITE_API_BASE_URL and restart the app.')
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.json().catch(() => ({})) as ApiResult<Memory>
  if (!response.ok) throw new Error(response.status === 401 ? 'Your Google session expired. Sign in again.' : data.message || `Request failed (${response.status}).`)
  return data as T
}

function App() {
  const [token, setToken] = useState('')
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState(false), [form, setForm] = useState(false), [editing, setEditing] = useState<Memory | null>(null)
  const [text, setText] = useState(''), [date, setDate] = useState(today()), [shaking, setShaking] = useState(false)
  const [reveal, setReveal] = useState<Memory | null>(null), [pending, setPending] = useState<Memory | null>(null), [toast, setToast] = useState(false)
  const last = useRef('')
  const signInButton = useRef<HTMLDivElement>(null)

  const loadMemories = useCallback(async (auth: string) => {
    setLoading(true); setError('')
    try { const data = await request<ApiResult<Memory>>(auth, '/memories'); setMemories(data.memories || []) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load memories.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { if (token) void loadMemories(token) }, [token, loadMemories])
  useEffect(() => {
    if (!googleClientId || token || !signInButton.current) return
    let cancelled = false
    const initialize = () => {
      if (cancelled || !window.google || !signInButton.current) return
      window.google.accounts.id.initialize({ client_id: googleClientId, callback: response => {
        if (response.credential) { setToken(response.credential); setError('') }
        else setError('Google sign-in did not return an ID token.')
      } })
      window.google.accounts.id.renderButton(signInButton.current, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' })
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-google-identity]')
    if (window.google) initialize()
    else if (existing) existing.addEventListener('load', initialize, { once: true })
    else { const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.defer = true; script.dataset.googleIdentity = 'true'; script.addEventListener('load', initialize, { once: true }); script.addEventListener('error', () => setError('Could not load Google sign-in. Check your connection.'), { once: true }); document.head.appendChild(script) }
    return () => { cancelled = true }
  }, [token])
  const signOut = () => { setToken(''); setMemories([]); setError(''); setReveal(null); setDrawer(false) }
  const open = (memory?: Memory) => { setEditing(memory || null); setText(memory?.text || ''); setDate(memory?.date || today()); setForm(true) }
  async function save(event: FormEvent) {
    event.preventDefault(); const value = text.trim(); if (!value || !token) return
    setBusy(true); setError('')
    try {
      const body = editing ? { text: value, date } : { text: value, date, color: colors[Math.floor(Math.random() * colors.length)] }
      const data = await request<ApiResult<Memory>>(token, editing ? `/memories/${encodeURIComponent(editing.memoryId)}` : '/memories', editing ? 'PUT' : 'POST', body)
      if (editing && data.memory) setMemories(items => items.map(item => item.memoryId === editing.memoryId ? data.memory! : item))
      else if (data.memory) setMemories(items => [data.memory!, ...items])
      setForm(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save memory.') }
    finally { setBusy(false) }
  }
  async function remove() {
    if (!pending || !token) return
    setBusy(true); setError('')
    try { await request(token, `/memories/${encodeURIComponent(pending.memoryId)}`, 'DELETE'); setMemories(items => items.filter(item => item.memoryId !== pending.memoryId)); setPending(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete memory.') }
    finally { setBusy(false) }
  }
  function shake() {
    if (shaking || loading) return
    if (!memories.length) { setToast(true); setTimeout(() => setToast(false), 2300); return }
    setShaking(true); const options = memories.filter(memory => memory.memoryId !== last.current)
    const chosen = options[Math.floor(Math.random() * options.length)] || memories[0]
    setTimeout(() => { setShaking(false); setReveal(chosen); last.current = chosen.memoryId }, 1000)
  }
  const fmt = (value: string) => new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

  return <div className="app-shell"><header className="topbar"><a className="brand" href="#top"><img className="brand-logo" src={memoryJarLogo} alt="" /><span>Digital Memory Jar</span></a>{token && <button className="profile-button" onClick={signOut} aria-label="Sign out">↪</button>}</header>
    {!token ? <main id="top"><section className="hero-section"><div className="hero-copy"><h1>A jar for the<br />little moments<br /><em>worth remembering.</em></h1><p className="subtitle">Capture your memories, keep them in the jar,<br />and rediscover them by surprise.</p></div><div className="sign-in-panel"><h2>Your memories, safely yours</h2><p>Sign in with Google to access your cloud memories.</p>{!googleClientId ? <p className="error-message">Set VITE_GOOGLE_CLIENT_ID to enable sign-in.</p> : <div ref={signInButton} />}{error && <p className="error-message" role="alert">{error}</p>}</div></section></main> : <>
      <main id="top"><section className="hero-section"><div className="hero-copy"><h1>A jar for the<br />little moments<br /><em>worth remembering.</em></h1><p className="subtitle">Capture your memories, keep them in the jar,<br />and rediscover them by surprise.</p></div><div className={'jar-scene ' + (shaking ? 'is-shaking' : '')} aria-label={`${memories.length} memories in the jar`}><div className="twinkle twinkle-a">✦</div><div className="twinkle twinkle-b">·</div><div className="twinkle twinkle-c">✧</div><div className="jar-lid"><div className="lid-ridge" /><div className="lid-ridge second" /></div><div className="jar-neck" /><div className="jar-body"><div className="glass-glint" /><div className="jar-inner-glow" />{memories.slice(0, 18).map((memory, i) => <div key={memory.memoryId} className={`paper paper-${i % 8}`} style={{ '--paper': memory.color, '--n': i } as React.CSSProperties}><i /></div>)}<div className="jar-bottom-shine" /></div><div className="jar-shadow" /></div>
        <div className="hero-actions"><button className="primary-button" onClick={shake} disabled={shaking || loading}>✧ {loading ? 'Loading…' : shaking ? 'Shaking…' : 'Shake the Jar'}</button><div className="secondary-actions"><button className="secondary-button" onClick={() => open()} disabled={busy}>＋ Add Memory</button><button className="secondary-button" onClick={() => setDrawer(true)}>☷ My Memories <span className="memory-total">{memories.length}</span></button></div></div>{toast && <p className="empty-toast">Add a memory before shaking the jar.</p>}</section></main>
      {error && <p className="error-message global-error" role="alert">{error} <button onClick={() => void loadMemories(token)}>Retry</button></p>}
      {form && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setForm(false) }}><section className="dialog form-dialog" role="dialog" aria-modal="true"><button className="close-button" onClick={() => setForm(false)}>×</button><h2>{editing ? 'Edit memory' : 'Add memory'}</h2><form onSubmit={save}><label htmlFor="memory-text">Memory</label><textarea id="memory-text" required maxLength={2000} value={text} onChange={event => setText(event.target.value)} /><label htmlFor="memory-date">Date</label><input id="memory-date" type="date" required value={date} onChange={event => setDate(event.target.value)} /><button className="primary-button form-submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add memory'}</button></form></section></div>}
      {drawer && <div className="drawer-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setDrawer(false) }}><aside className="memory-drawer" role="dialog" aria-modal="true"><div className="drawer-header"><h2>Memories</h2><button className="close-button drawer-close" onClick={() => setDrawer(false)}>×</button></div>{loading ? <p className="list-empty">Loading memories…</p> : memories.length === 0 ? <div className="list-empty"><p>No memories yet.</p><button onClick={() => { setDrawer(false); open() }}>Add memory</button></div> : <div className="drawer-content"><div className="memory-grid">{memories.map(memory => <article className="memory-card" key={memory.memoryId} style={{ '--paper': memory.color } as React.CSSProperties}><div className="card-top"><time>{fmt(memory.date)}</time><div className="card-actions"><button aria-label="Edit memory" onClick={() => { setDrawer(false); open(memory) }}>Edit</button><button aria-label="Delete memory" onClick={() => setPending(memory)}>Delete</button></div></div><p>{memory.text}</p></article>)}</div></div>}</aside></div>}
      {pending && <div className="modal-backdrop"><section className="dialog confirm-dialog" role="alertdialog" aria-modal="true"><h2>Delete memory?</h2><p>This memory will be permanently deleted.</p><div className="confirm-actions"><button className="cancel-button" onClick={() => setPending(null)}>Cancel</button><button className="delete-button" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete'}</button></div></section></div>}
      {reveal && <div className="modal-backdrop"><section className="dialog reveal-dialog" role="dialog" aria-modal="true"><button className="close-button" onClick={() => setReveal(null)}>×</button><h2>Memory</h2><blockquote>{reveal.text}</blockquote><time>{fmt(reveal.date)}</time><div className="reveal-actions"><button className="primary-button" onClick={() => { setReveal(null); shake() }}>Shake again</button><button className="text-button" onClick={() => setReveal(null)}>Close</button></div></section></div>}
    </>}</div>
}
export default App
