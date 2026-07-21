// ==========================================================================================
// All Kubernetes interaction and API calls are handled in this abstracted service
// ==========================================================================================

package services

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/benc-uk/go-rest-api/pkg/sse"
	coreV1 "k8s.io/api/core/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/tools/clientcmd"
)

// ResourceTypeInfo describes a discovered API resource type
type ResourceTypeInfo struct {
	Group    string `json:"group"`
	Version  string `json:"version"`
	Resource string `json:"resource"`
	Kind     string `json:"kind"`
}

// Kubernetes is a service that connects to a Kubernetes cluster and provides access to its resources
type Kubernetes struct {
	dynamicClient     dynamic.Interface
	clientSet         kubernetes.Interface
	ClusterHost       string
	Mode              string // "in-cluster" or "out-of-cluster"
	KubeVersion       string
	UseEndpointSlices bool
	// All GVRs being watched and fetched, unified list driven by discovery
	watchedGVRs []ResourceTypeInfo

	// Operator view cache
	opViewCache     *OperatorViewResult
	opViewCacheTime time.Time
	opViewCacheMu   sync.RWMutex
}

const operatorViewCacheTTL = 2 * time.Minute

// This is used by the SSE broker to send events to connected clients
type KubeEvent struct {
	// EventType is the type of event, e.g. "add", "update", "delete" or "ping"
	EventType EventTypeEnum
	// Object is the Kubernetes resource that triggered the event
	Object *unstructured.Unstructured
}

// EventTypeEnum is an enum for the type of event
type EventTypeEnum string

const (
	// AddEvent is triggered when a resource is added
	AddEvent EventTypeEnum = "add"
	// UpdateEvent is triggered when a resource is updated
	UpdateEvent EventTypeEnum = "update"
	// DeleteEvent is triggered when a resource is deleted
	DeleteEvent EventTypeEnum = "delete"
	// PingEvent is a heartbeat event to keep the connection alive
	PingEvent EventTypeEnum = "ping"
)

// Built-in API groups that are always included regardless of CRD config
var builtinGroups = map[string]bool{
	"":                   true,
	"apps":               true,
	"batch":              true,
	"networking.k8s.io":  true,
	"autoscaling":        true,
	"discovery.k8s.io":   true,
	"apiextensions.k8s.io": true,
}

// Built-in resources to always include (group -> set of resource plurals)
var builtinResources = map[string]map[string]bool{
	"": {
		"pods":                   true,
		"services":               true,
		"configmaps":             true,
		"secrets":                true,
		"endpoints":              true,
		"events":                 true,
		"persistentvolumeclaims": true,
		"namespaces":             true,
	},
	"apps": {
		"deployments":  true,
		"replicasets":  true,
		"statefulsets": true,
		"daemonsets":   true,
	},
	"batch": {
		"jobs":     true,
		"cronjobs": true,
	},
	"networking.k8s.io": {
		"ingresses": true,
	},
	"autoscaling": {
		"horizontalpodautoscalers": true,
	},
	"discovery.k8s.io": {
		"endpointslices": true,
	},
}

// Resources to exclude from watching/fetching (noisy or internal)
var excludedResources = map[string]bool{
	"namespaces":             true,
	"componentstatuses":      true,
	"limitranges":            true,
	"resourcequotas":         true,
	"serviceaccounts":        true,
	"replicationcontrollers": true,
}

// CRDConfig holds the configuration for CRD discovery
type CRDConfig struct {
	IncludeGroups []string
	ExcludeGroups []string
}

// GetResourceTypes returns the list of discovered resource types
func (k *Kubernetes) GetResourceTypes() []ResourceTypeInfo {
	return k.watchedGVRs
}

