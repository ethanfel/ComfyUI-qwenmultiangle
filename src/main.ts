import { createApp, type App as VueApp } from 'vue'

const { app } = window.comfyAPI.app
const { api } = window.comfyAPI.api

import App from './App.vue'
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
}

const instances = new Map<number, QwenInstance>()

const CLEANUP_DELAY_MS = 200

function getWidgetValue(
  node: QwenMultiangleNode,
  name: string,
  defaultValue: number
): number {
  const widget = node.widgets?.find(w => w.name === name)
  return widget ? Number(widget.value) : defaultValue
}

function readStateFromNode(node: QwenMultiangleNode): Partial<CameraState> {
  return {
    azimuth: getWidgetValue(node, 'horizontal_angle', 0),
    elevation: getWidgetValue(node, 'vertical_angle', 0),
    distance: getWidgetValue(node, 'zoom', 5.0)
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

  const vueApp = createApp(App, {
    initialState: readStateFromNode(node),
    onStateChange: (state: CameraState) => {
      const live = instance.currentNode
      const h = live.widgets?.find(w => w.name === 'horizontal_angle')
      const v = live.widgets?.find(w => w.name === 'vertical_angle')
      const z = live.widgets?.find(w => w.name === 'zoom')
      if (h) h.value = state.azimuth
      if (v) v.value = state.elevation
      if (z) z.value = state.distance
      app.graph?.setDirtyCanvas(true, true)
    }
  })
  const mounted = vueApp.mount(container)
  instance.vueApp = vueApp
  instance.exposed = mounted as unknown as AppExposed

  instances.set(node.id, instance)
  return instance
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

  wire('horizontal_angle', v => exposed.setState({ azimuth: Number(v) }))
  wire('vertical_angle', v => exposed.setState({ elevation: Number(v) }))
  wire('zoom', v => exposed.setState({ distance: Number(v) }))
  wire('camera_view', v => exposed.setCameraView(Boolean(v)))
}

function createCameraWidget(node: QwenMultiangleNode): DOMWidgetInstance {
  let instance = instances.get(node.id)

  if (instance) {
    if (instance.cleanupTimer !== null) {
      clearTimeout(instance.cleanupTimer)
      instance.cleanupTimer = null
    }
    instance.currentNode = node
    instance.exposed.setState(readStateFromNode(node))
    const cv = node.widgets?.find(w => w.name === 'camera_view')
    instance.exposed.setCameraView(Boolean(cv?.value))
  } else {
    instance = createInstance(node)
    const cv = node.widgets?.find(w => w.name === 'camera_view')
    if (cv && Boolean(cv.value)) {
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

    const current = instances.get(node.id)
    if (!current || current.widget !== widget) return

    current.cleanupTimer = window.setTimeout(() => {
      const still = instances.get(node.id)
      if (!still || still.widget !== widget) return
      still.exposed.cleanup()
      still.vueApp.unmount()
      instances.delete(node.id)
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
      const inst = instances.get(node.id)
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
    const inst = instances.get(node.id)
    if (inst) setupOnExecuted(node, inst)
  }
})
