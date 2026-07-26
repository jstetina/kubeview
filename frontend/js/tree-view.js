//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Tree view module for operator mode
// Manages expand/collapse state for hierarchical resource visualization.
// Injects virtual CRD-kind nodes between CSVs and CR instances.
// ==========================================================================================

import { queryRes, getResById, store } from './cache.js'

/** @type {Set<string>} UIDs of currently expanded nodes */
const expandedNodes = new Set()

/** @type {Map<string, string[]>} parent UID -> child UIDs */
const childrenMap = new Map()

/** @type {Map<string, string>} child UID -> parent UID */
const parentMap = new Map()

/** @type {Set<string>} UIDs of root nodes */
const rootNodes = new Set()

/** @type {string[][]} All edges [sourceUid, targetUid] */
let allEdgePairs = []

/** @type {Set<string>} UIDs of virtual CRD kind nodes */
const virtualNodes = new Set()

/** @type {Map<string, any>} virtual UID -> synthetic resource object */
const virtualNodeData = new Map()

// Kinds that serve as root nodes
const ROOT_KINDS = new Set(['ClusterServiceVersion'])
const ENTRYPOINT_KINDS = new Set(['DataScienceCluster', 'DSCInitialization'])

/**
 * Generate a shortname from a CamelCase kind: DataScienceCluster -> DSC
 * @param {string} kind
 * @returns {string}
 */
export function kindShortName(kind) {
  const caps = kind.replace(/[a-z]/g, '')
  return caps.length >= 2 ? caps : kind.substring(0, 3).toUpperCase()
}

/**
 * Create a virtual CRD kind node and register it.
 * @param {Resource} csv
 * @param {string} kind
 * @param {string} displayName
 * @param {string} crdName
 * @param {Set<string>} allUids
 * @returns {string} the virtual UID
 */
function createVirtualCrdNode(csv, kind, displayName, crdName, allUids, hasInstances = false) {
  const virtualUid = `crd-kind:${csv.metadata.uid}:${kind}`
  const shortName = kindShortName(kind)

  const virtualRes = {
    kind: 'CustomResourceDefinition',
    apiVersion: 'apiextensions.k8s.io/v1',
    metadata: {
      uid: virtualUid,
      name: displayName || kind,
      namespace: '',
      labels: {},
      annotations: {},
      ownerReferences: [],
    },
    spec: { _crdKind: kind, _crdGroup: crdName ? crdName.split('.').slice(1).join('.') : '' },
    status: {},
    _virtual: true,
    _shortName: shortName,
    _hasChildren: hasInstances,
    _displayName: displayName || kind,
  }

  virtualNodeData.set(virtualUid, virtualRes)
  virtualNodes.add(virtualUid)
  store(virtualRes)
  allUids.add(virtualUid)

  return virtualUid
}

/**
 * Build the tree from cached resources and DB edges.
 * Injects virtual CRD-kind nodes between CSVs and their owned CR instances.
 * @param {Array<{sourceUid: string, targetUid: string, edgeType?: string}>} edges
 * @param {string[]} [entrypointKinds] - dynamic entrypoint kinds from operator config
 */