// NewKubernetes creates a new Kubernetes service instance
// - needs an SSE broker to send events to connected clients
func NewKubernetes(sseBroker *sse.Broker[KubeEvent], singleNamespace string, crdConfig CRDConfig) (*Kubernetes, error) {
	var kubeConfig *rest.Config

	var err error

	mode := "out-of-cluster" // Default to out-of-cluster mode

	// In cluster connect using in-cluster "magic", else build config from .kube/config file
	if inCluster() {
		log.Println("⚓ Running in cluster, will try to use cluster config")

		kubeConfig, err = rest.InClusterConfig()
		mode = "in-cluster"
	} else {
		// Default location for kubeconfig file is $HOME/.kube/config
		kubeconfigFile := filepath.Join(os.Getenv("HOME"), ".kube", "config")

		// If KUBECONFIG environment variable is set, use that instead
		if os.Getenv("KUBECONFIG") != "" {
			kubeconfigFile = os.Getenv("KUBECONFIG")
		}

		log.Println("🏠 Running outside cluster, will use config file:", kubeconfigFile)
		kubeConfig, err = clientcmd.BuildConfigFromFlags("", kubeconfigFile)
	}

	if err != nil {
		return nil, err
	}

	log.Println("🌐 Kubernetes host:", kubeConfig.Host)

	discClient, err := discovery.NewDiscoveryClientForConfig(kubeConfig)
	if err != nil {
		return nil, err
	}

	serverVersion, err := discClient.ServerVersion()
	if err != nil {
		log.Println("⛔ Failed to connect to Kubernetes API", err)
		return nil, err
	} else {
		log.Println("✅ Connected to Kubernetes API, version:", serverVersion.String())
	}

	useEndpointSlices := false

	// https://kubernetes.io/blog/2025/04/24/endpoints-deprecation/
	if serverVersion.Major == "1" && serverVersion.Minor >= "33" {
		log.Println("🔄 Kubernetes version > 1.32 Using EndpointSlices for service endpoints")
		useEndpointSlices = true
	}

	dynamicClient, err := dynamic.NewForConfig(kubeConfig)
	if err != nil {
		return nil, err
	}

	clientSet, err := kubernetes.NewForConfig(kubeConfig)
	if err != nil {
		return nil, err
	}

	// Discover all namespaced API resources
	watchedGVRs := discoverResources(discClient, crdConfig, useEndpointSlices)

	namespace := coreV1.NamespaceAll
	if singleNamespace != "" {
		namespace = singleNamespace
		log.Println("🔑 Authorised for a single namespace:", namespace)
	}

	log.Printf("👀 Setting up resource watchers for %d resource types...", len(watchedGVRs))

	factory := dynamicinformer.NewFilteredDynamicSharedInformerFactory(
		dynamicClient, time.Minute, namespace, nil)

	for _, rt := range watchedGVRs {
		gvr := schema.GroupVersionResource{Group: rt.Group, Version: rt.Version, Resource: rt.Resource}
		_, _ = factory.ForResource(gvr).Informer().AddEventHandler(getHandlerFuncs(sseBroker))
	}

	factory.Start(context.Background().Done())
	factory.WaitForCacheSync(context.Background().Done())

	return &Kubernetes{
		dynamicClient:     dynamicClient,
		clientSet:         clientSet,
		ClusterHost:       kubeConfig.Host,
		Mode:              mode,
		UseEndpointSlices: useEndpointSlices,
		KubeVersion:       serverVersion.String(),
		watchedGVRs:       watchedGVRs,
	}, nil
}

