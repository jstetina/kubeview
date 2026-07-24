//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Main JavaScript entry point for KubeView
// Handles the main G6 graph and data load from the server
// Provides functions to add, update, and remove resources from the graph
// ==========================================================================================
import Alpine from '../ext/alpinejs.esm.min.js'
import { Graph, GraphEvent } from '../ext/g6-esm.js'

import { getConfig, saveConfig } from './config.js'
import { getClientId, initEventStreaming, togglePaused } from './events.js'
import { addResource, addEdge, processLinks, layout, setUrlKindsOverride, setOperatorMode } from './graph.js'
import { clearCache, getResById, store } from './cache.js'
import { showToast } from '../ext/toast.js'
import {
  dagreLayout,
  fitToVisible,
  forceLayout,
  nodeVisByLabel,
  nodeVisByPredicate,
  buildFilterPredicate,
} from './graph-utils.js'
import {
  buildTree,
  getVisibleUids,
  toggleExpand,
  hasChildren,
  getChildCount,
  getChildren,
  expandAll,
  collapseAll,
  expandPathTo,
  expandPathsToMatching,
  expandSubtree,
} from './tree-view.js'
import sidePanel from './side-panel.js'
import eventsDialog from './events-dialog.js'

// Global G6 graph instance
export const graph = new Graph({
  container: 'mainView',
  data: {},
  zoomRange: [0.1, 10],
  padding: 25,
  animation: {
    duration: 250,
    delay: 0,
  },
  background: '#0a0b0d',

  // Node defaults
  node: {
    type: 'image',
    style: {
      size: 100,
      labelFill: '#cccccc',
      labelFontSize: 18,
      labelPlacement: 'bottom',
      labelWordWrap: true,
      labelWordWrapWidth: 160,
      labelMaxLines: 3,
      stroke: '#fff',
      lineWidth: 2,
      fillOpacity: 0.5,
      cursor: 'pointer',
      haloStroke: '#3153D5',
    },
    state: {
      selected: {
        halo: true,
        haloLineWidth: 12,
        haloStrokeOpacity: 0.8,
        labelFontSize: 20,
      },
    },
  },

  edge: {
    type: 'cubic-vertical',
    style: {
      endArrow: true,
      endArrowSize: 16,
      lineWidth: 4,
      stroke: '#666',
    },
  },

  layout: dagreLayout,

  behaviors: [
    'drag-canvas',
    'drag-element',
    {
      type: 'zoom-canvas',
      sensitivity: 0.4,
    },
    {
      type: 'click-select',
      key: 'click-select-1',
      unselectedState: 'unselected',
    },
  ],
})

window.addEventListener('resize', async function () {
  graph.resize()
  await graph.fitView({ when: 'always' })
})

// Set up the event streaming for live updates once the DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  initEventStreaming()
})

// Communicate between different Kubeview tabs open at once, it's not critical
export const channel = new BroadcastChannel('kubeview')

