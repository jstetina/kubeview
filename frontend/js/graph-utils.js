//@ts-check

import { getResById, queryRes, findResByName } from './cache.js'
import { getConfig } from './config.js'

// ==========================================================================================
// More graph utility functions, mainly as G6 lacks some higher level features
// And has some outright bugs
// ==========================================================================================

// Default layout configurations for G6 graphs
export const dagreLayout = {
  type: 'antv-dagre',
  rankdir: 'TB',
  ranker: 'network-simplex',
  nodeSize: getConfig().spacing || 100,
}

export const forceLayout = {
  type: 'force-atlas2',
  preventOverlap: true,
  kr: 20,
  ks: 0.3,
  nodeSize: getConfig().spacing || 100,
}

/**
 * Filters the graph nodes and edges based on the provided label query.
 * @param {any} graph The G6 graph instance.
 * @param {string} labelQuery The label query to filter nodes by. If empty, all nodes are shown.
 * @returns {number} The number of visible nodes after filtering.
 */
export function nodeVisByLabel(graph, labelQuery) {
  // If query is empty, show all nodes
  if (!labelQuery) {
    // Show all nodes by removing any visibility styling
    graph.updateNodeData(
      graph.getNodeData().map((node) => ({
        ...node,
        style: {
          ...node.style,
          visibility: 'visible',
        },
      })),
    )

    // Show all edges by removing any visibility styling
    graph.updateEdgeData(
      graph.getEdgeData().map((edge) => ({
        ...edge,
        style: {
          ...edge.style,
          visibility: 'visible',
        },
      })),
    )

    return graph.getNodeData().length // Return total count of nodes
  } else {
    // Filter nodes based on labelText
    const allNodes = graph.getNodeData()
    const updatedNodes = allNodes.map((node) => {
      const labelText = node.style?.labelText || ''
      const matches = labelText.toLowerCase().includes(labelQuery)

      return {
        ...node,
        style: {
          ...node.style,
          visibility: matches ? 'visible' : 'hidden',
        },
      }
    })

    // Update the graph with filtered visibility
    graph.updateNodeData(updatedNodes)

    // Get the IDs of visible nodes
    const visibleNodeIds = new Set(updatedNodes.filter((n) => n.style.visibility === 'visible').map((n) => n.id))

    // Filter edges - hide edges that connect to hidden nodes
    const allEdges = graph.getEdgeData()
    const updatedEdges = allEdges.map((edge) => {
      const sourceVisible = visibleNodeIds.has(edge.source)
      const targetVisible = visibleNodeIds.has(edge.target)
      const edgeVisible = sourceVisible && targetVisible

      return {
        ...edge,
        style: {
          ...edge.style,
          visibility: edgeVisible ? 'visible' : 'hidden',
        },
      }
    })

    // Update the graph with filtered edge visibility
    graph.updateEdgeData(updatedEdges)

    // Return the count of visible nodes
    return visibleNodeIds.size
  }
}

/**
 * Custom fit view function that only considers visible nodes
 * This solves the G6 bug where fitView includes hidden nodes in the calculation
 * @param {any} graph The G6 graph instance
 * @param {boolean} animation Whether to use animation
 * @returns {Promise<void>}
 */
export async function fitToVisible(graph, animation = true) {
  try {
    // Get all nodes and filter for visible ones
    const allNodes = graph.getNodeData()
    const visibleNodes = allNodes.filter((node) => node.style?.visibility !== 'hidden')

    if (visibleNodes.length === 0) {
      console.warn('No visible nodes to fit to')
      return
    }

    // If all nodes are visible, just use standard fitView
    if (visibleNodes.length === allNodes.length) {
      await graph.fitView({ when: 'always', direction: 'both' }, animation)
      return
    }

    // Calculate bounding box of visible nodes using their actual positions
    const positions = []

    for (const node of visibleNodes) {
      try {
        // Get the actual rendered position of the node
        const position = graph.getElementPosition(node.id)
        if (position) {
          positions.push(position)
        }
      } catch (_err) {
        // If we can't get position, skip this node
        console.warn(`Could not get position for node ${node.id}`)
      }
    }

    if (positions.length === 0) {
      console.warn('No node positions available for fitting')
      await graph.fitView({ when: 'always', direction: 'both' }, animation)
      return
    }

    // Calculate bounding box
    const minX = Math.min(...positions.map((p) => p[0]))
    const maxX = Math.max(...positions.map((p) => p[0]))
    const minY = Math.min(...positions.map((p) => p[1]))
    const maxY = Math.max(...positions.map((p) => p[1]))

    // Calculate center of bounding box
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    // Calculate dimensions of bounding box
    const width = maxX - minX
    const height = maxY - minY

    // Get canvas size
    const canvasSize = graph.getSize()
    const canvasWidth = canvasSize[0]
    const canvasHeight = canvasSize[1]

    // Add padding (20% of canvas size)
    const paddingX = canvasWidth * 0.1
    const paddingY = canvasHeight * 0.1

    // Calculate zoom to fit with padding
    const zoomX = (canvasWidth - 2 * paddingX) / width
    const zoomY = (canvasHeight - 2 * paddingY) / height
    const targetZoom = Math.min(zoomX, zoomY, 2) // Cap at 2x zoom

    // Get current zoom
    const currentZoom = graph.getZoom()

    // Calculate zoom ratio
    let zoomRatio = targetZoom / currentZoom
    zoomRatio *= 0.91 // Slightly reduce zoom to avoid clipping

    // Get viewport center
    const viewportCenter = graph.getViewportCenter()

    // First zoom to the target zoom level from viewport center
    if (Math.abs(zoomRatio - 1) > 0.01) {
      await graph.zoomBy(zoomRatio, animation, viewportCenter)
    }

    // Calculate where the center should be in viewport coordinates
    const targetViewportX = canvasWidth / 2
    const targetViewportY = canvasHeight / 2

    // Convert the bounding box center to viewport coordinates AFTER zoom
    const targetCanvasPoint = [centerX, centerY]
    const currentViewportPoint = graph.getViewportByCanvas(targetCanvasPoint)

    // Calculate translation needed to center the bounding box
    const translateX = targetViewportX - currentViewportPoint[0]
    const translateY = targetViewportY - currentViewportPoint[1]

    // Translate to center the visible nodes
    if (Math.abs(translateX) > 1 || Math.abs(translateY) > 1) {
      await graph.translateBy([translateX, translateY], animation)
    }
  } catch (error) {
    console.error('💥 Error in fitViewToVisible:', error)
    // Fallback to standard fitView
    await graph.fitView({ when: 'always', direction: 'both' }, animation)
  }
}

