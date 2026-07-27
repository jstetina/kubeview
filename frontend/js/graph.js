//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Handles most graph operations like adding, updating, and removing resources
// Also stores some cached resources and events not related to the graph
// Also processes links between resources in the G6 graph
// ==========================================================================================

import { findResByName, queryRes, remove, store } from './cache.js'
import { getConfig } from './config.js'
import { fitToVisible } from './graph-utils.js'
import { graph } from './main.js'

const ICON_PATH = 'public/img/res'

const BUILTIN_ICON_KINDS = new Set([
  'configmap',
  'cronjob',
  'daemonset',
  'deployment',
  'horizontalpodautoscaler',
  'ingress',
  'job',
  'persistentvolumeclaim',
  'pod',
  'replicaset',
  'secret',
  'service',
  'statefulset',
])

// Built-in kind names (PascalCase) -- resFilter only gates these.
// CRD kinds pass through unless explicitly excluded.
const BUILTIN_KINDS = new Set([
  'Pod',
  'Deployment',
  'ReplicaSet',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'Service',
  'Ingress',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
  'HorizontalPodAutoscaler',
  'Endpoints',
  'EndpointSlice',
  'Event',
])

/**
 * Used to add a resource to the graph
 * @param {Resource} res The k8s resource to add
 */
export function addResource(res) {
  // Always cache first so label/owner filters can access all resources
  store(res)

  // In operator mode, show all resource types including EndpointSlices
  if (!_operatorMode) {
    if (res.kind === 'Endpoints' || res.kind === 'EndpointSlice') {
      return
    }
  }

  // Events are not added to the graph
  if (res.kind === 'Event') {
    window.dispatchEvent(new CustomEvent('kubeEventAdded', { detail: res }))
    return
  }

  // In operator tree mode, the tree-view module controls what gets rendered -- skip kind filtering
  if (!_operatorMode) {
    const activeFilter = getActiveKindFilter()
    if (activeFilter && activeFilter.length > 0 && !activeFilter.includes(res.kind)) {
      if (_urlKindsOverride && _urlKindsOverride.length > 0) {
        if (getConfig().debug) console.warn(`🍇 Skipping resource of kind ${res.kind} (URL kinds filter)`)
        return
      }

      if (BUILTIN_KINDS.has(res.kind)) {
        if (getConfig().debug) console.warn(`🍇 Skipping resource of kind ${res.kind} as it is not in the filter`)
        return
      }
    }
  }

  if (shouldHideEmptyReplicaSet(res)) {
    if (getConfig().debug) console.warn(`🍇 Skipping ReplicaSet ${res.metadata?.name} with zero replicas`)
    return
  }

  try {
    graph.addNodeData([makeNode(res)])
    processLinks(res)

    const event = new CustomEvent('nodeAdded', { detail: res.metadata.uid })
    window.dispatchEvent(event)

    return res.metadata.uid
  } catch (e) {
    console.warn(`Unable to add node for resource ${res.metadata.name} (${res.kind}):`, e.message)
  }
}

/** @type {string[] | null} */
let _urlKindsOverride = null

let _operatorMode = false

/**
 * Enable/disable operator view mode (affects node labeling).
 * @param {boolean} enabled
 */
export function setOperatorMode(enabled) {
  _operatorMode = enabled
}

/**
 * Set the URL kinds override for filtering. When set, this takes priority over localStorage resFilter.
 * @param {string[] | null} kinds
 */
export function setUrlKindsOverride(kinds) {
  _urlKindsOverride = kinds
}

/**
 * Get the active kind filter, considering URL override.
 * @returns {string[] | null}
 */
export function getActiveKindFilter() {
  if (_urlKindsOverride && _urlKindsOverride.length > 0) {
    return _urlKindsOverride
  }

  return getConfig().resFilter || null
}

/**
 * Used to update a resource in the graph
 * It will update the node data and the status colour
 * @param {Resource} res The k8s resource to update
 */
export async function updateResource(res) {
  // Endpoints are stored in the lookup cache but not added to the graph
  if (res.kind === 'Endpoints') {
    store
    processLinks(res)
    return
  }

  // Events are also special, they are not added to the graph
  if (res.kind === 'Event') {
    store(res)
    window.dispatchEvent(new CustomEvent('eventsUpdated', { detail: res }))
    return
  }

  if (shouldHideEmptyReplicaSet(res)) {
    removeResource(res)
    return
  }

  try {
    const node = graph.getNodeData(res.metadata.uid)
    if (node.length === 0) {
      // If the node does not exist, we add it
      if (getConfig().debug) console.warn(`🍒 Node with ID ${res.metadata.uid} not found, adding it`)
      addResource(res)
      processLinks(res)
      return
    }
  } catch (_err) {}

  // Actual update is here
  try {
    graph.updateNodeData([makeNode(res)])
  } catch (_err) {}

  store(res)
  processLinks(res)
}

