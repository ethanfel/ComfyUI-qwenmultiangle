import { createApp, type App as VueApp } from 'vue'

const { app } = window.comfyAPI.app
const { api } = window.comfyAPI.api

import App from './App.vue'
import { seededAngles } from './seededAngles'
import type { CameraState, AppExposed, QwenMultiangleNode } from './types'

// Inject CSS from built assets
;(() => {
  const cssUrl = new URL(/* @vite-ignore */ './assets/main.css', import.meta.url).href
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = cssUrl
  document.head.appendChild(link)
})()

interface QwenInstance {
  container: HTMLElement
  vueApp: VueApp
  exposed: AppExposed
  currentNode: QwenMultiangleNode
  widget: DOMWidgetInstance | null
  cleanupTimer: number | null
  widthObserver: ResizeObserver | null
  gridObserver: ResizeObserver | null
  enforcingWidth: boolean
  // Smallest (node.size[0] - container width) ever seen, i.e. the widget's true
  // horizontal margin in node-logical px, learned from uncollapsed samples.
  marginLogical: number
}

// Keyed by the node object itself. node.id cannot be used: ComfyUI fires
// nodeCreated from inside the LGraphNode constructor, BEFORE graph.add()
// assigns a real id, so every freshly-created node arrives here with the
// LiteGraph default id (-1). A Map keyed on -1 would let the second new
// node hit the first node's entry and steal its container DOM via
// addDOMWidget, wiping the first node's three.js view.
const instances = new WeakMap<QwenMultiangleNode, QwenInstance>()

const CLEANUP_DELAY_MS = 200

// Store the scene state on node.properties as well as on widgets. Properties
// are deserialised by LGraphNode.configure before widgets and survive reloads
// independently, so when the widget-sync timing is unreliable the property
// remains authoritative.
const PROP_KEY = 'qwenCameraState'

interface StoredCameraState {
  azimuth: number
  elevation: number
  distance: number
  cameraView: boolean
}

function getWidgetValue(
  node: QwenMultiangleNode,
  name: string,
  defaultValue: number
): number {
  const widget = node.widgets?.find(w => w.name === name)
  return widget ? Number(widget.value) : defaultValue
}

function readStoredProps(node: QwenMultiangleNode): Partial<StoredCameraState> | null {
  const raw = node.properties?.[PROP_KEY]
  if (!raw || typeof raw !== 'object') return null
  return raw as Partial<StoredCameraState>
}

function writeStoredProps(
  node: QwenMultiangleNode,
  patch: Partial<StoredCameraState>
): void {
  if (!node.properties) node.properties = {}
  const existing = (node.properties[PROP_KEY] as Partial<StoredCameraState>) ?? {}
  node.properties[PROP_KEY] = { ...existing, ...patch }
}

function readStateFromNode(node: QwenMultiangleNode): Partial<CameraState> {
  const stored = readStoredProps(node)
  return {
    azimuth: stored?.azimuth ?? getWidgetValue(node, 'horizontal_angle', 0),
    elevation: stored?.elevation ?? getWidgetValue(node, 'vertical_angle', 0),
    distance: stored?.distance ?? getWidgetValue(node, 'zoom', 5.0)
  }
}

function readCameraViewFromNode(node: QwenMultiangleNode): boolean {
  const stored = readStoredProps(node)
  if (stored?.cameraView !== undefined) return Boolean(stored.cameraView)
  const w = node.widgets?.find(w => w.name === 'camera_view')
  return Boolean(w?.value)
}

function syncWidgetsFromState(
  node: QwenMultiangleNode,
  state: Partial<StoredCameraState>
): void {
  const h = node.widgets?.find(w => w.name === 'horizontal_angle')
  const v = node.widgets?.find(w => w.name === 'vertical_angle')
  const z = node.widgets?.find(w => w.name === 'zoom')
  const cv = node.widgets?.find(w => w.name === 'camera_view')
  if (state.azimuth !== undefined && h) h.value = state.azimuth
  if (state.elevation !== undefined && v) v.value = state.elevation
  if (state.distance !== undefined && z) z.value = state.distance
  if (state.cameraView !== undefined && cv) cv.value = state.cameraView
}