/**
 * Generalized visibility filter: shows/hides nodes based on a predicate function.
 * The predicate receives (nodeData, cachedResource) and returns true if visible.
 * @param {any} graph
 * @param {function(any, Resource|null): boolean} predicate
 * @returns {number} Count of visible nodes
 */
export function nodeVisByPredicate(graph, predicate) {
  const allNodes = graph.getNodeData()
  const updatedNodes = allNodes.map((node) => {
    const cached = getResById(node.id)
    const visible = predicate(node, cached)

    return {
      ...node,
      style: {
        ...node.style,
        visibility: visible ? 'visible' : 'hidden',
      },
    }
  })

  graph.updateNodeData(updatedNodes)

  const visibleNodeIds = new Set(updatedNodes.filter((n) => n.style.visibility === 'visible').map((n) => n.id))

  const allEdges = graph.getEdgeData()
  const updatedEdges = allEdges.map((edge) => {
    const edgeVisible = visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)

    return {
      ...edge,
      style: {
        ...edge.style,
        visibility: edgeVisible ? 'visible' : 'hidden',
      },
    }
  })

  graph.updateEdgeData(updatedEdges)

  return visibleNodeIds.size
}

/**
 * Collect all UIDs reachable from a given owner via ownerReferences (BFS).
 * Includes the owner itself and all transitive children.
 * @param {string} ownerKind
 * @param {string} ownerName
 * @returns {Set<string>}
 */
export function collectOwnerTree(ownerKind, ownerName) {
  const result = new Set()
  const owner = findResByName(ownerKind, ownerName)

  if (!owner) return result

  const queue = [owner.metadata.uid]
  result.add(owner.metadata.uid)

  while (queue.length > 0) {
    const parentUid = queue.shift()
    const children = queryRes(
      (r) => r.metadata.ownerReferences && r.metadata.ownerReferences.some((ref) => ref.uid === parentUid),
    )

    for (const child of children) {
      if (!result.has(child.metadata.uid)) {
        result.add(child.metadata.uid)
        queue.push(child.metadata.uid)
      }
    }
  }

  return result
}

/**
 * @typedef {Object} UrlFilters
 * @property {string} [q] - text search query
 * @property {string[]} [kinds] - kind filter list
 * @property {string} [owner] - "Kind/Name" owner filter
 * @property {string[]} [labels] - label selectors ["key=value", ...]
 */

/**
 * Build a combined predicate from URL filter parameters.
 * All active filters are ANDed together.
 * @param {UrlFilters} filters
 * @returns {function(any, Resource|null): boolean}
 */
export function buildFilterPredicate(filters) {
  const predicates = []

  if (filters.q) {
    const q = filters.q.toLowerCase()
    predicates.push((node, _cached) => {
      const labelText = node.style?.labelText || ''
      return labelText.toLowerCase().includes(q)
    })
  }

  if (filters.kinds && filters.kinds.length > 0) {
    const kindSet = new Set(filters.kinds)
    predicates.push((node, _cached) => {
      return kindSet.has(node.data?.kind)
    })
  }

  if (filters.owner) {
    const parts = filters.owner.split('/')
    if (parts.length === 2) {
      const ownerTree = collectOwnerTree(parts[0], parts[1])
      if (ownerTree.size > 0) {
        predicates.push((node, _cached) => ownerTree.has(node.id))
      }
    }
  }

  if (filters.labels && filters.labels.length > 0) {
    const labelPairs = filters.labels.map((l) => {
      const eqIdx = l.indexOf('=')
      return eqIdx > 0 ? [l.substring(0, eqIdx), l.substring(eqIdx + 1)] : [l, '']
    })

    predicates.push((_node, cached) => {
      if (!cached || !cached.metadata?.labels) return false
      return labelPairs.every(([key, val]) => {
        if (val === '') return key in cached.metadata.labels
        return cached.metadata.labels[key] === val
      })
    })
  }

  if (predicates.length === 0) {
    return () => true
  }

  return (node, cached) => predicates.every((p) => p(node, cached))
}
