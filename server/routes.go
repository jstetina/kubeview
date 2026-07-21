// ==========================================================================================
// HTTP routes and handlers for the Kubeview API
// ==========================================================================================

package main

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"regexp"
	"strconv"

	"github.com/benc-uk/go-rest-api/pkg/problem"
	kubeview "github.com/benc-uk/kubeview"
	"github.com/benc-uk/kubeview/server/services"
	"github.com/go-chi/chi/v5"
)

// All application routes are defined here
func (s *KubeviewAPI) AddRoutes(r *chi.Mux) {
	// Create a sub-filesystem rooted at the "frontend" directory within the embedded FS
	frontendFS, err := fs.Sub(kubeview.FrontendFS, "frontend")
	if err != nil {
		log.Fatalf("💥 Failed to create sub-filesystem for embedded frontend dir: %v", err)
	}

	// Serve the index.html file from the embedded frontend folder
	r.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		index, err := fs.ReadFile(frontendFS, "index.html")
		if err != nil {
			http.Error(w, "index.html not found", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(index)
	})

	// Serve the embedded frontend folder, which contains static files, JS, CSS, images, etc.
	// This is how the frontend is served, it's just static files embedded in the binary
	r.HandleFunc("/public/*", func(w http.ResponseWriter, r *http.Request) {
		http.StripPrefix("/public/", http.FileServer(http.FS(frontendFS))).ServeHTTP(w, r)
	})

	// Special route for SSE streaming events to connected clients
	r.HandleFunc("/updates", s.handleSSE)

	// REST API routes
	r.Get("/api/namespaces", s.handleNamespaceList)
	r.Get("/api/fetch/{namespace}", s.handleFetchData)
	r.Get("/api/logs/{namespace}/{podname}", s.handlePodLogs)
	r.Get("/api/resource-types", s.handleResourceTypes)
	r.Get("/api/operator-config", s.handleOperatorConfig)
	r.Get("/api/operator-view", s.handleOperatorView)
	r.Post("/api/graphql", s.handleGraphQLProxy)
}

// Establish the SSE connection for streaming updates each client
func (s *KubeviewAPI) handleSSE(w http.ResponseWriter, r *http.Request) {
	clientID := r.URL.Query().Get("clientID")
	if clientID == "" {
		http.Error(w, "clientID is required", http.StatusBadRequest)
		return
	}

	err := s.eventBroker.Stream(clientID, w, *r)
	if err != nil {
		log.Fatalln("💥 Error in SSE broker stream:", err)
		return
	}
}

// Get the list of namespaces from the Kubernetes cluster
// This the first endpoint that the frontend will call to get the list of namespaces
// It also returns the cluster host, version, and build info
func (s *KubeviewAPI) handleNamespaceList(w http.ResponseWriter, r *http.Request) {
	log.Println("🔍 Fetching list of namespaces")

	var namespaces []string

	var err error

	if s.config.SingleNamespace != "" {
		// If SingleNamespace is set, we only return that namespace
		namespaces = []string{s.config.SingleNamespace}
	} else {
		namespaces, err = s.kubeService.GetNamespaces()
		if err != nil {
			problem.Wrap(500, r.RequestURI, "namespaces", err).Send(w)
			return
		}

		// Remove namespaces that are in the filter, filter is a regex
		if s.config.NameSpaceFilter != "" {
			filteredNamespaces := make([]string, 0, len(namespaces))

			for _, ns := range namespaces {
				if matched, err := regexp.MatchString(s.config.NameSpaceFilter, ns); !matched && err == nil {
					filteredNamespaces = append(filteredNamespaces, ns)
				}
			}

			if len(filteredNamespaces) == 0 {
				problem.Wrap(500, r.RequestURI, "no namespaces found",
					errors.New("no namespaces match the filter")).Send(w)
				return
			}

			namespaces = filteredNamespaces
		}
	}

	res := NamespaceListResult{
		ClusterHost: s.kubeService.ClusterHost,
		Namespaces:  namespaces,
		Version:     s.Version,
		BuildInfo:   s.BuildInfo,
		Mode:        s.kubeService.Mode,
	}

	s.ReturnJSON(w, res)
}

// Return the resources for a specific namespace
func (s *KubeviewAPI) handleFetchData(w http.ResponseWriter, r *http.Request) {
	ns := chi.URLParam(r, "namespace")

	clientID := r.URL.Query().Get("clientID")

	if clientID == "" {
		http.Error(w, "clientID is required", http.StatusBadRequest)
		return
	}

	log.Println("🍵 Fetching resources in", ns)

	// Check single namespace mode
	if s.config.SingleNamespace != "" && ns != s.config.SingleNamespace {
		problem.Wrap(403, r.RequestURI, "single namespace mode",
			errors.New("only namespace permitted is:"+s.config.SingleNamespace)).Send(w)

		return
	}

	// Critical: Puts the client in the correct SSE group for this namespace
	// Events are sent to this group, so the client will receive updates ONLY for this namespace
	s.eventBroker.RemoveFromAllGroups(clientID)
	s.eventBroker.AddToGroup(clientID, ns)

	exists := s.kubeService.CheckNamespaceExists(ns)
	if !exists {
		problem.Wrap(404, r.RequestURI, "namespace not found", errors.New("namespace does not exist")).Send(w)
		return
	}

	data, err := s.kubeService.FetchNamespace(ns)
	if err != nil {
		problem.Wrap(500, r.RequestURI, "fetch data", err).Send(w)
		return
	}

	s.ReturnJSON(w, data)
}