// A ComfyUI-wide bug collapses DOM-widget elements to ~half width when the node
// is selected or re-laid-out: the standard widgets stay full width, but our
// addDOMWidget container shrinks, squashing the three.js view into the left half
// of the node. Same idea as the FoleyTune timeline hack — measure how wide a
// sibling widget that stayed full width is, then force our container back to it.
//
// FoleyTune reads widget.inputEl/element off the litegraph widgets, which works
// in the classic canvas frontend (its textarea widgets own a DOM element). The
// new Vue node frontend (vueNodes) does NOT expose widget.element for plain
// number/boolean widgets, so that path finds nothing and falls through to the
// already-collapsed parent — which is why the straight port did nothing here.
// So in vueNodes we measure the rendered DOM directly: every widget row lives in
// [data-testid="node-widgets"] and its control element is the row's last child,
// laid out in the same grid columns our widget should fill.
const WIDGET_DEBUG = (() => {
  try { return localStorage.getItem('qwenWidgetDebug') === '1' } catch { return false }
})()

const WIDGETS_GRID_SEL = '[data-testid="node-widgets"], .lg-node-widgets'
const WIDGET_ROW_SEL = '[data-testid="node-widget"], .lg-node-widget'

function findWidgetsGrid(container: HTMLElement): HTMLElement | null {
  return container.closest(WIDGETS_GRID_SEL)
}

function referenceWidthFromDom(container: HTMLElement): number {
  const grid = findWidgetsGrid(container)
  if (!grid) return 0
  let w = 0
  for (const row of Array.from(grid.querySelectorAll(WIDGET_ROW_SEL))) {
    if (row.contains(container)) continue
    // The control spans the label+value columns; it is the row's last element.
    const control = row.lastElementChild as HTMLElement | null
    const cw = control?.clientWidth ?? 0
    if (cw > w) w = cw
  }
  // No measurable sibling row — fall back to the full grid minus the dot column.
  if (!w && grid.clientWidth > 0) {
    const dot = grid.querySelector(`${WIDGET_ROW_SEL.split(',')[0]} > :first-child`) as HTMLElement | null
    w = grid.clientWidth - (dot?.offsetWidth ?? 0)
  }
  return w
}

// Classic canvas renderer: there is no Vue widgets grid, and the sibling number/
// boolean widgets are canvas-drawn (no DOM element), so nothing measurable stays
// full width when ComfyUI collapses our DOM widget on selection. Derive the
// target from the node's own width instead — node.size[0] does NOT change on
// selection. The DOM widget element is sized in node-logical px (the canvas
// applies zoom via a CSS transform, so clientWidth stays logical and matches
// node.size[0]'s units). Self-calibrate the small widget margin from the widest
// (uncollapsed) sample seen; cap it so a node that loads already-collapsed still
// recovers to near-full.
const MAX_WIDGET_MARGIN = 40
function referenceFromNodeSize(instance: QwenInstance, cw: number): number {
  const nodeW = instance.currentNode.size?.[0] ?? 0
  if (nodeW <= 0) return 0
  if (cw > 0) {
    const m = nodeW - cw
    if (m >= 0 && m < instance.marginLogical) {
      instance.marginLogical = Math.min(m, MAX_WIDGET_MARGIN)
    }
  }
  const margin = Number.isFinite(instance.marginLogical)
    ? instance.marginLogical
    : MAX_WIDGET_MARGIN / 2
  return Math.round(nodeW - margin)
}

function referenceWidth(
  instance: QwenInstance,
  container: HTMLElement,
  cw: number
): number {
  // 1) vueNodes: measure a real sibling widget control in the DOM.
  let w = referenceWidthFromDom(container)
  // 2) classic canvas renderer: derive from the node's own (stable) width.
  if (!w) w = referenceFromNodeSize(instance, cw)
  // 3) litegraph widgets that own a DOM element (e.g. textareas).
  if (!w) {
    for (const widget of instance.currentNode.widgets ?? []) {
      const el = widget.inputEl || widget.element
      if (el && el !== container && el.offsetWidth > w) w = el.offsetWidth
    }
  }
  // 4) last resort: the immediate parent's width.
  if (!w && container.parentElement) w = container.parentElement.clientWidth
  return w
}

// The enforcingWidth flag breaks the ResizeObserver feedback loop: setting the
// width re-fires the observer, which would otherwise re-enter here immediately.
function enforceWidth(instance: QwenInstance): void {
  if (instance.enforcingWidth) return
  const container = instance.container

  // Once our container lives in the Vue widgets grid, observe that grid too:
  // after we pin an explicit px width, the container's own box stops changing on
  // later collapses, so its ResizeObserver goes quiet. The grid stays fluid and
  // still ticks on every re-layout, keeping us in sync.
  if (instance.gridObserver === null) {
    const grid = findWidgetsGrid(container)
    if (grid) {
      instance.gridObserver = new ResizeObserver(() => enforceWidth(instance))
      instance.gridObserver.observe(grid)
    }
  }

  const cw = container.clientWidth
  const ref = referenceWidth(instance, container, cw)
  if (WIDGET_DEBUG) {
    const nodeW = instance.currentNode.size?.[0]
    console.log('[QwenMultiangle][width]',
      `container=${cw} ref=${ref} nodeW=${nodeW} margin=${instance.marginLogical} fromDom=${referenceWidthFromDom(container)}`)
  }
  // Two-directional: node.size[0] tracks legitimate resizes, so match the
  // reference whether our container collapsed (too narrow) or the node was
  // shrunk (too wide).
  if (ref > 0 && Math.abs(cw - ref) > 2) {
    instance.enforcingWidth = true
    container.style.width = ref + 'px'
    requestAnimationFrame(() => { instance.enforcingWidth = false })
  }
}