export function buildTree(edges = [], entrypointKinds = []) {
  childrenMap.clear()
  parentMap.clear()
  rootNodes.clear()
  expandedNodes.clear()
  virtualNodes.clear()
  virtualNodeData.clear()
  allEdgePairs = edges.map((e) => [e.sourceUid, e.targetUid, e.edgeType || 'owner'])

  const dynamicEntrypoints = new Set(entrypointKinds)

  const allResources = queryRes(() => true)
  const allUids = new Set(allResources.map((r) => r.metadata.uid))
  const resourcesByKind = new Map()

  for (const res of allResources) {
    const list = resourcesByKind.get(res.kind) || []
    list.push(res)
    resourcesByKind.set(res.kind, list)
  }

  // Step 1: Build parent-child from edges, prioritizing ownership edges
  const edgePriority = { owner: 0, csv_owned: 1, synthetic: 2, ref: 3, endpoint: 4 }
  const sortedEdges = [...allEdgePairs].sort((a, b) =>
    (edgePriority[a[2]] ?? 5) - (edgePriority[b[2]] ?? 5)
  )
  for (const [srcUid, tgtUid] of sortedEdges) {
    if (!allUids.has(srcUid) || !allUids.has(tgtUid)) continue
    if (parentMap.has(tgtUid)) continue

    parentMap.set(tgtUid, srcUid)
    const siblings = childrenMap.get(srcUid) || []
    if (!siblings.includes(tgtUid)) {
      siblings.push(tgtUid)
      childrenMap.set(srcUid, siblings)
    }
  }

  // Step 2: ownerReferences fallback for resources not yet connected
  for (const res of allResources) {
    const uid = res.metadata.uid
    if (parentMap.has(uid)) continue

    if (res.metadata.ownerReferences) {
      for (const ref of res.metadata.ownerReferences) {
        if (allUids.has(ref.uid)) {
          addEdge(ref.uid, uid)
          break
        }
      }
    }
  }

  // Step 3: determine roots (CSVs and entrypoints with no parent)
  for (const res of allResources) {
    const uid = res.metadata.uid
    if ((ROOT_KINDS.has(res.kind) || ENTRYPOINT_KINDS.has(res.kind) || dynamicEntrypoints.has(res.kind)) && !parentMap.has(uid)) {
      rootNodes.add(uid)
    }
  }

  // Step 5: orphaned resources (cached but no parent in tree, not a root, not built-in noise)
  // Group them by kind under virtual CRD-kind nodes attached to a catch-all "Discovered CRDs" root
  const SKIP_ORPHAN_KINDS = new Set([
    'ClusterServiceVersion',
    'ConfigMap', 'Secret', 'Service', 'Endpoints', 'Event',
    'CustomResourceDefinition',
    ...dynamicEntrypoints,
  ])

  const orphansByKind = new Map()
  for (const res of allResources) {
    const uid = res.metadata.uid
    if (parentMap.has(uid) || rootNodes.has(uid)) continue
    if (SKIP_ORPHAN_KINDS.has(res.kind)) continue
    if (res._virtual) continue

    const list = orphansByKind.get(res.kind) || []
    list.push(res)
    orphansByKind.set(res.kind, list)
  }

  if (orphansByKind.size > 0) {
    // Find the primary CSV to attach these to, or create a standalone root
    const allCSVs = resourcesByKind.get('ClusterServiceVersion') || []
    const primaryCSV = allCSVs.length > 0 ? allCSVs[0] : null
    const parentUid = primaryCSV ? primaryCSV.metadata.uid : null

    for (const [kind, instances] of orphansByKind) {
      const shortName = kindShortName(kind)
      const anchorUid = parentUid || `orphan-root`

      if (!parentUid) {
        // Create a root node for orphans if no CSV exists
        if (!rootNodes.has('orphan-root')) {
          const rootRes = {
            kind: 'CustomResourceDefinition', apiVersion: 'v1',
            metadata: { uid: 'orphan-root', name: 'Discovered CRDs', namespace: '', labels: {}, annotations: {}, ownerReferences: [] },
            spec: {}, status: {}, _virtual: true, _displayName: 'Discovered CRDs',
          }
          virtualNodeData.set('orphan-root', rootRes)
          virtualNodes.add('orphan-root')
          store(rootRes)
          allUids.add('orphan-root')
          rootNodes.add('orphan-root')
        }
      }

      const virtualUid = `crd-kind:orphan:${kind}`
      const virtualRes = {
        kind: 'CustomResourceDefinition', apiVersion: 'apiextensions.k8s.io/v1',
        metadata: { uid: virtualUid, name: kind, namespace: '', labels: {}, annotations: {}, ownerReferences: [] },
        spec: { _crdKind: kind }, status: {},
        _virtual: true, _shortName: shortName, _hasChildren: true,
        _displayName: kind,
      }
      virtualNodeData.set(virtualUid, virtualRes)
      virtualNodes.add(virtualUid)
      store(virtualRes)
      allUids.add(virtualUid)
      addEdge(anchorUid, virtualUid)

      for (const inst of instances) {
        addEdge(virtualUid, inst.metadata.uid)
      }
    }
  }
}