// Return discovered resource types so the frontend can build dynamic filter lists
func (s *KubeviewAPI) handleResourceTypes(w http.ResponseWriter, _ *http.Request) {
	s.ReturnJSON(w, s.kubeService.GetResourceTypes())
}

// Return the loaded operator config (or null if none)
func (s *KubeviewAPI) handleOperatorConfig(w http.ResponseWriter, _ *http.Request) {
	if s.operatorConfig == nil {
		s.ReturnJSON(w, nil)
		return
	}

	s.ReturnJSON(w, s.operatorConfig)
}

// Fetch the operator-centric cross-namespace view driven by the operator config
func (s *KubeviewAPI) handleOperatorView(w http.ResponseWriter, r *http.Request) {
	if s.operatorConfig == nil {
		problem.Wrap(404, r.RequestURI, "no operator config",
			errors.New("no operator config loaded, set OPERATOR_CONFIG env var")).Send(w)
		return
	}

	clientID := r.URL.Query().Get("clientID")
	if clientID == "" {
		http.Error(w, "clientID is required", http.StatusBadRequest)
		return
	}

	log.Println("🔭 Fetching operator view")

	// Register SSE client in all watchNamespaces so it gets live updates
	s.eventBroker.RemoveFromAllGroups(clientID)

	for _, op := range s.operatorConfig.Operators {
		for _, ns := range op.WatchNamespaces {
			s.eventBroker.AddToGroup(clientID, ns)
		}

		if len(op.WatchNamespaces) == 0 {
			s.eventBroker.AddToGroup(clientID, op.Namespace)
		}
	}

	viewCfg := services.OperatorViewConfig{}

	for _, op := range s.operatorConfig.Operators {
		entry := services.OperatorViewEntry{
			CSVPrefix:       op.CSV,
			Namespace:       op.Namespace,
			WatchNamespaces: op.WatchNamespaces,
		}

		for _, ep := range op.Entrypoints {
			entry.Entrypoints = append(entry.Entrypoints, services.OperatorViewEntrypoint{
				Kind: ep.Kind,
				Name: ep.Name,
			})
		}

		viewCfg.Operators = append(viewCfg.Operators, entry)
	}

	for _, el := range s.operatorConfig.ExtraLinks {
		link := services.OperatorViewExtraLink{
			From: services.OperatorViewLinkRef{
				Kind:       el.From.Kind,
				Name:       el.From.Name,
				NamePrefix: el.From.NamePrefix,
			},
		}

		for _, to := range el.To {
			link.To = append(link.To, services.OperatorViewLinkRef{
				Kind:       to.Kind,
				Name:       to.Name,
				NamePrefix: to.NamePrefix,
			})
		}

		viewCfg.ExtraLinks = append(viewCfg.ExtraLinks, link)
	}

	result, err := s.kubeService.FetchOperatorViewCached(viewCfg)
	if err != nil {
		problem.Wrap(500, r.RequestURI, "operator view fetch", err).Send(w)
		return
	}

	s.ReturnJSON(w, result)
}

// Proxy GraphQL requests to the ocp-resource-monitor API
func (s *KubeviewAPI) handleGraphQLProxy(w http.ResponseWriter, r *http.Request) {
	if s.config.GraphQLEndpoint == "" {
		problem.Wrap(503, r.RequestURI, "graphql not configured",
			errors.New("GRAPHQL_ENDPOINT env var not set")).Send(w)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		problem.Wrap(400, r.RequestURI, "read body", err).Send(w)
		return
	}

	proxyReq, err := http.NewRequestWithContext(r.Context(), "POST", s.config.GraphQLEndpoint, bytes.NewReader(body))
	if err != nil {
		problem.Wrap(500, r.RequestURI, "create proxy request", err).Send(w)
		return
	}

	proxyReq.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(proxyReq)
	if err != nil {
		problem.Wrap(502, r.RequestURI, "graphql proxy", err).Send(w)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// Pull logs for a specific pod in a namespace
func (s *KubeviewAPI) handlePodLogs(w http.ResponseWriter, r *http.Request) {
	if !s.config.EnablePodLogs {
		s.ReturnText(w, "Viewing logs has been disabled by the administrator")
		return
	}

	ns := chi.URLParam(r, "namespace")
	podName := chi.URLParam(r, "podname")

	count := r.URL.Query().Get("max")
	if count == "" {
		count = "100" // Default to 100 lines if not specified
	}

	logCount, err := strconv.Atoi(count)
	if err != nil {
		problem.Wrap(400, r.RequestURI, "invalid log count", err).Send(w)
		return
	}

	logs, err := s.kubeService.GetPodLogs(ns, podName, logCount)
	if err != nil {
		// Note: We don't send a problem response here, as we want to return something even if there's an error
		// This is more graceful as the pod might not be in a state to fetch logs
		logs = "Error fetching logs: " + err.Error()
	}

	s.ReturnText(w, logs)
}