function createInstance(node: QwenMultiangleNode): QwenInstance {
  const container = document.createElement('div')
  container.id = `qwen-multiangle-widget-${node.id}`
  container.style.width = '100%'
  container.style.height = '100%'
  container.style.minHeight = '350px'

  const instance = {} as QwenInstance
  instance.container = container
  instance.currentNode = node
  instance.widget = null
  instance.cleanupTimer = null
  instance.widthObserver = null
  instance.gridObserver = null
  instance.enforcingWidth = false
  instance.marginLogical = Infinity

  const vueApp = createApp(App, {
    initialState: readStateFromNode(node),
    onStateChange: (state: CameraState) => {
      const live = instance.currentNode
      syncWidgetsFromState(live, {
        azimuth: state.azimuth,
        elevation: state.elevation,
        distance: state.distance
      })
      writeStoredProps(live, {
        azimuth: state.azimuth,
        elevation: state.elevation,
        distance: state.distance
      })
      app.graph?.setDirtyCanvas(true, true)
    }
  })
  const mounted = vueApp.mount(container)
  instance.vueApp = vueApp
  instance.exposed = mounted as unknown as AppExposed

  // Guard against the DOM-widget width-collapse bug (see enforceWidth above).
  instance.widthObserver = new ResizeObserver(() => enforceWidth(instance))
  instance.widthObserver.observe(container)

  instances.set(node, instance)
  return instance
}

// Drive the live 3D pose from the seed. Wired to the seed widget's callback, so
// it fires both when the user scrubs the seed and when control_after_generate
// rolls it each run (litegraph calls the widget callback on roll). seededAngles
// is deterministic, so a given seed always maps to the same reproducible pose.
function applySeededPosition(node: QwenMultiangleNode, exposed: AppExposed): void {
  const seed = Number(node.widgets?.find(w => w.name === 'seed')?.value ?? 0)
  const angles = seededAngles(seed)
  exposed.setState(angles)
  syncWidgetsFromState(node, angles)
  writeStoredProps(node, angles)
  app.graph?.setDirtyCanvas(true, true)
}

function bindWidgetCallbacks(
  node: QwenMultiangleNode,
  exposed: AppExposed
): void {
  const wire = (name: string, apply: (value: unknown) => void) => {
    const w = node.widgets?.find(widget => widget.name === name)
    if (!w) return
    const origCallback = w.callback
    w.callback = (value: unknown) => {
      origCallback?.call(w, value)
      apply(value)
    }
  }

  wire('horizontal_angle', v => {
    const azimuth = Number(v)
    exposed.setState({ azimuth })
    writeStoredProps(node, { azimuth })
  })
  wire('vertical_angle', v => {
    const elevation = Number(v)
    exposed.setState({ elevation })
    writeStoredProps(node, { elevation })
  })
  wire('zoom', v => {
    const distance = Number(v)
    exposed.setState({ distance })
    writeStoredProps(node, { distance })
  })
  wire('camera_view', v => {
    const cameraView = Boolean(v)
    exposed.setCameraView(cameraView)
    writeStoredProps(node, { cameraView })
  })
  // Seed scrub, or control_after_generate rolling the seed → recompute the pose.
  wire('seed', () => applySeededPosition(node, exposed))
}