// discoverResources uses the discovery API to build the unified list of GVRs to watch and fetch
func discoverResources(discClient *discovery.DiscoveryClient, crdConfig CRDConfig, useEndpointSlices bool) []ResourceTypeInfo {
	var result []ResourceTypeInfo

	crdInclude := make(map[string]bool, len(crdConfig.IncludeGroups))
	for _, g := range crdConfig.IncludeGroups {
		crdInclude[g] = true
	}

	crdExclude := make(map[string]bool, len(crdConfig.ExcludeGroups))
	for _, g := range crdConfig.ExcludeGroups {
		crdExclude[g] = true
	}

	apiResourceLists, err := discClient.ServerPreferredNamespacedResources()
	if err != nil {
		log.Printf("⚠️ Partial discovery error (some groups may be unavailable): %v", err)
	}

	for _, apiResList := range apiResourceLists {
		if apiResList == nil {
			continue
		}

		gv, parseErr := schema.ParseGroupVersion(apiResList.GroupVersion)
		if parseErr != nil {
			log.Printf("⚠️ Skipping unparseable GroupVersion %q: %v", apiResList.GroupVersion, parseErr)
			continue
		}

		for _, apiRes := range apiResList.APIResources {
			// Skip sub-resources (e.g. pods/log, pods/status)
			if strings.Contains(apiRes.Name, "/") {
				continue
			}

			// Must support list and watch for informers
			verbs := apiRes.Verbs
			if !containsAll(verbs, "list", "watch") {
				continue
			}

			group := gv.Group
			resource := apiRes.Name

			if excludedResources[resource] {
				continue
			}

			// Handle endpoints vs endpointslices toggle
			if resource == "endpoints" && useEndpointSlices {
				continue
			}
			if resource == "endpointslices" && !useEndpointSlices {
				continue
			}

			isBuiltin := false
			if groupRes, ok := builtinResources[group]; ok {
				if groupRes[resource] {
					isBuiltin = true
				}
			}

			if !isBuiltin {
				if !shouldIncludeCRD(group, crdInclude, crdExclude) {
					continue
				}
			}

			result = append(result, ResourceTypeInfo{
				Group:    group,
				Version:  gv.Version,
				Resource: resource,
				Kind:     apiRes.Kind,
			})
		}
	}

	log.Printf("📋 Discovered %d resource types to watch", len(result))

	for _, rt := range result {
		if !builtinGroups[rt.Group] {
			log.Printf("   🔹 CRD: %s/%s (%s)", rt.Group, rt.Resource, rt.Kind)
		}
	}

	return result
}

func shouldIncludeCRD(group string, include, exclude map[string]bool) bool {
	if builtinGroups[group] {
		return true
	}

	if exclude[group] {
		return false
	}

	// If include list is specified, only include those groups
	if len(include) > 0 {
		return include[group]
	}

	// No include list means include all non-excluded CRDs
	return true
}

func containsAll(verbs metaV1.Verbs, required ...string) bool {
	have := make(map[string]bool, len(verbs))
	for _, v := range verbs {
		have[v] = true
	}

	for _, r := range required {
		if !have[r] {
			return false
		}
	}

	return true
}

// Get namespaces
func (k *Kubernetes) GetNamespaces() ([]string, error) {
	out := []string{}

	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}

	l, err := k.dynamicClient.Resource(gvr).List(context.TODO(), metaV1.ListOptions{})
	if err != nil {
		log.Println("💥 Failed to get namespaces:", err)
		return nil, err
	}

	for _, ns := range l.Items {
		out = append(out, ns.GetName())
	}

	return out, nil
}

// Validate if a namespace exists in the cluster
func (k *Kubernetes) CheckNamespaceExists(ns string) bool {
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}

	_, err := k.dynamicClient.Resource(gvr).Get(context.TODO(), ns, metaV1.GetOptions{})

	return err == nil
}

// Retrieves all resources in a specific namespace using the discovered GVR list
func (k *Kubernetes) FetchNamespace(ns string) (map[string][]unstructured.Unstructured, error) {
	if ns == "" {
		return nil, errors.New("namespace is empty")
	}

	data := make(map[string][]unstructured.Unstructured)

	for _, rt := range k.watchedGVRs {
		items, _ := k.GetResources(ns, rt.Group, rt.Version, rt.Resource)
		data[rt.Resource] = items
	}

	// Clean up the managed fields and redact sensitive data
	for _, items := range data {
		for i := range items {
			items[i].SetManagedFields(nil)

			if items[i].GetKind() == "Secret" || items[i].GetKind() == "ConfigMap" {
				if d, ok := items[i].Object["data"].(map[string]interface{}); ok {
					for key := range d {
						d[key] = "*REDACTED*"
					}
				}
			}
		}
	}

	return data, nil
}