/**
 * Determine whether a ReplicaSet should be hidden because it has no replicas
 * @param {Resource} res
 */
function shouldHideEmptyReplicaSet(res) {
  if (res.kind !== 'ReplicaSet') return false
  if (!getConfig().hideEmptyReplicaSets) return false

  const statusReplicas = res.status?.replicas
  const specReplicas = res.spec?.replicas
  const replicas = Number(statusReplicas ?? specReplicas ?? 0)

  return replicas === 0
}

/**
 * Used remove a resource from the graph
 * @param {Resource} res The k8s resource to remove
 */
export function removeResource(res) {
  // Function to remove edges linked to this resource
  graph.removeEdgeData((nodeDataList) => {
    const b = nodeDataList
      .filter((edge) => {
        return edge.source === res.metadata.uid || edge.target === res.metadata.uid
      })
      .map((edge) => {
        return edge.id
      })
    return b
  })

  try {
    graph.removeNodeData([res.metadata.uid])
  } catch (_err) {}

  remove(res.metadata.uid)
}

/**
 * Link two nodes together
 * @param {string} sourceId The ID of the source node
 * @param {string} targetId The ID of the target node
 */
export function addEdge(sourceId, targetId) {
  try {
    // Check the source and target IDs are valid
    if (graph.getNodeData(sourceId).length === 0 || graph.getNodeData(targetId).length === 0) {
      if (getConfig().debug) {
        console.warn(`🚸 Unable to add link: ${sourceId} to ${targetId}`)
      }
      return
    }

    graph.addEdgeData([
      {
        source: sourceId,
        target: targetId,
        id: `${sourceId}.${targetId}`,
      },
    ])
  } catch (_err) {
    if (getConfig().debug) {
      console.warn(`🚸 Unable to add link: ${sourceId} to ${targetId}`)
    }
  }
}

/**
 * Lots of nasty custom logic to link resources together
 * This is used to link Ingresses to Services and Services to Pods, etc.
 * @param {Resource} res The resource to process links for
 */