function addEdge(srcUid, tgtUid) {
  if (parentMap.has(tgtUid)) return

  parentMap.set(tgtUid, srcUid)
  const siblings = childrenMap.get(srcUid) || []
  if (!siblings.includes(tgtUid)) {
    siblings.push(tgtUid)
    childrenMap.set(srcUid, siblings)
  }
  allEdgePairs.push([srcUid, tgtUid])
}

/**
 * Get UIDs that should be visible: root nodes + children of expanded nodes
 * @returns {Set<string>}
 */
export function getVisibleUids() {
  const visible = new Set()

  for (const uid of rootNodes) {
    visible.add(uid)
    if (expandedNodes.has(uid)) {
      addVisibleChildren(uid, visible)
    }
  }

  return visible
}

function addVisibleChildren(parentUid, visible) {
  const children = childrenMap.get(parentUid) || []

  for (const childUid of children) {
    visible.add(childUid)
    if (expandedNodes.has(childUid)) {
      addVisibleChildren(childUid, visible)
    }
  }
}

/**
 * Toggle expand/collapse for a node
 * @param {string} uid
 * @returns {boolean} true if node is now expanded
 */
export function toggleExpand(uid) {
  if (expandedNodes.has(uid)) {
    collapseRecursive(uid)
    return false
  }

  expandedNodes.add(uid)
  return true
}

function collapseRecursive(uid) {
  expandedNodes.delete(uid)
  const children = childrenMap.get(uid) || []

  for (const childUid of children) {
    collapseRecursive(childUid)
  }
}

/** @param {string} uid */
export function hasChildren(uid) {
  return (childrenMap.get(uid) || []).length > 0
}

/** @param {string} uid */
export function isExpanded(uid) {
  return expandedNodes.has(uid)
}

/** @param {string} uid */
export function getChildren(uid) {
  return childrenMap.get(uid) || []
}

/** @param {string} uid */
export function getChildCount(uid) {
  return (childrenMap.get(uid) || []).length
}

/** @param {string} uid */
export function getDescendantCount(uid) {
  let count = 0
  const children = childrenMap.get(uid) || []

  for (const childUid of children) {
    count += 1 + getDescendantCount(childUid)
  }

  return count
}

/**
 * Expand a node and all its descendants recursively.
 * @param {string} uid
 */
export function expandSubtree(uid) {
  if (!hasChildren(uid)) return
  expandedNodes.add(uid)
  const children = childrenMap.get(uid) || []
  for (const childUid of children) {
    expandSubtree(childUid)
  }
}

export function expandAll() {
  const allResources = queryRes(() => true)

  for (const res of allResources) {
    if (hasChildren(res.metadata.uid)) {
      expandedNodes.add(res.metadata.uid)
    }
  }

  for (const uid of virtualNodes) {
    if (hasChildren(uid)) {
      expandedNodes.add(uid)
    }
  }
}

export function collapseAll() {
  expandedNodes.clear()
}

/**
 * Expand the full path from root to a target node (and all its ancestors).
 * @param {string} targetUid
 */
export function expandPathTo(targetUid) {
  let current = parentMap.get(targetUid)
  while (current) {
    expandedNodes.add(current)
    current = parentMap.get(current)
  }
}

/**
 * Get the ancestor chain UIDs from a target node up to the root (inclusive).
 * @param {string} targetUid
 * @returns {string[]}
 */
export function getAncestorChain(targetUid) {
  const chain = []
  let current = parentMap.get(targetUid)
  while (current) {
    chain.push(current)
    current = parentMap.get(current)
  }
  return chain
}

/**
 * Expand paths to all matching nodes (by predicate on cached resources).
 * Returns the UIDs that matched.
 * @param {function(any): boolean} predicate
 * @returns {string[]}
 */
export function expandPathsToMatching(predicate) {
  const allResources = queryRes(() => true)
  const matched = []

  for (const res of allResources) {
    if (predicate(res)) {
      matched.push(res.metadata.uid)
      expandPathTo(res.metadata.uid)
    }
  }

  return matched
}

export function getRootNodes() {
  return rootNodes
}

/** @param {string} uid */
export function isVirtualNode(uid) {
  return virtualNodes.has(uid)
}

/** @param {string} uid */
export function getVirtualNodeData(uid) {
  return virtualNodeData.get(uid) || null
}
