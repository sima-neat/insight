import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultKeymap } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import { cpp } from '@codemirror/lang-cpp'
import { go } from '@codemirror/lang-go'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ELK from 'elkjs/lib/elk.bundled.js'
import yaml from 'js-yaml'

const WORKSPACE_SELECTED_FILE_KEY = 'neat-insight:workspace:selected-file'
const WORKSPACE_FOLDER_KEY = 'neat-insight:workspace:folder'
const WORKSPACE_SIDEBAR_WIDTH_KEY = 'neat-insight:workspace:sidebar-width'
const WORKSPACE_MARKDOWN_MODE_KEY = 'neat-insight:workspace:markdown-mode'
const WORKSPACE_STATS_MODE_KEY = 'neat-insight:workspace:stats-mode'
const WORKSPACE_MPK_MODE_KEY = 'neat-insight:workspace:mpk-mode'
const TEXT_PREVIEW_LIMIT_LABEL = '2 MB'
const DEFAULT_SIDEBAR_WIDTH = 320
const MIN_SIDEBAR_WIDTH = 240
const MAX_SIDEBAR_WIDTH = 640
const elk = new ELK()

async function fetchWorkspaceJson(url) {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`)
  return body
}

function extOf(path = '') {
  const name = path.split('/').pop() || ''
  const parts = name.split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

function prettyBytes(size) {
  if (!Number.isFinite(size)) return '-'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function storedSidebarWidth() {
  const parsed = Number(window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_KEY))
  return Number.isFinite(parsed) ? clamp(parsed, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH) : DEFAULT_SIDEBAR_WIDTH
}

function nodeSortGroup(node) {
  if (node.type === 'folder' && node.kind !== 'archive') return 0
  if (node.kind === 'archive') return 1
  return 2
}

function workspaceRawUrl(path) {
  return `/api/workspace/raw?path=${encodeURIComponent(path)}`
}

function isMlaStatsFile(path = '') {
  const name = ((path.split('::').pop() || path).split('/').pop() || '').toLowerCase()
  return /_mla_stats\.ya?ml$/.test(name)
}

function isMpkManifestFile(path = '') {
  const name = ((path.split('::').pop() || path).split('/').pop() || '').toLowerCase()
  return /_mpk\.json$/.test(name)
}

function formatCycles(value) {
  if (!Number.isFinite(value)) return '-'
  return new Intl.NumberFormat('en-US').format(Math.round(value))
}

function shortOpName(name = '') {
  return name.replace(/^MLA_\d+\//, '')
}

function compactName(name = '') {
  const clean = String(name).replace(/^MLA_\d+\//, 'MLA/')
  if (clean.length <= 46) return clean
  return `${clean.slice(0, 20)}...${clean.slice(-20)}`
}

function formatShape(shape) {
  return Array.isArray(shape) ? shape.join(' x ') : ''
}

function formatNodeSize(size) {
  return Number.isFinite(Number(size)) ? prettyBytes(Number(size)) : ''
}

function safeJsonParse(content = '') {
  const data = JSON.parse(content)
  if (!data || typeof data !== 'object') {
    throw new Error('MPK manifest must be a JSON object.')
  }
  return data
}

function prefixMatchesText(value = '', query = '') {
  const cleanQuery = query.trim().toLowerCase()
  if (!cleanQuery) return false
  const cleanValue = String(value).toLowerCase()
  if (cleanValue.startsWith(cleanQuery)) return true
  return cleanValue
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) => token.startsWith(cleanQuery))
}

function opFamily(name = '') {
  const clean = shortOpName(name).toLowerCase()
  if (clean.includes('conv')) return 'conv'
  if (clean.includes('pool')) return 'pool'
  if (clean.includes('relu')) return 'activation'
  if (clean.includes('concat') || clean.includes('add')) return 'merge'
  if (clean.includes('placeholder')) return 'io'
  return 'other'
}

function parseMlaStats(content = '') {
  const data = yaml.load(content) || {}
  const entries = Array.isArray(data) ? data.map((item, index) => [index, item]) : Object.entries(data)

  return entries
    .map(([idx, item]) => {
      if (!item || typeof item !== 'object') return null
      const startCycle = Number(item.start_cycle)
      const endCycle = Number(item.end_cycle)
      if (!Number.isFinite(startCycle) || !Number.isFinite(endCycle)) return null
      const name = String(item.name || `operator_${idx}`)
      return {
        idx: Number.isFinite(Number(idx)) ? Number(idx) : idx,
        name,
        shortName: shortOpName(name),
        family: opFamily(name),
        startCycle,
        endCycle,
        duration: Math.max(0, endCycle - startCycle)
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.idx) - Number(b.idx))
}

function parseMpkManifest(content = '') {
  const manifest = safeJsonParse(content)
  const plugins = Array.isArray(manifest.plugins)
    ? manifest.plugins
        .map((plugin, index) => ({
          ...plugin,
          sequence: Number.isFinite(Number(plugin.sequence)) ? Number(plugin.sequence) : index + 1,
          input_nodes: Array.isArray(plugin.input_nodes) ? plugin.input_nodes : [],
          output_nodes: Array.isArray(plugin.output_nodes) ? plugin.output_nodes : []
        }))
        .sort((a, b) => a.sequence - b.sequence)
    : []

  if (!plugins.length) {
    throw new Error('No plugins[] entries were found in this MPK manifest.')
  }

  const inputNodes = Array.isArray(manifest.input_nodes) ? manifest.input_nodes : []
  const graphNodes = []
  const graphEdges = []
  const producers = new Map()
  const sourceIds = new Map()
  const consumedOutputs = new Set()
  const processorCounts = new Map()

  const addSource = (input) => {
    const name = String(input?.name || 'input')
    if (sourceIds.has(name)) return sourceIds.get(name)
    const id = `source:${name}`
    sourceIds.set(name, id)
    graphNodes.push({
      id,
      type: 'mpkNode',
      data: {
        kind: 'source',
        title: compactName(name),
        fullName: name,
        processor: 'Input',
        sequence: '',
        subtitle: input?.type || 'buffer',
        size: input?.size,
        inputs: [],
        outputs: [input],
        shapes: [],
        kernel: '',
        executable: '',
        raw: input || { name },
        jsonPath: `input_nodes.${name}`
      }
    })
    return id
  }

  inputNodes.forEach(addSource)

  plugins.forEach((plugin) => {
    const processor = String(plugin.processor || 'Unknown')
    processorCounts.set(processor, (processorCounts.get(processor) || 0) + 1)
    const params = plugin.config_params?.params || {}
    const nodeId = `plugin:${plugin.sequence}:${plugin.name}`
    const shapes = [
      ...(Array.isArray(params.input_shapes) ? params.input_shapes.map((shape) => ({ label: 'in', shape })) : []),
      ...(Array.isArray(params.output_shapes) ? params.output_shapes.map((shape) => ({ label: 'out', shape })) : [])
    ]

    graphNodes.push({
      id: nodeId,
      type: 'mpkNode',
      data: {
        kind: 'plugin',
        title: compactName(plugin.name),
        fullName: String(plugin.name || nodeId),
        processor,
        sequence: plugin.sequence,
        subtitle: plugin.type || 'plugin',
        size: plugin.output_nodes.reduce((sum, output) => sum + (Number(output.size) || 0), 0),
        inputs: plugin.input_nodes,
        outputs: plugin.output_nodes,
        shapes,
        kernel: plugin.config_params?.kernel || params.kernel || '',
        executable: plugin.resources?.executable || '',
        raw: plugin,
        jsonPath: `plugins[${plugin.sequence}]`
      }
    })

    plugin.output_nodes.forEach((output) => {
      if (output?.name && !producers.has(output.name)) {
        producers.set(output.name, { nodeId, output })
      }
    })
  })

  plugins.forEach((plugin) => {
    const target = `plugin:${plugin.sequence}:${plugin.name}`
    plugin.input_nodes.forEach((input, index) => {
      const inputName = String(input?.name || '')
      const producer = producers.get(inputName)
      const source = producer?.nodeId || addSource(input || { name: inputName || `input_${plugin.sequence}_${index}` })
      if (producer) consumedOutputs.add(inputName)
      graphEdges.push({
        id: `edge:${source}->${target}:${inputName || index}`,
        source,
        target,
        label: inputName,
        data: { size: input?.size }
      })
    })
  })

  plugins.forEach((plugin) => {
    const source = `plugin:${plugin.sequence}:${plugin.name}`
    plugin.output_nodes.forEach((output, index) => {
      const outputName = String(output?.name || '')
      if (!outputName || consumedOutputs.has(outputName)) return
      const target = `sink:${outputName}`
      graphNodes.push({
        id: target,
        type: 'mpkNode',
        data: {
          kind: 'sink',
          title: compactName(outputName),
          fullName: outputName,
          processor: 'Output',
          sequence: '',
          subtitle: output?.type || 'buffer',
          size: output?.size,
          inputs: [output],
          outputs: [],
          shapes: [],
          kernel: '',
          executable: '',
          raw: output,
          jsonPath: `output_nodes.${outputName}`
        }
      })
      graphEdges.push({
        id: `edge:${source}->${target}:${outputName || index}`,
        source,
        target,
        label: outputName,
        data: { size: output?.size }
      })
    })
  })

  return {
    manifest,
    nodes: graphNodes,
    edges: graphEdges,
    processors: Array.from(processorCounts.entries()).sort((a, b) => a[0].localeCompare(b[0])),
    pluginCount: plugins.length,
    inputCount: inputNodes.length,
    edgeCount: graphEdges.length
  }
}

function languageFor(path) {
  const ext = extOf(path)
  switch (ext) {
    case 'c':
    case 'cc':
    case 'cpp':
    case 'cu':
    case 'cuh':
    case 'h':
    case 'hh':
    case 'hpp':
      return cpp()
    case 'go':
      return go()
    case 'js':
    case 'jsx':
      return javascript({ jsx: true })
    case 'ts':
    case 'tsx':
      return javascript({ jsx: ext === 'tsx', typescript: true })
    case 'json':
      return json()
    case 'md':
      return markdown()
    case 'py':
      return python()
    default:
      return []
  }
}

const codeTheme = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    color: '#20384f',
    height: '100%',
    fontSize: '13px'
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55'
  },
  '.cm-gutters': {
    backgroundColor: '#f2f6f8',
    borderRight: '1px solid #d9e5ee',
    color: '#7891aa'
  },
  '.cm-activeLine': {
    backgroundColor: '#edf7f5'
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#e3f1ef',
    color: '#2b6965'
  },
  '.cm-selectionBackground': {
    backgroundColor: '#b7d8d5 !important'
  }
})

function CodePreview({ file }) {
  const editorRef = useRef(null)
  const viewRef = useRef(null)

  useEffect(() => {
    if (!editorRef.current) return undefined
    viewRef.current?.destroy()

    const state = EditorState.create({
      doc: file.content || '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle),
        keymap.of([...defaultKeymap, ...searchKeymap]),
        languageFor(file.path),
        codeTheme,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping
      ]
    })

    viewRef.current = new EditorView({
      state,
      parent: editorRef.current
    })

    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [file.path, file.content])

  const handleWheel = (event) => {
    const scroller = viewRef.current?.scrollDOM
    if (!scroller) return

    const maxTop = scroller.scrollHeight - scroller.clientHeight
    const maxLeft = scroller.scrollWidth - scroller.clientWidth
    if (maxTop <= 0 && maxLeft <= 0) return

    event.preventDefault()
    event.stopPropagation()
    scroller.scrollTop += event.deltaY
    scroller.scrollLeft += event.deltaX
  }

  return (
    <div className="workspace-code-shell" onWheel={handleWheel}>
      {file.truncated && (
        <div className="workspace-preview-warning">
          Preview limited to the first {TEXT_PREVIEW_LIMIT_LABEL}.
        </div>
      )}
      <div ref={editorRef} className="workspace-code-viewer" />
    </div>
  )
}

function MarkdownPreview({ file, mode }) {
  if (mode === 'raw') return <CodePreview file={file} />

  return (
    <div className="workspace-markdown-shell">
      {file.truncated && (
        <div className="workspace-preview-warning">
          Preview limited to the first {TEXT_PREVIEW_LIMIT_LABEL}.
        </div>
      )}
      <article className="workspace-markdown-preview">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            img({ src = '', alt = '' }) {
              if (/^https?:\/\//i.test(src)) {
                return <span className="workspace-markdown-image-note">Remote image omitted: {alt || src}</span>
              }
              return <img src={src} alt={alt} />
            }
          }}
        >
          {file.content || ''}
        </ReactMarkdown>
      </article>
    </div>
  )
}

function ImagePreview({ file }) {
  const viewportRef = useRef(null)
  const [zoom, setZoom] = useState(1)
  const [naturalSize, setNaturalSize] = useState(null)

  useEffect(() => {
    setZoom(1)
    setNaturalSize(null)
  }, [file.path])

  const setClampedZoom = (value) => setZoom(clamp(value, 0.1, 6))

  const fitImage = (size = naturalSize) => {
    const viewport = viewportRef.current
    if (!viewport || !size?.width || !size?.height) {
      setClampedZoom(1)
      return
    }

    const availableWidth = Math.max(viewport.clientWidth - 48, 120)
    const availableHeight = Math.max(viewport.clientHeight - 48, 120)
    setClampedZoom(Math.min(1, availableWidth / size.width, availableHeight / size.height))
  }

  const handleImageLoad = (event) => {
    const size = {
      width: event.currentTarget.naturalWidth,
      height: event.currentTarget.naturalHeight
    }
    setNaturalSize(size)
    fitImage(size)
  }

  const zoomPercent = Math.round(zoom * 100)
  const imageStyle = naturalSize
    ? {
        width: `${naturalSize.width * zoom}px`,
        height: `${naturalSize.height * zoom}px`
      }
    : undefined
  const canvasStyle = naturalSize
    ? {
        width: `max(100%, ${naturalSize.width * zoom + 48}px)`,
        height: `max(100%, ${naturalSize.height * zoom + 48}px)`
      }
    : undefined

  return (
    <div className="workspace-image-shell">
      <div className="workspace-image-toolbar">
        <div className="workspace-image-meta">
          {naturalSize ? `${naturalSize.width} x ${naturalSize.height}px` : 'Loading image...'}
        </div>
        <div className="workspace-image-controls" aria-label="Image zoom controls">
          <button type="button" onClick={() => setClampedZoom(zoom - 0.1)} aria-label="Zoom out">-</button>
          <input
            type="range"
            min="10"
            max="600"
            step="10"
            value={zoomPercent}
            onChange={(event) => setClampedZoom(Number(event.target.value) / 100)}
            aria-label="Image zoom"
          />
          <button type="button" onClick={() => setClampedZoom(zoom + 0.1)} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => fitImage()}>Fit</button>
          <button type="button" onClick={() => setClampedZoom(1)}>100%</button>
          <span>{zoomPercent}%</span>
        </div>
      </div>
      <div ref={viewportRef} className="workspace-image-viewport">
        <div className="workspace-image-canvas" style={canvasStyle}>
          <img
            src={workspaceRawUrl(file.path)}
            alt={file.name}
            className="workspace-image-preview"
            style={imageStyle}
            onLoad={handleImageLoad}
          />
        </div>
      </div>
    </div>
  )
}

function MlaStatsPreview({ file, mode }) {
  const [view, setView] = useState('timeline')
  const [search, setSearch] = useState('')
  const [threshold, setThreshold] = useState(0)

  useEffect(() => {
    setThreshold(0)
    setSearch('')
    setView('timeline')
  }, [file.path])

  const parsed = useMemo(() => {
    try {
      const ops = parseMlaStats(file.content || '')
      const starts = ops.map((op) => op.startCycle)
      const ends = ops.map((op) => op.endCycle)
      const minStart = starts.length ? Math.min(...starts) : 0
      const maxEnd = ends.length ? Math.max(...ends) : 0
      const totalCycles = Math.max(0, maxEnd - minStart)
      const maxDuration = ops.length ? Math.max(...ops.map((op) => op.duration)) : 0
      const criticalOp = ops.reduce((best, op) => (op.duration > (best?.duration || -1) ? op : best), null)
      const avgDuration = ops.length ? ops.reduce((sum, op) => sum + op.duration, 0) / ops.length : 0
      return { ops, minStart, maxEnd, totalCycles, maxDuration, criticalOp, avgDuration, error: '' }
    } catch (err) {
      return { ops: [], minStart: 0, maxEnd: 0, totalCycles: 0, maxDuration: 0, criticalOp: null, avgDuration: 0, error: err.message }
    }
  }, [file.content])

  if (mode === 'code') return <CodePreview file={file} />

  if (parsed.error) {
    return (
      <div className="workspace-placeholder">
        <h3>Stats preview</h3>
        <p>{parsed.error}</p>
      </div>
    )
  }

  if (!parsed.ops.length) {
    return (
      <div className="workspace-placeholder">
        <h3>Stats preview</h3>
        <p>No MLA operator statistics were found in this file.</p>
      </div>
    )
  }

  const cleanSearch = search.trim().toLowerCase()
  const filteredOps = parsed.ops.filter((op) => {
    const matchesSearch = !cleanSearch || op.name.toLowerCase().includes(cleanSearch)
    return matchesSearch && op.duration >= threshold
  })
  const durationOps = filteredOps.slice().sort((a, b) => b.duration - a.duration)
  const visibleOps = view === 'duration' ? durationOps : filteredOps
  const timelineRange = Math.max(1, parsed.maxEnd - parsed.minStart)
  const maxDuration = Math.max(1, parsed.maxDuration)

  return (
    <div className="workspace-stats-shell">
      {file.truncated && (
        <div className="workspace-preview-warning">
          Preview limited to the first {TEXT_PREVIEW_LIMIT_LABEL}.
        </div>
      )}

      <div className="workspace-stats-toolbar">
        <div className="workspace-stats-summary">
          <div className="workspace-stats-metric">
            <span>Operators</span>
            <strong>{parsed.ops.length}</strong>
          </div>
          <div className="workspace-stats-metric">
            <span>Total cycles</span>
            <strong>{formatCycles(parsed.totalCycles)}</strong>
          </div>
          <div className="workspace-stats-metric">
            <span>Critical op</span>
            <strong title={parsed.criticalOp?.name}>{parsed.criticalOp?.shortName || '-'}</strong>
          </div>
          <div className="workspace-stats-metric">
            <span>Avg duration</span>
            <strong>{formatCycles(parsed.avgDuration)}</strong>
          </div>
        </div>

        <div className="workspace-stats-controls">
          <input
            className="search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter operators..."
          />
          <label className="workspace-stats-threshold">
            <span>Min cycles {formatCycles(threshold)}</span>
            <input
              type="range"
              min="0"
              max={Math.max(0, parsed.maxDuration)}
              step={Math.max(1, Math.round(parsed.maxDuration / 100))}
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
            />
          </label>
          <div className="workspace-segmented" aria-label="MLA stats view">
            <button type="button" className={view === 'timeline' ? 'active' : ''} onClick={() => setView('timeline')}>
              Timeline
            </button>
            <button type="button" className={view === 'duration' ? 'active' : ''} onClick={() => setView('duration')}>
              Duration
            </button>
            <button type="button" className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>
              Table
            </button>
          </div>
        </div>
      </div>

      <div className="workspace-stats-body">
        {visibleOps.length === 0 ? (
          <div className="workspace-stats-empty">No operators match the current filter.</div>
        ) : view === 'table' ? (
          <table className="workspace-stats-table">
            <thead>
              <tr>
                <th>Idx</th>
                <th>Operator</th>
                <th>Start</th>
                <th>End</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {visibleOps.map((op) => (
                <tr key={`${op.idx}:${op.name}`}>
                  <td>{op.idx}</td>
                  <td title={op.name}>{op.shortName}</td>
                  <td>{formatCycles(op.startCycle)}</td>
                  <td>{formatCycles(op.endCycle)}</td>
                  <td>{formatCycles(op.duration)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className={view === 'duration' ? 'workspace-duration-list' : 'workspace-timeline'}>
            {visibleOps.map((op) => {
              const startPct = ((op.startCycle - parsed.minStart) / timelineRange) * 100
              const widthPct = Math.max(0.35, (op.duration / timelineRange) * 100)
              const durationPct = Math.max(0.5, (op.duration / maxDuration) * 100)
              const style = view === 'duration'
                ? { '--duration-width': `${durationPct}%` }
                : { '--bar-left': `${startPct}%`, '--bar-width': `${widthPct}%` }
              return (
                <div className={`workspace-stats-row ${op.family}`} key={`${op.idx}:${op.name}`}>
                  <div className="workspace-stats-row-label">
                    <span title={op.name}>{op.shortName}</span>
                    <em>#{op.idx}</em>
                  </div>
                  <div className="workspace-stats-row-track" style={style} title={`${op.name}: ${formatCycles(op.duration)} cycles`}>
                    <span />
                  </div>
                  <div className="workspace-stats-row-value">{formatCycles(op.duration)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function MpkGraphNode({ data }) {
  const isPlugin = data.kind === 'plugin'
  const hasTarget = data.kind !== 'source'
  const hasSource = data.kind !== 'sink'
  const shapeText = data.shapes?.slice(0, 2).map((item) => `${item.label} ${formatShape(item.shape)}`).join('  ')
  const ioText = `${data.inputs?.length || 0} in / ${data.outputs?.length || 0} out`

  return (
    <div className={`workspace-mpk-node ${data.kind} ${String(data.processor || '').toLowerCase()} ${data.highlighted ? 'highlighted' : ''}`}>
      {hasTarget && <Handle type="target" position={Position.Left} />}
      <div className="workspace-mpk-node-top">
        <span className="workspace-mpk-sequence">{isPlugin ? `#${data.sequence}` : data.processor}</span>
        <span className="workspace-mpk-processor">{data.processor}</span>
      </div>
      <div className="workspace-mpk-node-title" title={data.fullName}>{data.title}</div>
      <div className="workspace-mpk-node-subtitle">
        <span>{data.subtitle}</span>
        {formatNodeSize(data.size) && <span>{formatNodeSize(data.size)}</span>}
      </div>
      {isPlugin && (
        <div className="workspace-mpk-node-meta">
          <span>{data.kernel || 'no kernel'}</span>
          <span>{ioText}</span>
        </div>
      )}
      {shapeText && <div className="workspace-mpk-node-shapes" title={shapeText}>{shapeText}</div>}
      {data.executable && <div className="workspace-mpk-node-exe" title={data.executable}>{data.executable}</div>}
      {hasSource && <Handle type="source" position={Position.Right} />}
    </div>
  )
}