export function processLinks(res) {
  if (res.metadata.ownerReferences) {
    for (const ownerRef of res.metadata.ownerReferences) {
      addEdge(ownerRef.uid, res.metadata.uid)
    }
  }

  // If the resource is a Ingress, we link it to the Service via the backend service name
  if (res.kind === 'Ingress') {
    if (res.spec?.rules) {
      for (const rule of res.spec.rules) {
        if (rule.http && rule.http.paths) {
          for (const path of rule.http.paths) {
            if (path.backend && path.backend.service && path.backend.service.name) {
              if (getConfig().debug) console.log(`🔗 Linking Ingress ${res.metadata.name} to Service ${path.backend.service.name}`)
              const serviceName = path.backend.service.name
              const service = findResByName('Service', serviceName)
              if (service) {
                addEdge(res.metadata.uid, service.metadata.uid)
              }
            }
          }
        }
      }
    }
    const defaultBackendServiceName = res.spec.defaultBackend?.service.name
    if (defaultBackendServiceName) {
      const defaultBackendService = findResByName('Service', defaultBackendServiceName)
      if (defaultBackendService) {
        addEdge(res.metadata.uid, defaultBackendService.metadata.uid)
      }
    }
  }

  // If the resource is a Endpoint find the Service and link it to the Pod with the matching IP
  if (res.kind === 'Endpoints') {
    const service = findResByName('Service', res.metadata.name)
    if (service) {
      for (const subset of res.subsets || []) {
        for (const addr of subset.addresses || []) {
          const pods = queryRes((r) => r.kind === 'Pod' && r.status?.podIP === addr.ip)
          if (pods.length > 0) {
            const pod = pods[0]
            if (getConfig().debug) console.log(`🔗 Linking Endpoints ${res.metadata.name} to PodIP ${addr.ip} (${pod.metadata.name})`)
            addEdge(service.metadata.uid, pod.metadata.uid)
          } else {
            if (getConfig().debug) console.warn(`🔗 No Pod found for Endpoints ${res.metadata.name} with IP ${addr.ip}`)
          }
        }
      }
    }
  }

  // Handle endpoint slices, these replace Endpoints in newer Kubernetes versions
  // If the server version is 1.33 or higher, we will use EndpointSlices instead of Endpoints
  // See https://kubernetes.io/blog/2025/04/24/endpoints-deprecation/
  if (res.kind === 'EndpointSlice') {
    const serviceName = res.metadata?.labels?.['kubernetes.io/service-name']
    const service = findResByName('Service', serviceName)
    if (service) {
      for (const ep of res.endpoints || []) {
        if (ep.addresses && ep.addresses.length > 0) {
          const addr = ep.addresses[0]
          const pods = queryRes((r) => r.kind === 'Pod' && r.status?.podIP === addr)
          if (pods.length > 0) {
            const pod = pods[0]
            if (getConfig().debug) console.log(`🔗 Linking EndpointSlice ${res.metadata.name} to PodIP ${addr} (${pod.metadata.name})`)
            addEdge(service.metadata.uid, pod.metadata.uid)
          } else {
            if (getConfig().debug) console.warn(`🔗 No Pod found for EndpointSlice ${res.metadata.name} with IP ${addr}`)
          }
        }
      }
    }
  }

  // Try to link a pod with a volume claim to the PVC resource
  if (res.kind === 'Pod' && res.spec?.volumes) {
    for (const volume of res.spec.volumes) {
      if (volume.persistentVolumeClaim && volume.persistentVolumeClaim.claimName) {
        const pvcs = queryRes((r) => r.kind === 'PersistentVolumeClaim' && r.metadata.name === volume.persistentVolumeClaim.claimName)
        if (pvcs.length > 0) {
          if (getConfig().debug) console.log(`🔗 Linking Pod ${res.metadata.name} to PVC ${volume.persistentVolumeClaim.claimName}`)
          addEdge(res.metadata.uid, pvcs[0].metadata.uid)
        }
      }
    }
  }

  // Try to link config maps and secrets to pods
  if (res.kind === 'Pod' && res.spec?.volumes) {
    for (const volume of res.spec.volumes) {
      if (volume.configMap && volume.configMap.name) {
        // const cm = cy.$(`node[kind = "ConfigMap"][label = "${volume.configMap.name}"]`)
        const cm = findResByName('ConfigMap', volume.configMap.name)
        if (cm) {
          if (getConfig().debug) console.log(`🔗 Linking Pod ${res.metadata.name} to ConfigMap ${volume.configMap.name}`)
          addEdge(res.metadata.uid, cm.metadata.uid)
        }
      }
      if (volume.secret && volume.secret.secretName) {
        const secret = findResByName('Secret', volume.secret.secretName)
        if (secret) {
          if (getConfig().debug) console.log(`🔗 Linking Pod ${res.metadata.name} to Secret ${volume.secret.secretName}`)
          addEdge(res.metadata.uid, secret.metadata.uid)
        }
      }
    }
  }

  // Search for environment variables in the Pod spec that reference ConfigMaps or Secrets
  if (res.kind === 'Pod' && res.spec?.containers) {
    for (const container of res.spec.containers) {
      if (container.env) {
        for (const env of container.env) {
          if (env.valueFrom && env.valueFrom.secretKeyRef && env.valueFrom.secretKeyRef.name) {
            const secret = findResByName('Secret', env.valueFrom.secretKeyRef.name)
            if (secret) {
              if (getConfig().debug)
                console.log(`🔗 Linking Pod ${res.metadata.name} to Secret ${env.valueFrom.secretKeyRef.name} (env var ${env.name})`)
              addEdge(res.metadata.uid, secret.metadata.uid)
            }
          } else if (env.valueFrom && env.valueFrom.configMapKeyRef && env.valueFrom.configMapKeyRef.name) {
            const configMap = findResByName('ConfigMap', env.valueFrom.configMapKeyRef.name)
            if (configMap) {
              if (getConfig().debug)
                console.log(`🔗 Linking Pod ${res.metadata.name} to ConfigMap ${env.valueFrom.configMapKeyRef.name} (env var ${env.name})`)
              addEdge(res.metadata.uid, configMap.metadata.uid)
            }
          }
        }
      }
    }
  }

  // Try to link a HPA to the target resource
  if (res.kind === 'HorizontalPodAutoscaler' && res.spec?.scaleTargetRef) {
    const targetKind = res.spec.scaleTargetRef.kind
    const targetName = res.spec.scaleTargetRef.name
    // Find the target resource in the graph
    const targetNode = findResByName(targetKind, targetName)
    if (targetNode) {
      if (getConfig().debug) console.log(`🔗 Linking HPA ${res.metadata.name} to ${targetKind} ${targetName}`)
      addEdge(res.metadata.uid, targetNode.metadata.uid)
    } else {
      if (getConfig().debug) console.warn(`🔗 No target resource found for HPA ${res.metadata.name}`)
    }
  }
}