function createCameraWidget(node: QwenMultiangleNode): DOMWidgetInstance {
  let instance = instances.get(node)

  if (instance) {
    if (instance.cleanupTimer !== null) {
      clearTimeout(instance.cleanupTimer)
      instance.cleanupTimer = null
    }
    instance.currentNode = node
    instance.exposed.setState(readStateFromNode(node))
    instance.exposed.setCameraView(readCameraViewFromNode(node))
  } else {
    instance = createInstance(node)
    if (readCameraViewFromNode(node)) {
      instance.exposed.setCameraView(true)
    }
  }

  const widget = node.addDOMWidget(
    'camera_preview',
    'qwen-multiangle',
    instance.container,
    {
      getMinHeight: () => 370,
      hideOnZoom: false,
      serialize: false
    }
  )

  instance.widget = widget
  bindWidgetCallbacks(node, instance.exposed)

  const baseOnRemove = widget.onRemove?.bind(widget)
  widget.onRemove = () => {
    baseOnRemove?.()

    const current = instances.get(node)
    if (!current || current.widget !== widget) return

    current.cleanupTimer = window.setTimeout(() => {
      const still = instances.get(node)
      if (!still || still.widget !== widget) return
      still.widthObserver?.disconnect()
      still.widthObserver = null
      still.gridObserver?.disconnect()
      still.gridObserver = null
      still.exposed.cleanup()
      still.vueApp.unmount()
      instances.delete(node)
    }, CLEANUP_DELAY_MS)
  }

  return widget
}

function setupImageInput(node: QwenMultiangleNode): void {
  const originalOnConnectionsChange = node.onConnectionsChange

  node.onConnectionsChange = function(
    slotType: number,
    slotIndex: number,
    isConnected: boolean,
    link: unknown,
    ioSlot: unknown
  ) {
    if (originalOnConnectionsChange) {
      originalOnConnectionsChange.call(this, slotType, slotIndex, isConnected, link, ioSlot)
    }

    if (slotType === 1 && slotIndex === 0) {
      const inst = instances.get(node)
      if (inst && !isConnected) {
        inst.exposed.updateImage(null)
      }
    }
  }
}

type PreviewImage = { filename: string; subfolder: string; type: string }

function applyPreviewImageFromOutput(
  instance: QwenInstance,
  output: unknown
): void {
  if (!output || typeof output !== 'object') return
  const images = (output as { preview_images?: PreviewImage[] }).preview_images
  if (!images || images.length === 0) return
  const img = images[0]
  const params = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder,
    type: img.type
  })
  const url = api.apiURL(`/view?${params.toString()}`)
  instance.exposed.updateImage(url)
}

function setupOnExecuted(node: QwenMultiangleNode, instance: QwenInstance): void {
  const originalOnExecuted = node.onExecuted
  node.onExecuted = function(output: unknown) {
    originalOnExecuted?.call(this, output)
    applyPreviewImageFromOutput(instance, output)
  }
}

// Re-assert the container width whenever the node is resized. The ResizeObserver
// catches the collapse bug on its own, but an explicit pixel width set by an
// earlier enforce would otherwise stay stale when the node is genuinely widened.
function setupOnResize(node: QwenMultiangleNode, instance: QwenInstance): void {
  const originalOnResize = node.onResize
  node.onResize = function(size: [number, number]) {
    originalOnResize?.call(this, size)
    enforceWidth(instance)
  }
}

// LGraphNode.configure() fires onPropertyChanged for every restored property
// during workflow load. Use it to push the persisted camera state into the 3D
// scene and the number widgets — nodeCreated is too early to read them.
//
// The instance must be captured by closure, not looked up via instances.get:
// onPropertyChanged fires during configure(), which is exactly when node.id
// is transitioning from its constructor default (-1) to the serialised id,
// so a map lookup by current id would miss the entry registered under -1.
function setupOnPropertyChanged(
  node: QwenMultiangleNode,
  instance: QwenInstance
): void {
  const originalOnPropertyChanged = node.onPropertyChanged
  node.onPropertyChanged = function(key: string, value: unknown) {
    originalOnPropertyChanged?.call(this, key, value)
    if (key !== PROP_KEY) return
    if (!value || typeof value !== 'object') return

    const state = value as Partial<StoredCameraState>
    instance.exposed.setState({
      azimuth: state.azimuth,
      elevation: state.elevation,
      distance: state.distance
    })
    if (state.cameraView !== undefined) {
      instance.exposed.setCameraView(Boolean(state.cameraView))
    }
    syncWidgetsFromState(node, state)
  }
}

app.registerExtension({
  name: 'ComfyUI.QwenMultiangle',

  nodeCreated(node: QwenMultiangleNode) {
    if (node.constructor?.comfyClass !== 'QwenMultiangleCameraNode') {
      return
    }

    const [oldWidth, oldHeight] = node.size
    node.setSize([Math.max(oldWidth, 350), Math.max(oldHeight, 520)])

    createCameraWidget(node)
    setupImageInput(node)
    const inst = instances.get(node)
    if (inst) {
      setupOnExecuted(node, inst)
      setupOnPropertyChanged(node, inst)
      setupOnResize(node, inst)
    }
  }
})