// Generic function to list resources from a specific namespace
func (k *Kubernetes) GetResources(ns string, grp string, ver string, res string) ([]unstructured.Unstructured, error) {
	gvr := schema.GroupVersionResource{Group: grp, Version: ver, Resource: res}

	l, err := k.dynamicClient.Resource(gvr).Namespace(ns).List(context.TODO(), metaV1.ListOptions{Limit: 1000})
	if err != nil {
		log.Printf("💥 Failed to get %s %v", res, err)
		return nil, err
	}

	return l.Items, nil
}

// Retrieves the logs of a specific pod in a given namespace
func (k *Kubernetes) GetPodLogs(ns, podName string, lineCount int) (string, error) {
	if ns == "" || podName == "" {
		return "", errors.New("namespace or pod name is empty")
	}

	if lineCount <= 0 {
		lineCount = 100
	}

	req := k.clientSet.CoreV1().Pods(ns).GetLogs(podName, &coreV1.PodLogOptions{
		TailLines: &[]int64{int64(lineCount)}[0],
	})

	logs, err := req.DoRaw(context.TODO())
	if err != nil {
		log.Printf("💥 Failed to get logs for pod %s in namespace %s: %v", podName, ns, err)
		return "", err
	}

	return string(logs), nil
}

// GetClusterScopedResource fetches a single cluster-scoped resource by GVR and name
func (k *Kubernetes) GetClusterScopedResource(grp, ver, res, name string) (*unstructured.Unstructured, error) {
	gvr := schema.GroupVersionResource{Group: grp, Version: ver, Resource: res}

	obj, err := k.dynamicClient.Resource(gvr).Get(context.TODO(), name, metaV1.GetOptions{})
	if err != nil {
		return nil, err
	}

	return obj, nil
}

// ListClusterScopedResources lists cluster-scoped resources by GVR
func (k *Kubernetes) ListClusterScopedResources(grp, ver, res string) ([]unstructured.Unstructured, error) {
	gvr := schema.GroupVersionResource{Group: grp, Version: ver, Resource: res}

	l, err := k.dynamicClient.Resource(gvr).List(context.TODO(), metaV1.ListOptions{Limit: 1000})
	if err != nil {
		return nil, err
	}

	return l.Items, nil
}

// OperatorViewConfig mirrors the JSON config shape needed by FetchOperatorView
type OperatorViewConfig struct {
	Operators  []OperatorViewEntry
	ExtraLinks []OperatorViewExtraLink
}

type OperatorViewEntry struct {
	CSVPrefix       string
	Namespace       string
	Entrypoints     []OperatorViewEntrypoint
	WatchNamespaces []string
}

type OperatorViewEntrypoint struct {
	Kind string
	Name string
}

type OperatorViewExtraLink struct {
	From OperatorViewLinkRef
	To   []OperatorViewLinkRef
}

type OperatorViewLinkRef struct {
	Kind       string
	Name       string
	NamePrefix string
}

// OperatorViewResult holds the result of an operator view fetch
type OperatorViewResult struct {
	Resources  map[string][]unstructured.Unstructured `json:"resources"`
	ExtraEdges []ExtraEdge                            `json:"extraEdges"`
}

type ExtraEdge struct {
	SourceUID string `json:"sourceUid"`
	TargetUID string `json:"targetUid"`
}