/**
 * Generate a dynamic CRD icon SVG with shortname text baked in.
 * @param {string} shortName - e.g. "DSC", "HP", "GC"
 * @param {string} color - gradient base color: 'purple', 'green', 'red', 'grey'
 * @returns {string} data URI
 */
function generateCrdIcon(shortName, color = 'purple') {
  const colors = {
    purple: { from: '#7B61FF', to: '#5A3FD9', stroke: '#9B8AFF' },
    green: { from: '#2ECC71', to: '#27AE60', stroke: '#58D68D' },
    red: { from: '#E74C3C', to: '#C0392B', stroke: '#F1948A' },
    grey: { from: '#95A5A6', to: '#7F8C8D', stroke: '#BDC3C7' },
  }

  const c = colors[color] || colors.purple
  const fontSize = shortName.length > 3 ? 12 : shortName.length > 2 ? 14 : 16

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" style="stop-color:${c.from};stop-opacity:1"/>
<stop offset="100%" style="stop-color:${c.to};stop-opacity:1"/>
</linearGradient></defs>
<rect x="10" y="10" width="80" height="80" rx="12" ry="12" fill="url(#g)" stroke="${c.stroke}" stroke-width="2"/>
<text x="50" y="42" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#fff">CRD</text>
<line x1="25" y1="52" x2="75" y2="52" stroke="#fff" stroke-width="1.5" stroke-opacity="0.5"/>
<text x="50" y="72" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold" fill="#fff" fill-opacity="0.9">${shortName}</text>
</svg>`

  return `data:image/svg+xml;base64,${btoa(svg)}`
}

/**
 * Resolve the icon path for a resource, using the fallback chain:
 * 1. Virtual CRD nodes get a dynamic icon with shortname
 * 2. CSV nodes use the operator icon from spec.icon
 * 3. customIcons config
 * 4. Built-in icon
 * 5. Generic CRD icon with shortname
 * @param {Resource} res
 * @param {string} colourSuffix
 * @returns {string}
 */
function resolveIconPath(res, colourSuffix) {
  const cfg = getConfig()
  const kindLower = res.kind.toLowerCase()
  const apiVersionKind = `${res.apiVersion || ''}/${res.kind}`

  // Virtual CRD kind nodes: dynamic icon with shortname
  if (res._virtual && res._shortName) {
    const hasKids = res._hasChildren !== false
    const color = hasKids ? 'purple' : 'grey'
    return generateCrdIcon(res._shortName, color)
  }

  // CSV: use the operator icon from spec.icon if available
  if (res.kind === 'ClusterServiceVersion' && res.spec?.icon?.[0]) {
    const icon = res.spec.icon[0]
    if (icon.base64data && icon.mediatype) {
      return `data:${icon.mediatype};base64,${icon.base64data}`
    }
  }

  if (cfg.customIcons) {
    if (cfg.customIcons[apiVersionKind]) {
      return `${ICON_PATH}/${cfg.customIcons[apiVersionKind]}`
    }
    if (cfg.customIcons[res.kind]) {
      return `${ICON_PATH}/${cfg.customIcons[res.kind]}`
    }
  }

  if (BUILTIN_ICON_KINDS.has(kindLower)) {
    return `${ICON_PATH}/${kindLower}${colourSuffix}.svg`
  }

  // Non-built-in kinds: dynamic CRD icon with shortname
  if (_operatorMode) {
    const caps = res.kind.replace(/[a-z]/g, '')
    const shortName = caps.length >= 2 ? caps : res.kind.substring(0, 3).toUpperCase()
    const color = colourSuffix === '-green' ? 'green' : colourSuffix === '-red' ? 'red' : colourSuffix === '-grey' ? 'grey' : 'purple'
    return generateCrdIcon(shortName, color)
  }

  return `${ICON_PATH}/crd-default${colourSuffix}.svg`
}

/**
 * Create a node object for G6 from the k8s resource
 * @param {Resource} res The k8s resource to create a node for
 * @returns {ResNode} The G6 node object to be added to the graph
 */
export function makeNode(res) {
  let label = res.metadata.name

  if (getConfig().shortenNames && res.metadata && res.metadata.labels) {
    if (res.metadata.labels['pod-template-hash']) {
      label = label.split('-' + res.metadata.labels['pod-template-hash'])[0]
    }
  }

  // Shorten CSV names: "rhods-operator.3.4.2" -> "rhods-operator"
  if (res.kind === 'ClusterServiceVersion') {
    label = label.replace(/\.\d+\.\d+\.\d+.*$/, '')
    label = label.replace(/\.v\d+.*$/, '')
  }

  // Virtual CRD kind nodes get their display name
  if (res._virtual && res._displayName) {
    label = res._displayName
  }

  // No text prefix needed -- shortnames are now baked into the CRD icons

  let colourSuffix = statusColour(res)
  if (colourSuffix !== '') {
    colourSuffix = '-' + colourSuffix
  }

  return {
    id: res.metadata.uid,
    style: {
      src: resolveIconPath(res, colourSuffix),
      labelText: label,
    },
    data: {
      kind: res.kind,
      namespace: res.metadata.namespace || '',
      ip: res.status?.podIP || res.status?.hostIP || null,
    },
  }
}

/**
 * Used to calculate the status colour of the resource based on its state
 * @param {Resource} res The k8s resource to calculate the status colour for
 */
function statusColour(res) {
  try {
    if (res.kind === 'Deployment') {
      if (res.status == {} || !res.status.conditions) return 'grey'

      const availCond = res.status.conditions.find((c) => c.type == 'Available') || null
      if (availCond && availCond.status == 'True') return 'green'
      return 'red'
    }

    if (res.kind === 'ReplicaSet') {
      if (res.status.replicas == 0) return 'grey'
      if (res.status.replicas == res.status.readyReplicas) return 'green'
      return 'red'
    }

    if (res.kind === 'StatefulSet') {
      if (res.status.replicas == 0) return 'grey'
      if (res.status.replicas == res.status.readyReplicas) return 'green'
      return 'red'
    }

    if (res.kind === 'DaemonSet') {
      if (res.status.numberReady == res.status.desiredNumberScheduled) return 'green'
      if (res.status.desiredNumberScheduled == 0) return 'grey'
      return 'red'
    }

    if (res.kind === 'Pod') {
      // Weird way to check for terminaing pods, it's not anywhere else!
      if (res.metadata.deletionTimestamp) return 'red'

      if (res.status && res.status.conditions) {
        const readyCond = res.status.conditions.find((c) => c.type == 'Ready')
        if (readyCond && readyCond.status == 'True') return 'green'
      }

      if (res.status.phase == 'Failed') return 'red'
      if (res.status.phase == 'Succeeded') return 'green'
      if (res.status.phase == 'Pending') return 'grey'

      return 'grey'
    }

    if (res.kind === 'PersistentVolumeClaim') {
      if (res.status.phase === 'Bound') return 'green'
      if (res.status.phase === 'Pending') return 'grey'
      return 'red'
    }

    if (res.kind === 'Job') {
      const backoffLimit = res.spec.backoffLimit || 6
      const succeeded = res.status?.succeeded || 0
      const completions = res.spec?.completions || 1 // Default to 1 if not set
      const failed = res.status?.failed || 0

      if (succeeded >= completions) return 'green'
      if (failed >= backoffLimit) return 'red'

      return 'grey'
    }

    // Generic fallback for CRDs and other unknown resource types:
    // Check standard conditions (Ready, Available) that most operators follow
    if (res.status?.conditions && Array.isArray(res.status.conditions)) {
      const readyCond = res.status.conditions.find((c) => c.type === 'Ready' || c.type === 'Available')
      if (readyCond) {
        if (readyCond.status === 'True') return 'green'
        if (readyCond.status === 'False') return 'red'
      }

      return 'grey'
    }

    if (res.status?.phase) {
      const phase = res.status.phase.toLowerCase()
      if (phase === 'running' || phase === 'active' || phase === 'bound' || phase === 'succeeded') return 'green'
      if (phase === 'failed' || phase === 'error') return 'red'
      return 'grey'
    }
  } catch (e) {
    console.error('💥 Error calculating status colour:', e)
    return ''
  }

  return ''
}

/**
 * Layout the graph
 */
let layoutCallBackId = null
export async function layout() {
  try {
    await graph.draw()

    if (layoutCallBackId) {
      clearTimeout(layoutCallBackId)
    }

    layoutCallBackId = setTimeout(async () => {
      graph.stopLayout()
      try {
        await graph.layout()

        // Call custom fit view that only considers visible nodes
        await fitToVisible(graph, true)
      } catch (_err) {}
    }, 80)
  } catch (_err) {}
}
