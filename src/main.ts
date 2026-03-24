import { createApp } from 'vue'

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

// Store Vue app instances for cleanup and external access
const widgetInstances = new Map<number, { unmount: () => void; exposed: AppExposed }>()

function createCameraWidget(node: QwenMultiangleNode): { widget: DOMWidgetInstance } {
  const container = document.createElement('div')
  container.id = `qwen-multiangle-widget-${node.id}`
  container.style.width = '100%'
  container.style.height = '100%'
  container.style.minHeight = '350px'

  const getWidgetValue = (name: string, defaultValue: number): number => {
    const widget = node.widgets?.find(w => w.name === name)
    return widget ? Number(widget.value) : defaultValue
  }

  const initialState: Partial<CameraState> = {
    azimuth: getWidgetValue('horizontal_angle', 0),
    elevation: getWidgetValue('vertical_angle', 0),
    distance: getWidgetValue('zoom', 5.0)
  }

  // Create DOM widget
  const widget = node.addDOMWidget(
    'camera_preview',
    'qwen-multiangle',
    container,
    {
      getMinHeight: () => 370,
      hideOnZoom: false,
      serialize: false
    }
  )

  setTimeout(() => {
    const vueApp = createApp(App, {
      initialState,
      onStateChange: (state: CameraState) => {
        const hWidget = node.widgets?.find(w => w.name === 'horizontal_angle')
        const vWidget = node.widgets?.find(w => w.name === 'vertical_angle')
        const zWidget = node.widgets?.find(w => w.name === 'zoom')

        if (hWidget) hWidget.value = state.azimuth
        if (vWidget) vWidget.value = state.elevation
        if (zWidget) zWidget.value = state.distance

        app.graph?.setDirtyCanvas(true, true)
      }
    })

    const instance = vueApp.mount(container)
    const exposed = instance as unknown as AppExposed

    widgetInstances.set(node.id, { unmount: () => vueApp.unmount(), exposed })

    const setupWidgetSync = (widgetName: string) => {
      const w = node.widgets?.find(widget => widget.name === widgetName)
      if (w) {
        const origCallback = w.callback
        w.callback = (value: unknown) => {
          if (origCallback) {
            origCallback.call(w, value)
          }

          const inst = widgetInstances.get(node.id)
          if (!inst) return

          if (widgetName === 'horizontal_angle') {
            inst.exposed.setState({ azimuth: Number(value) })
          } else if (widgetName === 'vertical_angle') {
            inst.exposed.setState({ elevation: Number(value) })
          } else if (widgetName === 'zoom') {
            inst.exposed.setState({ distance: Number(value) })
          } else if (widgetName === 'camera_view') {
            inst.exposed.setCameraView(Boolean(value))
          }
        }
      }
    }

    setupWidgetSync('horizontal_angle')
    setupWidgetSync('vertical_angle')
    setupWidgetSync('zoom')
    setupWidgetSync('camera_view')

    const cameraViewWidget = node.widgets?.find(w => w.name === 'camera_view')
    if (cameraViewWidget && Boolean(cameraViewWidget.value)) {
      exposed.setCameraView(true)
    }
  }, 100)

  widget.onRemove = () => {
    const inst = widgetInstances.get(node.id)
    if (inst) {
      inst.exposed.cleanup()
      inst.unmount()
      widgetInstances.delete(node.id)
    }
  }

  return { widget }
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
      const inst = widgetInstances.get(node.id)
      if (inst && !isConnected) {
        inst.exposed.updateImage(null)
      }
    }
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
  }
})

// Listen for node execution results
api.addEventListener('executed', (event: CustomEvent) => {
  const detail = event.detail
  if (!detail?.node || !detail?.output) return

  const nodeId = parseInt(detail.node, 10)
  const inst = widgetInstances.get(nodeId)
  if (!inst) return

  const images = detail.output?.preview_images as Array<{ filename: string; subfolder: string; type: string }> | undefined
  if (images && images.length > 0) {
    const img = images[0]
    const params = new URLSearchParams({
      filename: img.filename,
      subfolder: img.subfolder,
      type: img.type
    })
    const url = api.apiURL(`/view?${params.toString()}`)
    inst.exposed.updateImage(url)
  } else {
    console.log('[QwenMultiangle] No images in output')
  }
})