// FetchOperatorView fetches all resources related to operators defined in the config.
// It walks the ownership tree from CSV and entrypoint CRs across namespaces.
// FetchOperatorViewCached returns a cached result if available and fresh, otherwise fetches and caches
func (k *Kubernetes) FetchOperatorViewCached(cfg OperatorViewConfig) (*OperatorViewResult, error) {
	k.opViewCacheMu.RLock()
	if k.opViewCache != nil && time.Since(k.opViewCacheTime) < operatorViewCacheTTL {
		cached := k.opViewCache
		k.opViewCacheMu.RUnlock()
		log.Printf("⚡ Serving operator view from cache (age: %s)", time.Since(k.opViewCacheTime).Round(time.Second))
		return cached, nil
	}
	k.opViewCacheMu.RUnlock()

	result, err := k.FetchOperatorView(cfg)
	if err != nil {
		return nil, err
	}

	k.opViewCacheMu.Lock()
	k.opViewCache = result
	k.opViewCacheTime = time.Now()
	k.opViewCacheMu.Unlock()

	return result, nil
}

// InvalidateOperatorViewCache clears the cache (e.g. when an SSE event arrives)
func (k *Kubernetes) InvalidateOperatorViewCache() {
	k.opViewCacheMu.Lock()
	k.opViewCache = nil
	k.opViewCacheMu.Unlock()
}

func (k *Kubernetes) FetchOperatorView(cfg OperatorViewConfig) (*OperatorViewResult, error) {
	data := make(map[string][]unstructured.Unstructured)
	uidSet := make(map[string]bool)
	var extraEdges []ExtraEdge

	addItem := func(item unstructured.Unstructured) {
		uid := string(item.GetUID())
		if uidSet[uid] {
			return
		}
		uidSet[uid] = true
		item.SetManagedFields(nil)

		if item.GetKind() == "Secret" || item.GetKind() == "ConfigMap" {
			if d, ok := item.Object["data"].(map[string]interface{}); ok {
				for key := range d {
					d[key] = "*REDACTED*"
				}
			}
		}

		resource := strings.ToLower(item.GetKind()) + "s"
		data[resource] = append(data[resource], item)
	}

	// allResources collects everything for the ownership walk
	var allResources []unstructured.Unstructured

	for _, op := range cfg.Operators {
		// 1. Find the CSV
		csvs, err := k.GetResources(op.Namespace, "operators.coreos.com", "v1alpha1", "clusterserviceversions")
		if err != nil {
			log.Printf("⚠️ Could not list CSVs in %s: %v", op.Namespace, err)
			continue
		}

		var matchedCSV *unstructured.Unstructured
		for i := range csvs {
			if strings.HasPrefix(csvs[i].GetName(), op.CSVPrefix) {
				matchedCSV = &csvs[i]
				break
			}
		}

		if matchedCSV == nil {
			log.Printf("⚠️ CSV with prefix %q not found in %s", op.CSVPrefix, op.Namespace)
			continue
		}

		log.Printf("📦 Found CSV: %s in %s", matchedCSV.GetName(), op.Namespace)
		addItem(*matchedCSV)
		allResources = append(allResources, *matchedCSV)

		// 2. Fetch entrypoint CRs (cluster-scoped)
		for _, ep := range op.Entrypoints {
			pluralName := strings.ToLower(ep.Kind) + "s"
			group := findGroupForKind(k, ep.Kind)
			if group == "" {
				log.Printf("⚠️ Could not find API group for kind %s", ep.Kind)
				continue
			}

			obj, err := k.GetClusterScopedResource(group, "v1", pluralName, ep.Name)
			if err != nil {
				obj, err = k.GetClusterScopedResource(group, "v1alpha1", pluralName, ep.Name)
			}
			if err != nil {
				log.Printf("⚠️ Could not fetch %s/%s: %v", ep.Kind, ep.Name, err)
				continue
			}

			log.Printf("📌 Entrypoint: %s/%s (uid=%s)", ep.Kind, ep.Name, obj.GetUID())
			addItem(*obj)
			allResources = append(allResources, *obj)
		}

		// 3. Build a focused GVR list: standard types + CSV-owned CRDs
		focusedGVRs := coreGVRsForOperatorView(k.UseEndpointSlices)
		ownedCRDs := getCSVOwnedKinds(matchedCSV)

		for _, kind := range ownedCRDs {
			group := findGroupForKind(k, kind)
			if group == "" {
				continue
			}
			pluralName := strings.ToLower(kind) + "s"
			ver := findVersionForGVR(k, group, pluralName)
			focusedGVRs = append(focusedGVRs, ResourceTypeInfo{
				Group: group, Version: ver, Resource: pluralName, Kind: kind,
			})
		}

		// Also add OLM types we need
		focusedGVRs = append(focusedGVRs, ResourceTypeInfo{
			Group: "operators.coreos.com", Version: "v1alpha1", Resource: "clusterserviceversions", Kind: "ClusterServiceVersion",
		})
		focusedGVRs = append(focusedGVRs, ResourceTypeInfo{
			Group: "route.openshift.io", Version: "v1", Resource: "routes", Kind: "Route",
		})

		log.Printf("📋 Focused GVR list for %s: %d resource types", op.CSVPrefix, len(focusedGVRs))

		// 4. Fetch namespaced resources using the focused list
		namespaces := op.WatchNamespaces
		if len(namespaces) == 0 {
			namespaces = []string{op.Namespace}
		}

		for _, ns := range namespaces {
			for _, rt := range focusedGVRs {
				items, _ := k.GetResources(ns, rt.Group, rt.Version, rt.Resource)
				for _, item := range items {
					addItem(item)
					allResources = append(allResources, item)
				}
			}
		}

		// 5. Also fetch cluster-scoped CRD instances
		for _, kind := range ownedCRDs {
			group := findGroupForKind(k, kind)
			if group == "" {
				continue
			}
			pluralName := strings.ToLower(kind) + "s"
			ver := findVersionForGVR(k, group, pluralName)

			items, err := k.ListClusterScopedResources(group, ver, pluralName)
			if err != nil {
				continue
			}

			for _, item := range items {
				addItem(item)
				allResources = append(allResources, item)
			}
		}
	}

	// 5. Apply extraLinks rules
	for _, rule := range cfg.ExtraLinks {
		var fromUIDs []string

		for _, res := range allResources {
			if res.GetKind() != rule.From.Kind {
				continue
			}

			if rule.From.Name != "" && res.GetName() != rule.From.Name {
				continue
			}

			if rule.From.NamePrefix != "" && !strings.HasPrefix(res.GetName(), rule.From.NamePrefix) {
				continue
			}

			fromUIDs = append(fromUIDs, string(res.GetUID()))
		}

		for _, toRef := range rule.To {
			for _, res := range allResources {
				if res.GetKind() != toRef.Kind {
					continue
				}

				if toRef.Name != "" && res.GetName() != toRef.Name {
					continue
				}

				if toRef.NamePrefix != "" && !strings.HasPrefix(res.GetName(), toRef.NamePrefix) {
					continue
				}

				targetUID := string(res.GetUID())
				for _, srcUID := range fromUIDs {
					extraEdges = append(extraEdges, ExtraEdge{
						SourceUID: srcUID,
						TargetUID: targetUID,
					})
				}
			}
		}
	}

	return &OperatorViewResult{
		Resources:  data,
		ExtraEdges: extraEdges,
	}, nil
}