const mpkNodeTypes = { mpkNode: MpkGraphNode }

function MpkGraphCanvas({ nodes, edges, showEdgeLabels, fitNonce, onNodeInspect }) {
  const { fitView } = useReactFlow()
  const [layoutNodes, setLayoutNodes] = useState([])
  const [layoutEdges, setLayoutEdges] = useState([])

  useEffect(() => {
    let cancelled = false

    const layout = async () => {
      const graph = {
        id: 'mpk-root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.layered.spacing.nodeNodeBetweenLayers': '84',
          'elk.spacing.nodeNode': '34'
        },
        children: nodes.map((node) => ({
          id: node.id,
          width: node.data.kind === 'plugin' ? 286 : 230,
          height: node.data.kind === 'plugin' ? 150 : 106
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target]
        }))
      }

      try {
        const result = await elk.layout(graph)
        if (cancelled) return
        const positions = new Map((result.children || []).map((node) => [node.id, node]))
        setLayoutNodes(nodes.map((node) => {
          const position = positions.get(node.id)
          return {
            ...node,
            position: { x: position?.x || 0, y: position?.y || 0 }
          }
        }))
        setLayoutEdges(edges.map((edge) => ({
          ...edge,
          label: showEdgeLabels ? edge.label : '',
          markerEnd: { type: MarkerType.ArrowClosed },
          type: 'smoothstep'
        })))
      } catch {
        if (cancelled) return
        setLayoutNodes(nodes.map((node, index) => ({
          ...node,
          position: { x: (index % 4) * 320, y: Math.floor(index / 4) * 190 }
        })))
        setLayoutEdges(edges)
      }
    }

    layout()
    return () => {
      cancelled = true
    }
  }, [nodes, edges, showEdgeLabels])

  useEffect(() => {
    if (!layoutNodes.length) return
    window.requestAnimationFrame(() => fitView({ padding: 0.18, duration: 240 }))
  }, [layoutNodes, fitNonce, fitView])

  return (
    <ReactFlow
      nodes={layoutNodes}
      edges={layoutEdges}
      nodeTypes={mpkNodeTypes}
      nodesConnectable={false}
      onNodeClick={(_, node) => onNodeInspect?.(node)}
      fitView
      minZoom={0.08}
      maxZoom={1.6}
    >
      <Background color="#d7e2ec" gap={22} />
      <MiniMap pannable zoomable nodeStrokeWidth={2} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

function MpkJsonModal({ node, onClose }) {
  if (!node) return null

  const jsonText = JSON.stringify(node.data.raw || {}, null, 2)

  return (
    <div className="workspace-json-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="workspace-json-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Node JSON"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workspace-json-modal-header">
          <div>
            <p>{node.data.jsonPath || node.data.kind}</p>
            <h3 title={node.data.fullName}>{node.data.fullName}</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="Close JSON preview">Close</button>
        </header>
        <pre className="workspace-json-modal-code">{jsonText}</pre>
      </section>
    </div>
  )
}

function MpkManifestPreview({ file, mode }) {
  const [processorFilter, setProcessorFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [showEdgeLabels, setShowEdgeLabels] = useState(true)
  const [fitNonce, setFitNonce] = useState(0)
  const [inspectNode, setInspectNode] = useState(null)

  useEffect(() => {
    setProcessorFilter('all')
    setSearch('')
    setShowEdgeLabels(true)
    setInspectNode(null)
    setFitNonce((value) => value + 1)
  }, [file.path])

  const parsed = useMemo(() => {
    try {
      return { ...parseMpkManifest(file.content || ''), error: '' }
    } catch (err) {
      return { manifest: {}, nodes: [], edges: [], processors: [], pluginCount: 0, inputCount: 0, edgeCount: 0, error: err.message }
    }
  }, [file.content])

  const graph = useMemo(() => {
    const cleanSearch = search.trim().toLowerCase()
    const visiblePluginIds = new Set(parsed.nodes
      .filter((node) => node.data.kind === 'plugin' && (processorFilter === 'all' || node.data.processor === processorFilter))
      .map((node) => node.id))
    const connectedIoIds = new Set()
    const visibleEdges = parsed.edges.filter((edge) => {
      const sourceIsPlugin = edge.source.startsWith('plugin:')
      const targetIsPlugin = edge.target.startsWith('plugin:')
      const sourceVisible = visiblePluginIds.has(edge.source)
      const targetVisible = visiblePluginIds.has(edge.target)
      const keep = (sourceIsPlugin && sourceVisible && !targetIsPlugin) ||
        (targetIsPlugin && targetVisible && !sourceIsPlugin) ||
        (sourceVisible && targetVisible)
      if (keep) {
        if (!sourceIsPlugin) connectedIoIds.add(edge.source)
        if (!targetIsPlugin) connectedIoIds.add(edge.target)
      }
      return keep
    })

    const highlightIds = new Set()
    if (cleanSearch) {
      parsed.nodes.forEach((node) => {
        const fields = [
          node.data.fullName,
          node.data.processor,
          node.data.kernel,
          node.data.executable,
          node.data.subtitle
        ].filter(Boolean)
        if (fields.some((field) => prefixMatchesText(field, cleanSearch))) highlightIds.add(node.id)
      })
      visibleEdges.forEach((edge) => {
        if (prefixMatchesText(edge.label || '', cleanSearch)) {
          highlightIds.add(edge.source)
          highlightIds.add(edge.target)
        }
      })
    }

    const visibleIds = new Set([...visiblePluginIds, ...connectedIoIds])
    const visibleNodes = parsed.nodes
      .filter((node) => visibleIds.has(node.id))
      .map((node) => ({
        ...node,
        data: {
          ...node.data,
          highlighted: cleanSearch ? highlightIds.has(node.id) : false
        }
      }))

    return { nodes: visibleNodes, edges: visibleEdges }
  }, [parsed.nodes, parsed.edges, processorFilter, search])

  if (mode === 'code') return <CodePreview file={file} />

  if (parsed.error) {
    return (
      <div className="workspace-placeholder">
        <h3>MPK graph preview</h3>
        <p>{parsed.error}</p>
      </div>
    )
  }

  const modelName = parsed.manifest.name || file.name
  const mlaCount = parsed.processors.find(([name]) => name === 'MLA')?.[1] || 0
  const evCount = parsed.processors.filter(([name]) => name !== 'MLA').reduce((sum, [, count]) => sum + count, 0)

  return (
    <div className="workspace-mpk-shell">
      {file.truncated && (
        <div className="workspace-preview-warning">
          Preview limited to the first {TEXT_PREVIEW_LIMIT_LABEL}.
        </div>
      )}

      <div className="workspace-mpk-toolbar">
        <div className="workspace-mpk-summary">
          <div className="workspace-stats-metric">
            <span>Model</span>
            <strong title={modelName}>{modelName}</strong>
          </div>
          <div className="workspace-stats-metric">
            <span>Plugins</span>
            <strong>{parsed.pluginCount}</strong>
          </div>
          <div className="workspace-stats-metric">
            <span>MLA stages</span>
            <strong>{mlaCount}</strong>
          </div>
          <div className="workspace-stats-metric">
            <span>EV stages</span>
            <strong>{evCount}</strong>
          </div>
        </div>

        <div className="workspace-mpk-controls">
          <input
            className="search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Highlight node, kernel, buffer..."
          />
          <select value={processorFilter} onChange={(event) => setProcessorFilter(event.target.value)} aria-label="Processor filter">
            <option value="all">All processors</option>
            {parsed.processors.map(([processor, count]) => (
              <option key={processor} value={processor}>{processor} ({count})</option>
            ))}
          </select>
          <button type="button" className="btn-ghost workspace-mpk-fit" onClick={() => setFitNonce((value) => value + 1)}>
            Fit
          </button>
          <label className="workspace-mpk-toggle">
            <input
              type="checkbox"
              checked={showEdgeLabels}
              onChange={(event) => setShowEdgeLabels(event.target.checked)}
            />
            <span>Buffers</span>
          </label>
        </div>
      </div>

      <div className="workspace-mpk-canvas">
        <ReactFlowProvider>
          <MpkGraphCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            showEdgeLabels={showEdgeLabels}
            fitNonce={fitNonce}
            onNodeInspect={setInspectNode}
          />
        </ReactFlowProvider>
      </div>
      <MpkJsonModal node={inspectNode} onClose={() => setInspectNode(null)} />
    </div>
  )
}

function PlaceholderPreview({ file }) {
  const copy = {
    model: 'Model visualization is reserved for the model preview plugin.',
    executable: 'Executable run support is not enabled in this version.',
    binary: 'Binary preview is unavailable for this file type.'
  }

  return (
    <div className="workspace-placeholder">
      <h3>{file.kind || 'file'} preview</h3>
      <p>{copy[file.kind] || 'No previewer is registered for this file type.'}</p>
    </div>
  )
}

function FilePreview({ file, loading, markdownMode, statsMode, mpkMode }) {
  if (loading) return <div className="workspace-placeholder">Loading preview...</div>
  if (!file) return <div className="workspace-placeholder">Select a file to preview.</div>
  if (file.kind === 'image') return <ImagePreview file={file} />
  if (file.previewAvailable && (file.kind === 'code' || file.kind === 'text')) {
    if (isMpkManifestFile(file.path)) return <MpkManifestPreview file={file} mode={mpkMode} />
    if (isMlaStatsFile(file.path)) return <MlaStatsPreview file={file} mode={statsMode} />
    if (extOf(file.path) === 'md') return <MarkdownPreview file={file} mode={markdownMode} />
    return <CodePreview file={file} />
  }
  return <PlaceholderPreview file={file} />
}

function Breadcrumb({ path, onOpen }) {
  let crumbs = []
  if (path.includes('::')) {
    const [archivePath, memberPath = ''] = path.split('::')
    crumbs.push({ name: archivePath.split('/').pop() || archivePath, path: archivePath })
    const memberParts = memberPath.split('/').filter(Boolean)
    crumbs = crumbs.concat(memberParts.map((part, index) => ({
      name: part,
      path: `${archivePath}::${memberParts.slice(0, index + 1).join('/')}`
    })))
  } else {
    const parts = path ? path.split('/').filter(Boolean) : []
    crumbs = parts.map((part, index) => ({
      name: part,
      path: parts.slice(0, index + 1).join('/')
    }))
  }

  return (
    <div className="workspace-breadcrumb">
      <button type="button" onClick={() => onOpen('')}>root</button>
      {crumbs.map((crumb) => (
        <button type="button" key={crumb.path} onClick={() => onOpen(crumb.path)}>
          {crumb.name}
        </button>
      ))}
    </div>
  )
}

export default function WorkspaceView({ onError, onStatus }) {
  const layoutRef = useRef(null)
  const [root, setRoot] = useState(null)
  const [folder, setFolder] = useState(() => window.localStorage.getItem(WORKSPACE_FOLDER_KEY) || '')
  const [children, setChildren] = useState([])
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState([])
  const [selectedPath, setSelectedPath] = useState(() => window.localStorage.getItem(WORKSPACE_SELECTED_FILE_KEY) || '')
  const [selectedFile, setSelectedFile] = useState(null)
  const [treeLoading, setTreeLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth)
  const [markdownMode, setMarkdownMode] = useState(() => window.localStorage.getItem(WORKSPACE_MARKDOWN_MODE_KEY) || 'preview')
  const [statsMode, setStatsMode] = useState(() => window.localStorage.getItem(WORKSPACE_STATS_MODE_KEY) || 'visual')
  const [mpkMode, setMpkMode] = useState(() => window.localStorage.getItem(WORKSPACE_MPK_MODE_KEY) || 'visual')

  const sortedChildren = useMemo(
    () => children.slice().sort((a, b) => nodeSortGroup(a) - nodeSortGroup(b) || a.name.localeCompare(b.name)),
    [children]
  )

  useEffect(() => {
    fetchWorkspaceJson('/api/workspace/root')
      .then(setRoot)
      .catch((err) => onError(err.message))
  }, [onError])

  useEffect(() => {
    let cancelled = false
    setTreeLoading(true)
    fetchWorkspaceJson(`/api/workspace/tree?path=${encodeURIComponent(folder)}`)
      .then((data) => {
        if (cancelled) return
        setChildren(data.children || [])
        window.localStorage.setItem(WORKSPACE_FOLDER_KEY, data.path || '')
      })
      .catch((err) => {
        if (cancelled) return
        onError(err.message)
        setFolder('')
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [folder, onError])

  useEffect(() => {
    const cleanQuery = query.trim()
    if (!cleanQuery) {
      setMatches([])
      return undefined
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      fetchWorkspaceJson(`/api/workspace/search?q=${encodeURIComponent(cleanQuery)}`)
        .then((data) => {
          if (!cancelled) setMatches(data.matches || [])
        })
        .catch((err) => {
          if (!cancelled) onError(err.message)
        })
    }, 160)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, onError])

  useEffect(() => {
    if (!selectedPath) {
      setSelectedFile(null)
      return undefined
    }

    let cancelled = false
    setPreviewLoading(true)
    fetchWorkspaceJson(`/api/workspace/file?path=${encodeURIComponent(selectedPath)}`)
      .then((data) => {
        if (cancelled) return
        setSelectedFile(data)
        window.localStorage.setItem(WORKSPACE_SELECTED_FILE_KEY, data.path)
      })
      .catch((err) => {
        if (cancelled) return
        onError(err.message)
        window.localStorage.removeItem(WORKSPACE_SELECTED_FILE_KEY)
        setSelectedPath('')
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedPath, onError])

  const openFolder = (path) => {
    setFolder(path || '')
    setQuery('')
  }

  const openFile = (node) => {
    setSelectedPath(node.path)
    onStatus(`Opened ${node.path}`)
  }

  const setAndStoreSidebarWidth = (value) => {
    const layoutWidth = layoutRef.current?.getBoundingClientRect().width || MAX_SIDEBAR_WIDTH + 420
    const maxWidth = clamp(layoutWidth - 420, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
    const nextWidth = clamp(value, MIN_SIDEBAR_WIDTH, maxWidth)
    setSidebarWidth(nextWidth)
    window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_KEY, String(nextWidth))
  }

  const startSidebarResize = (event) => {
    if (!layoutRef.current) return
    event.preventDefault()
    document.body.classList.add('workspace-resizing')

    const resizeToPointer = (pointerEvent) => {
      const rect = layoutRef.current?.getBoundingClientRect()
      if (!rect) return
      setAndStoreSidebarWidth(pointerEvent.clientX - rect.left)
    }

    const stopResize = () => {
      document.body.classList.remove('workspace-resizing')
      window.removeEventListener('pointermove', resizeToPointer)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    window.addEventListener('pointermove', resizeToPointer)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
  }

  const handleResizeKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setAndStoreSidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 24 : -24))
  }

  const setAndStoreMarkdownMode = (mode) => {
    setMarkdownMode(mode)
    window.localStorage.setItem(WORKSPACE_MARKDOWN_MODE_KEY, mode)
  }

  const setAndStoreStatsMode = (mode) => {
    setStatsMode(mode)
    window.localStorage.setItem(WORKSPACE_STATS_MODE_KEY, mode)
  }

  const setAndStoreMpkMode = (mode) => {
    setMpkMode(mode)
    window.localStorage.setItem(WORKSPACE_MPK_MODE_KEY, mode)
  }

  const renderNode = (node, context = 'tree') => (
    <button
      key={`${context}:${node.path}`}
      type="button"
      className={node.path === selectedPath ? 'workspace-node active' : 'workspace-node'}
      onClick={() => (node.type === 'folder' ? openFolder(node.path) : openFile(node))}
    >
      <span className={`workspace-node-icon ${node.kind === 'archive' ? 'archive' : node.type === 'folder' ? 'folder' : node.kind}`} aria-hidden="true" />
      <span className="workspace-node-main">
        <span className="workspace-node-name">{context === 'search' ? node.path : node.name}</span>
        {node.type === 'file' && (
          <span className="workspace-node-meta">
            {node.kind} · {prettyBytes(node.size)}
          </span>
        )}
      </span>
    </button>
  )

  const activeList = query.trim() ? matches : sortedChildren
  const selectedIsMarkdown = selectedFile?.previewAvailable && extOf(selectedFile.path) === 'md'
  const selectedIsMlaStats = selectedFile?.previewAvailable && isMlaStatsFile(selectedFile.path)
  const selectedIsMpkManifest = selectedFile?.previewAvailable && isMpkManifestFile(selectedFile.path)

  return (
    <section className="panel workspace-panel">
      <div className="panel-topbar">
        <div>
          <h2>Workspace</h2>
          <p className="section-note">{root?.path || 'Resolving workspace root...'}</p>
        </div>
      </div>

      <div
        ref={layoutRef}
        className="workspace-layout"
        style={{ '--workspace-sidebar-width': `${sidebarWidth}px` }}
      >
        <aside className="workspace-sidebar">
          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files by name..."
          />
          <Breadcrumb path={folder} onOpen={openFolder} />

          <div className="workspace-list">
            {treeLoading && !query.trim() && <div className="workspace-empty">Loading folder...</div>}
            {!treeLoading && activeList.map((node) => renderNode(node, query.trim() ? 'search' : 'tree'))}
            {!treeLoading && activeList.length === 0 && (
              <div className="workspace-empty">
                {query.trim() ? 'No matching files.' : 'No files in this folder.'}
              </div>
            )}
          </div>
        </aside>

        <div
          className="workspace-resize-handle"
          role="separator"
          aria-label="Resize file explorer"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onKeyDown={handleResizeKeyDown}
        />

        <div className="workspace-preview">
          <header className="workspace-preview-header">
            <div>
              <h3>{selectedFile?.name || 'No file selected'}</h3>
              <p>{selectedFile?.path || 'Choose a source file from the workspace.'}</p>
            </div>
            <div className="workspace-preview-actions">
              {selectedIsMpkManifest && (
                <div className="workspace-segmented" aria-label="MPK manifest preview mode">
                  <button
                    type="button"
                    className={mpkMode === 'visual' ? 'active' : ''}
                    onClick={() => setAndStoreMpkMode('visual')}
                  >
                    Visual
                  </button>
                  <button
                    type="button"
                    className={mpkMode === 'code' ? 'active' : ''}
                    onClick={() => setAndStoreMpkMode('code')}
                  >
                    Raw
                  </button>
                </div>
              )}
              {!selectedIsMpkManifest && selectedIsMlaStats && (
                <div className="workspace-segmented" aria-label="MLA stats preview mode">
                  <button
                    type="button"
                    className={statsMode === 'visual' ? 'active' : ''}
                    onClick={() => setAndStoreStatsMode('visual')}
                  >
                    Visual
                  </button>
                  <button
                    type="button"
                    className={statsMode === 'code' ? 'active' : ''}
                    onClick={() => setAndStoreStatsMode('code')}
                  >
                    Raw
                  </button>
                </div>
              )}
              {!selectedIsMpkManifest && !selectedIsMlaStats && selectedIsMarkdown && (
                <div className="workspace-segmented" aria-label="Markdown preview mode">
                  <button
                    type="button"
                    className={markdownMode === 'preview' ? 'active' : ''}
                    onClick={() => setAndStoreMarkdownMode('preview')}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    className={markdownMode === 'raw' ? 'active' : ''}
                    onClick={() => setAndStoreMarkdownMode('raw')}
                  >
                    Raw
                  </button>
                </div>
              )}
              {selectedFile && <span className="workspace-kind">{selectedFile.kind}</span>}
            </div>
          </header>
          <FilePreview
            file={selectedFile}
            loading={previewLoading}
            markdownMode={markdownMode}
            statsMode={statsMode}
            mpkMode={mpkMode}
          />
        </div>
      </div>
    </section>
  )
}