// Alpine.js component for the main application
Alpine.data('mainApp', () => ({
  // ===== Application state ================================
  errorMessage: '',
  /** @type {string[] | null} */
  namespaces: null,
  namespace: '',
  showWelcome: true,
  isLoading: false,
  showConfigDialog: false,
  configTab: 1,
  cfg: getConfig(),
  searchQuery: '',
  showEventsDialog: false,
  showLogsDialog: false,
  logs: '',
  connState: 'connecting', // 'connecting', 'connected', 'disconnected'
  togglePaused,
  connStateClass: 'is-warning',

  /** @type {Record<string, string>} */
  serviceMetadata: {
    clusterHost: '',
    version: '',
    buildInfo: '',
    clusterMode: '',
  },

  /** @type {Array<{kind: string, group: string, version: string, resource: string}>} */
  resourceTypes: [],

  /** @type {{q?: string, kinds?: string[], owner?: string, labels?: string[]}} */
  urlFilters: {},

  operatorMode: false,
  /** @type {any} */
  operatorConfig: null,

  // ===== Functions ============================================

  /**
   * All app initialization logic is here, called automatically by Alpine.js
   */
  async init() {
    console.log('🚀 Initializing KubeView...')
    console.log(`🙍 ClientID ${getClientId()}`)

    // Listen for messages from the BroadcastChannel, just to warn about namespace changes
    channel.onmessage = (event) => {
      if (event.data.type === 'namespaceChange') {
        showToast(`Namespace was changed on a different tab<br>you will no longer see live updates here!`, 5000, 'top-center', 'warning')
      }
    }

    // Syncs us with the connection state in events.js
    window.addEventListener('connectionStateChange', (event) => {
      const newState = /** @type {CustomEvent} */ (event).detail.state
      if (this.connState === 'disconnected' && newState === 'connected') {
        showToast('Reconnected to the server!<br>Resuming live updates', 3000, 'top-center', 'success')
        if (this.operatorMode) {
          this.fetchOperatorView()
        } else {
          this.fetchNamespace()
        }
      }

      if (this.connState === 'connected' && newState === 'disconnected') {
        showToast('Disconnected from the server!<br>Live updates are paused', 3000, 'top-center', 'error')
      }

      switch (newState) {
        case 'connecting':
          this.connStateClass = 'is-warning'
          break
        case 'connected':
          this.connStateClass = 'is-success'
          break
        case 'disconnected':
          this.connStateClass = 'is-danger'
          break
        case 'paused':
          this.connStateClass = 'is-grey'
          showToast('Live updates paused', 2000, 'top-center', 'info')
          break
        default:
          this.connStateClass = 'is-warning'
      }

      this.connState = newState
    })

    // Listen for resource addition events, and re-run the search & filtering
    graph.on(GraphEvent.BEFORE_ELEMENT_CREATE, () => {
      if (this.searchQuery || this.hasActiveUrlFilters()) {
        this.applyUrlFilters()
      }
    })

    this.$watch('searchQuery', async (query) => {
      // Don't react to initial URL-driven search before data is loaded
      if (this.isLoading) return

      this.urlFilters.q = query || undefined
      this.syncUrlParams()

      if (this.operatorMode && query && query.trim().length >= 2) {
        await this.searchAndExpandPaths(query.trim())
      } else if (this.operatorMode && !query) {
        this._highlightedNodes = new Set()
        collapseAll()
        await this.renderTreeView()
      } else {
        this.applyUrlFilters()
      }
    })

    this.$watch('namespace', () => {
      console.log(`🔄 Namespace changed to: ${this.namespace}`)

      this.fetchNamespace()

      channel.postMessage({ type: 'namespaceChange', namespace: this.namespace })
    })

    // Double-click handler for expand/collapse in operator mode
    graph.on('node:dblclick', (evt) => {
      const nodeId = evt.target?.id
      if (this.operatorMode && nodeId) {
        console.log('Double-click on node:', nodeId)
        this.handleNodeExpand(nodeId)
      }
    })

    // Parse all URL parameters
    const urlParams = new URLSearchParams(window.location.search)
    const queryNs = urlParams.get('ns') || ''
    this.urlFilters = this.parseUrlFilters(urlParams)

    if (this.urlFilters.q) {
      this.searchQuery = this.urlFilters.q
    }

    if (this.urlFilters.kinds) {
      setUrlKindsOverride(this.urlFilters.kinds)
    }

    if (queryNs) {
      this.showWelcome = false
      this.namespace = queryNs
    }

    // Load the initial namespaces
    await this.refreshNamespaces()

    // Check for operator config -- if present and URL has ?view=operator or no ?ns=, switch to operator mode
    try {
      const opRes = await fetch('api/operator-config')
      if (opRes.ok) {
        const opData = await opRes.json()
        if (opData && opData.name) {
          this.operatorConfig = opData
          console.log(`📋 Operator config loaded: ${opData.name}`)

          const viewParam = urlParams.get('view')
          if (viewParam === 'operator' || !queryNs) {
            this.operatorMode = true
            this.showWelcome = false
            try {
              await this.fetchOperatorView()
            } catch (fetchErr) {
              console.error('fetchOperatorView failed:', fetchErr)
            }

            if (this.urlFilters.q) {
              await this.searchAndExpandPaths(this.urlFilters.q)
            }
          }
        }
      }
    } catch (err) {
      console.error('Operator config error:', err)
    }

    // Handle post render event to show a toast if no nodes are present
    graph.on(GraphEvent.AFTER_RENDER, () => {
      if (graph.getNodeData().length === 0) {
        showToast('No resources found<br>Check your filter settings', 3000, 'top-center', 'warning')
      }
    })
  },

  /**
   * Fetch the list of namespaces from the server
   */
  async refreshNamespaces() {
    let res
    try {
      res = await fetch('api/namespaces')
      if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`)

      const data = await res.json()
      this.namespaces = data.namespaces || []
      this.serviceMetadata.clusterHost = data.clusterHost || ''
      this.serviceMetadata.version = data.version || ''
      this.serviceMetadata.buildInfo = data.buildInfo || ''
      this.serviceMetadata.clusterMode = data.mode || ''

      // if single namespace is returned, set it as the current namespace
      if (this.namespaces && this.namespaces.length === 1) {
        this.namespace = this.namespaces[0]
      }
    } catch (err) {
      this.showError(`Failed to fetch namespaces: ${err.message}`, res)
      return
    }

    console.log(`📚 Found ${this.namespaces ? this.namespaces.length : 0} namespaces in cluster`)

    try {
      const rtRes = await fetch('api/resource-types')
      if (rtRes.ok) {
        this.resourceTypes = await rtRes.json()
        console.log(`📋 Discovered ${this.resourceTypes.length} resource types`)
      }
    } catch (_err) {
      console.warn('Failed to fetch resource types')
    }
  },

  /**
   * Refresh all data in the application
   * This will refresh the list of namespaces AND fetch the current namespace data
   */
  async refreshAll() {
    await this.refreshNamespaces()
    if (this.operatorMode) {
      await this.fetchOperatorView()
    } else if (this.namespace) {
      await this.fetchNamespace()
    }
  },

  /**
   * Display an error message in the UI and log it to the console
   * @param {string} message
   * @param {Object} res
   */
  showError(message, res) {
    this.errorMessage = message
    if (!res) {
      console.error(message)
    } else {
      res.json().then((data) => {
        this.errorMessage += `<pre>${JSON.stringify(data, null, 2) || 'No additional error information provided'}<pre>`
        console.error('API error', data)
      })
    }

    this.showWelcome = false
    this.isLoading = false
  },

  /**
   * Main function to fetch & parse the namespace data and populate the graph
   * This will clear the current graph and load new data from the server
   */
  async fetchNamespace() {
    this.errorMessage = ''

    if (this.isLoading) {
      console.warn('⚠️ Fetch already in progress, ignoring new request')
      return
    }

    this.isLoading = true

    // Only clear search if it did not come from URL
    if (!this.urlFilters.q) {
      this.searchQuery = ''
    }

    this.syncUrlParams()
    await graph.clear()

    window.dispatchEvent(new CustomEvent('closePanel'))

    let data
    let res
    try {
      res = await fetch(`api/fetch/${this.namespace}?clientID=${getClientId()}`)
      if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`)
      data = await res.json()

      this.isLoading = false
      this.showWelcome = false
    } catch (err) {
      this.showError(`Failed to fetch namespace data: ${err.message}`, res)
      return
    }

    if (this.cfg.debug) {
      console.log('📦 Fetched data:', data)
    }

    clearCache()

    for (const kindKey in data) {
      const resources = data[kindKey]
      for (const res of resources || []) {
        addResource(res)
      }
    }

    for (const kindKey in data) {
      const resources = data[kindKey]
      for (const res of resources || []) {
        processLinks(res)
      }
    }

    try {
      await graph.render()

      if (this.hasActiveUrlFilters()) {
        this.applyUrlFilters()
      }

      await fitToVisible(graph, true)
    } catch (e) {
      console.error('💥 Error rendering graph:', e)
      return
    }
  },

  /** @type {Array<{sourceUid: string, targetUid: string}>} */
  _operatorExtraEdges: [],

  /**
   * Fetch the operator-centric cross-namespace view.
   * Tries GraphQL endpoint first (fast, cached), falls back to direct K8s API.
   * Loads all data into cache, builds the tree, then renders only root nodes.
   */
  async fetchOperatorView() {
    this.errorMessage = ''

    if (this.isLoading) {
      console.warn('⚠️ Fetch already in progress, ignoring new request')
      return
    }

    this.isLoading = true
    this.operatorMode = true
    setOperatorMode(true)

    window.history.replaceState({}, '', '?view=operator')
    await graph.clear()

    window.dispatchEvent(new CustomEvent('closePanel'))

    const clusterId = await this._getClusterId()

    // Phase 1: shallow fetch (depth 2) - show operators + direct children instantly
    if (clusterId) {
      const shallow = await this._fetchGraphQL(clusterId, 2)
      if (shallow) {
        this.isLoading = false
        this.showWelcome = false
        clearCache()
        this._loadResult(shallow)
        buildTree(this._operatorExtraEdges)
        await this.renderTreeView()

        // Phase 2: full fetch in background, re-render with complete data
        this._fetchGraphQL(clusterId).then((full) => {
          if (full) {
            clearCache()
            this._loadResult(full)
            buildTree(this._operatorExtraEdges)
            this.renderTreeView()
          }
        })
        return
      }
    }

    // Fallback: single full fetch
    let result = null
    if (clusterId) {
      result = await this._fetchGraphQL(clusterId)
    }

    if (!result) {
      let res
      try {
        res = await fetch(`api/operator-view?clientID=${getClientId()}`)
        if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`)
        result = await res.json()
      } catch (err) {
        this.showError(`Failed to fetch operator view: ${err.message}`, res)
        return
      }
    }

    this.isLoading = false
    this.showWelcome = false

    clearCache()
    this._loadResult(result)
    buildTree(this._operatorExtraEdges)
    await this.renderTreeView()

    if (this.urlFilters.q) {
      await this.searchAndExpandPaths(this.urlFilters.q)
    }
  },

  /** Get the GraphQL cluster ID */
  async _getClusterId() {
    try {
      const res = await fetch('api/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ clusters { id name } }' }),
      })
      if (!res.ok) return null
      const data = await res.json()
      const clusters = data?.data?.clusters
      if (!clusters || clusters.length === 0) return null
      return clusters[0].id
    } catch (_e) {
      return null
    }
  },

  /** Fetch operator view from GraphQL - full json only for CSVs (icons, owned CRDs) */
  async _fetchGraphQL(clusterId, maxDepth = null) {
    const depthParam = maxDepth !== null ? ', $maxDepth: Int' : ''
    const depthArg = maxDepth !== null ? ', maxDepth: $maxDepth' : ''
    const query = `
      query OperatorView($clusterId: ID!${depthParam}) {
        operatorView(clusterId: $clusterId${depthArg}) {
          resources {
            uid namespace apiVersion kind name labels statusPhase statusReady
          }
          edges {
            sourceUid targetUid edgeType
          }
        }
        csvs: resources(clusterId: $clusterId, kinds: ["ClusterServiceVersion"]) {
          uid kind name namespace json
        }
      }
    `
    const variables = { clusterId }
    if (maxDepth !== null) variables.maxDepth = maxDepth
    try {
      const res = await fetch('api/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })
      if (!res.ok) return null
      const gqlResponse = await res.json()
      if (gqlResponse.errors || !gqlResponse.data?.operatorView) return null
      return this._transformGraphQLResult(gqlResponse.data.operatorView, gqlResponse.data.csvs)
    } catch (_e) {
      return null
    }
  },


  /** Transform GraphQL operatorView result into the internal format */
  _transformGraphQLResult(view, csvsFull = null) {
    const seenCSVs = new Map()
    const resources = {}

    // Build a map of CSV full json data (with spec.icon, spec.customresourcedefinitions)
    const csvJsonMap = new Map()
    for (const csv of csvsFull || []) {
      if (csv.json) {
        const obj = typeof csv.json === 'string' ? JSON.parse(csv.json) : csv.json
        csvJsonMap.set(csv.uid, obj)
      }
    }

    for (const r of view.resources || []) {
      let resObj

      // For CSVs, use the full json (has spec.icon, owned CRDs)
      if (r.kind === 'ClusterServiceVersion' && csvJsonMap.has(r.uid)) {
        resObj = csvJsonMap.get(r.uid)
      } else if (r.json) {
        resObj = typeof r.json === 'string' ? JSON.parse(r.json) : r.json
      } else {
        resObj = {
          apiVersion: r.apiVersion || '',
          kind: r.kind || '',
          metadata: {
            uid: r.uid,
            name: r.name,
            namespace: r.namespace || '',
            labels: r.labels || {},
            annotations: {},
            ownerReferences: [],
          },
          spec: {},
          status: { phase: r.statusPhase || undefined },
        }
      }

      if (r.kind === 'ClusterServiceVersion') {
        const baseName = r.name
        if (seenCSVs.has(baseName)) continue
        seenCSVs.set(baseName, r.uid)
      }

      const kindKey = r.kind.toLowerCase() + 's'
      if (!resources[kindKey]) resources[kindKey] = []
      resources[kindKey].push(resObj)
    }

    const extraEdges = (view.edges || []).map((e) => ({
      sourceUid: e.sourceUid,
      targetUid: e.targetUid,
    }))

    return { resources, extraEdges }
  },

  /** Load a result into cache and set edges */
  _loadResult(result) {
    const data = result.resources || {}
    this._operatorExtraEdges = result.extraEdges || result.edges || []

    for (const kindKey in data) {
      for (const r of data[kindKey] || []) {
        store(r)
      }
    }

    if (Array.isArray(result.resources)) {
      for (const r of result.resources) {
        const resObj = r.json || r.resource_json || r
        if (resObj.kind && resObj.metadata) {
          store(resObj)
        }
      }
    }
  },


  /** @type {Set<string>} UIDs of nodes that matched the current search/filter */
  _highlightedNodes: new Set(),

  /**
   * Re-render the graph showing only currently visible nodes (based on expand/collapse state)
   * @param {string[]|null} [focusNodeIds] - if provided, zoom to these nodes instead of fitToVisible
   */
  async renderTreeView(focusNodeIds = null) {
    await graph.clear()

    const visibleUids = getVisibleUids()

    for (const uid of visibleUids) {
      const res = getResById(uid)
      if (res) {
        addResource(res)
      }
    }

    for (const uid of visibleUids) {
      const children = getChildren(uid)
      for (const childUid of children) {
        if (visibleUids.has(childUid)) {
          addEdge(uid, childUid)
        }
      }
    }

    try {
      graph.setLayout(dagreLayout)
      await graph.render()

      await graph.layout()

      // Highlight matched/filtered nodes with a bright outline (after layout to not get overwritten)
      if (this._highlightedNodes.size > 0) {
        const allNodes = graph.getNodeData()
        const updates = allNodes
          .filter((n) => this._highlightedNodes.has(n.id))
          .map((n) => ({
            ...n,
            style: {
              ...n.style,
              stroke: '#FFD700',
              lineWidth: 4,
              shadowColor: '#FFD700',
              shadowBlur: 12,
            },
          }))

        if (updates.length > 0) {
          graph.updateNodeData(updates)
          await graph.draw()
        }
      }

      if (focusNodeIds && focusNodeIds.length > 0) {
        await this.focusOnNodes(focusNodeIds)
      } else {
        await fitToVisible(graph, true)
      }
    } catch (e) {
      console.error('💥 Error rendering graph:', e)
    }
  },

  /**
   * Search all cached resources and expand tree paths to matching nodes.
   * @param {string} query
   */
  async searchAndExpandPaths(query) {
    const q = query.toLowerCase()
    collapseAll()
    this._highlightedNodes = new Set()

    const { queryRes } = await import('./cache.js')
    const allCached = queryRes(() => true)
    const matched = allCached.filter((res) => {
      if (res._virtual) return false
      const name = (res.metadata?.name || '').toLowerCase()
      const kind = (res.kind || '').toLowerCase()
      return name.includes(q) || kind.includes(q)
    })

    if (matched.length === 0) {
      showToast(`No resources matching "${query}"`, 2000, 'top-center', 'warning')
      await this.renderTreeView()
      return
    }

    const matchedUids = new Set(matched.map((r) => r.metadata.uid))

    // Expand paths from root to each match so ancestry is visible
    for (const uid of matchedUids) {
      expandPathTo(uid)
    }

    // Expand each match and its full subtree so children are visible and expandable
    for (const uid of matchedUids) {
      expandSubtree(uid)
    }

    this._highlightedNodes = matchedUids
    await this.renderTreeView([...matchedUids])
  },


  /**
   * Handle double-click on a node in operator mode to expand/collapse
   * @param {string} nodeId
   */
  async handleNodeExpand(nodeId) {
    if (!this.operatorMode) return
    if (!hasChildren(nodeId)) {
      return
    }

    const { isExpanded } = await import('./tree-view.js')
    const wasExpanded = isExpanded(nodeId)
    toggleExpand(nodeId)

    // Pass focus targets so renderTreeView skips fitToVisible and focuses on children instead
    const focusTargets = !wasExpanded ? [nodeId, ...getChildren(nodeId)] : null
    await this.renderTreeView(focusTargets)
  },

  /**
   * Zoom and center the view on a set of node IDs
   * @param {string[]} nodeIds
   */
  async focusOnNodes(nodeIds) {
    try {
      const positions = []
      for (const id of nodeIds) {
        try {
          const pos = graph.getElementPosition(id)
          if (pos) positions.push(pos)
        } catch (_e) { /* node might not exist */ }
      }

      if (positions.length === 0) return

      const minX = Math.min(...positions.map((p) => p[0]))
      const maxX = Math.max(...positions.map((p) => p[0]))
      const minY = Math.min(...positions.map((p) => p[1]))
      const maxY = Math.max(...positions.map((p) => p[1]))

      const centerX = (minX + maxX) / 2
      const centerY = (minY + maxY) / 2
      const width = maxX - minX
      const height = maxY - minY

      const canvasSize = graph.getSize()
      const paddingX = canvasSize[0] * 0.15
      const paddingY = canvasSize[1] * 0.15

      const zoomX = (canvasSize[0] - 2 * paddingX) / Math.max(width, 100)
      const zoomY = (canvasSize[1] - 2 * paddingY) / Math.max(height, 100)
      const targetZoom = Math.min(zoomX, zoomY, 2)

      const currentZoom = graph.getZoom()
      const zoomRatio = (targetZoom / currentZoom) * 0.9

      const viewportCenter = graph.getViewportCenter()

      if (Math.abs(zoomRatio - 1) > 0.05) {
        await graph.zoomBy(zoomRatio, true, viewportCenter)
      }

      const targetPoint = [centerX, centerY]
      const currentViewport = graph.getViewportByCanvas(targetPoint)
      const translateX = canvasSize[0] / 2 - currentViewport[0]
      const translateY = canvasSize[1] / 2 - currentViewport[1]

      if (Math.abs(translateX) > 5 || Math.abs(translateY) > 5) {
        await graph.translateBy([translateX, translateY], true)
      }
    } catch (_e) {
      // Fallback: just fit the whole view
      await fitToVisible(graph, true)
    }
  },

  /**
   * Expand all nodes in the tree
   */
  async handleExpandAll() {
    expandAll()
    await this.renderTreeView()
    showToast('All nodes expanded', 1500, 'top-center', 'info')
  },

  /**
   * Collapse to root nodes only
   */
  async handleCollapseAll() {
    collapseAll()
    await this.renderTreeView()
    showToast('Collapsed to top level', 1500, 'top-center', 'info')
  },

  /**
   * Search for resources in the graph based on a query string.
   * If URL filters are active, applies the combined predicate instead of simple label search.
   * @param {string} query The search term to filter nodes by
   */
  async filterView(query) {
    query = query.trim().toLowerCase()
    this.urlFilters.q = query || undefined

    if (this.hasActiveUrlFilters()) {
      this.applyUrlFilters()
      return
    }

    const visCount = nodeVisByLabel(graph, query)

    await layout()

    if (visCount === 0 && graph.getNodeData().length > 0) {
      showToast(`No nodes found matching "${query}"`, 2000, 'top-center', 'warning')
    } else if (query === '') {
      showToast('Filter cleared, showing all nodes and edges', 2000, 'top-center', 'info')
    } else {
      showToast(`Found ${visCount} node(s) matching "${query}"`, 2000, 'top-center', 'info')
    }
  },

  /**
   * Parse URL filter parameters from search params
   * @param {URLSearchParams} params
   * @returns {{q?: string, kinds?: string[], owner?: string, labels?: string[]}}
   */
  parseUrlFilters(params) {
    /** @type {{q?: string, kinds?: string[], owner?: string, labels?: string[]}} */
    const filters = {}

    const q = params.get('q')
    if (q) filters.q = q

    const kinds = params.get('kinds')
    if (kinds) filters.kinds = kinds.split(',').filter(Boolean)

    const owner = params.get('owner')
    if (owner) filters.owner = owner

    const labelParams = params.getAll('label')
    if (labelParams.length > 0) filters.labels = labelParams

    return filters
  },

  /**
   * Check if any URL filters beyond namespace are active
   * @returns {boolean}
   */
  hasActiveUrlFilters() {
    return !!(
      this.urlFilters.q ||
      (this.urlFilters.kinds && this.urlFilters.kinds.length > 0) ||
      this.urlFilters.owner ||
      (this.urlFilters.labels && this.urlFilters.labels.length > 0)
    )
  },

  /**
   * Sync current filter state to the URL
   */
  syncUrlParams() {
    const params = new URLSearchParams()

    if (this.operatorMode) params.set('view', 'operator')
    if (this.namespace) params.set('ns', this.namespace)
    if (this.urlFilters.q) params.set('q', this.urlFilters.q)
    if (this.urlFilters.kinds && this.urlFilters.kinds.length > 0) params.set('kinds', this.urlFilters.kinds.join(','))
    if (this.urlFilters.owner) params.set('owner', this.urlFilters.owner)
    if (this.urlFilters.labels) {
      for (const label of this.urlFilters.labels) {
        params.append('label', label)
      }
    }

    window.history.replaceState({}, '', `?${params.toString()}`)
  },

  /**
   * Apply all active URL filters as a combined visibility predicate
   */
  async applyUrlFilters() {
    const predicate = buildFilterPredicate(this.urlFilters)
    const visCount = nodeVisByPredicate(graph, predicate)

    await layout()

    const totalFilters = [this.urlFilters.q, this.urlFilters.kinds, this.urlFilters.owner, this.urlFilters.labels].filter(
      Boolean,
    ).length

    if (visCount === 0 && graph.getNodeData().length > 0) {
      showToast('No nodes match the active filters', 2000, 'top-center', 'warning')
    } else if (totalFilters > 0) {
      showToast(`Showing ${visCount} node(s) matching ${totalFilters} filter(s)`, 2000, 'top-center', 'info')
    }
  },

  /**
   * Generate a shareable URL with current filters and copy to clipboard
   */
  async copyShareableLink() {
    this.syncUrlParams()
    const url = window.location.href

    try {
      await navigator.clipboard.writeText(url)
      showToast('Shareable link copied to clipboard', 2000, 'top-center', 'success')
    } catch (_err) {
      showToast('Failed to copy link', 2000, 'top-center', 'error')
    }
  },

  // Save settings to the config
  configDialogSave() {
    saveConfig(this.cfg)
    this.showConfigDialog = false
    showToast('Configuration saved successfully', 3000, 'top-center', 'success')

    // Update the graph layout with new spacing
    graph.setLayout({
      ...graph.getLayout(),
      nodeSize: this.cfg.spacing,
    })

    this.fetchNamespace()
  },

  // togglePause() {
  //   const isPaused = togglePaused()
  //   if (isPaused === null) return

  //   showToast(`Live updates ${isPaused ? 'paused' : 'resumed'}`, 2000, 'top-center', isPaused ? 'info' : 'success')
  // },

  async toolbarFit() {
    await fitToVisible(graph, true)
  },

  async toolbarForceLayout() {
    graph.setLayout(forceLayout)
    await graph.render()
    await fitToVisible(graph, true)
  },

  async toolbarDagreLayout() {
    graph.setLayout(dagreLayout)
    await graph.render()
    await fitToVisible(graph, true)
  },

  async toolbarSavePNG() {
    const imageData = await graph.toDataURL({
      type: 'image/png',
    })

    const a = document.createElement('a')
    a.href = imageData
    a.download = `kubeview-${this.namespace}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(imageData)
  },
}))

// Register sub child-components
Alpine.data('sidePanel', sidePanel)
Alpine.data('eventsDialog', eventsDialog)

// Initialize & start!
Alpine.start()