// getCSVOwnedKinds extracts the list of owned CRD kinds from a CSV
func getCSVOwnedKinds(csv *unstructured.Unstructured) []string {
	owned, found, err := unstructured.NestedSlice(csv.Object, "spec", "customresourcedefinitions", "owned")
	if err != nil || !found {
		return nil
	}

	seen := make(map[string]bool)
	var kinds []string

	for _, item := range owned {
		if m, ok := item.(map[string]interface{}); ok {
			if kind, ok := m["kind"].(string); ok && !seen[kind] {
				seen[kind] = true
				kinds = append(kinds, kind)
			}
		}
	}

	return kinds
}

// coreGVRsForOperatorView returns the minimal set of standard resource types needed for an operator view
func coreGVRsForOperatorView(useEndpointSlices bool) []ResourceTypeInfo {
	core := []ResourceTypeInfo{
		{Group: "", Version: "v1", Resource: "pods", Kind: "Pod"},
		{Group: "", Version: "v1", Resource: "services", Kind: "Service"},
		{Group: "", Version: "v1", Resource: "configmaps", Kind: "ConfigMap"},
		{Group: "", Version: "v1", Resource: "secrets", Kind: "Secret"},
		{Group: "", Version: "v1", Resource: "events", Kind: "Event"},
		{Group: "", Version: "v1", Resource: "persistentvolumeclaims", Kind: "PersistentVolumeClaim"},
		{Group: "apps", Version: "v1", Resource: "deployments", Kind: "Deployment"},
		{Group: "apps", Version: "v1", Resource: "replicasets", Kind: "ReplicaSet"},
		{Group: "apps", Version: "v1", Resource: "statefulsets", Kind: "StatefulSet"},
		{Group: "apps", Version: "v1", Resource: "daemonsets", Kind: "DaemonSet"},
		{Group: "batch", Version: "v1", Resource: "jobs", Kind: "Job"},
		{Group: "batch", Version: "v1", Resource: "cronjobs", Kind: "CronJob"},
		{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses", Kind: "Ingress"},
	}

	if useEndpointSlices {
		core = append(core, ResourceTypeInfo{Group: "discovery.k8s.io", Version: "v1", Resource: "endpointslices", Kind: "EndpointSlice"})
	} else {
		core = append(core, ResourceTypeInfo{Group: "", Version: "v1", Resource: "endpoints", Kind: "Endpoints"})
	}

	return core
}

// findVersionForGVR looks up the API version for a group/resource from the watched list
func findVersionForGVR(k *Kubernetes, group, resource string) string {
	for _, rt := range k.watchedGVRs {
		if rt.Group == group && rt.Resource == resource {
			return rt.Version
		}
	}

	return "v1"
}

// findGroupForKind searches the watched GVRs for the API group of a given kind
func findGroupForKind(k *Kubernetes, kind string) string {
	for _, rt := range k.watchedGVRs {
		if rt.Kind == kind {
			return rt.Group
		}
	}

	// Fallback: check common ODH groups
	kindLower := strings.ToLower(kind)
	commonGroups := []string{
		"datasciencecluster.opendatahub.io",
		"dscinitialization.opendatahub.io",
		"components.platform.opendatahub.io",
		"services.platform.opendatahub.io",
		"features.opendatahub.io",
		"serving.kserve.io",
		"trustyai.opendatahub.io",
	}

	for _, group := range commonGroups {
		items, err := k.ListClusterScopedResources(group, "v1", kindLower+"s")
		if err == nil && len(items) >= 0 {
			return group
		}
	}

	return ""
}

func inCluster() bool {
	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		return true
	}

	return false
}

// getHandlerFuncs returns the event handlers for the Kubernetes informers, which send events through the SSE broker
func getHandlerFuncs(b *sse.Broker[KubeEvent]) cache.ResourceEventHandlerFuncs {
	return cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj interface{}) {
			u := obj.(*unstructured.Unstructured)
			namespace := u.GetNamespace()
			if namespace == "" {
				return
			}

			u.SetManagedFields(nil)
			b.SendToGroup(namespace, KubeEvent{
				EventType: AddEvent,
				Object:    u,
			})
		},

		UpdateFunc: func(oldObj, newObj interface{}) {
			u := newObj.(*unstructured.Unstructured)
			namespace := u.GetNamespace()
			if namespace == "" {
				return
			}

			u.SetManagedFields(nil)
			b.SendToGroup(namespace, KubeEvent{
				EventType: UpdateEvent,
				Object:    u,
			})
		},

		DeleteFunc: func(obj interface{}) {
			u := obj.(*unstructured.Unstructured)
			namespace := u.GetNamespace()
			if namespace == "" {
				return
			}

			u.SetManagedFields(nil)
			b.SendToGroup(namespace, KubeEvent{
				EventType: DeleteEvent,
				Object:    u,
			})
		},
	}
}
