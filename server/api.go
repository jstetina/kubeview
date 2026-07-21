// ==========================================================================================
// The backend API for KubeView, handling requests and serving data
// ==========================================================================================

package main

import (
	"log"

	"github.com/benc-uk/go-rest-api/pkg/api"
	"github.com/benc-uk/kubeview/server/services"
)

// This is the core struct for the server & API
type KubeviewAPI struct {
	*api.Base
	kubeService    *services.Kubernetes
	eventBroker    KubeEventBroker
	config         Config
	operatorConfig *OperatorConfig
}

type NamespaceListResult struct {
	Namespaces []string `json:"namespaces"`
	// We munge a couple of extra fields into the API response
	// This saves us from having to make a separate request for the version and build info
	ClusterHost    string `json:"clusterHost"`
	Version        string `json:"version"`
	BuildInfo      string `json:"buildInfo"`
	Mode           string `json:"mode"`
	PodLogsEnabled bool   `json:"podLogsEnabled"`
}

func NewKubeviewAPI(conf Config) *KubeviewAPI {
	broker := newKubeEventBroker(conf)

	crdConf := services.CRDConfig{
		IncludeGroups: conf.CRDIncludeGroups,
		ExcludeGroups: conf.CRDExcludeGroups,
	}

	kubeSvc, err := services.NewKubernetes(broker.Broker, conf.SingleNamespace, crdConf)
	if err != nil {
		log.Fatalf("💥 Error connecting to Kubernetes, system will exit")
	}

	opConfig := loadOperatorConfig(conf.OperatorConfigPath)

	return &KubeviewAPI{
		Base:           api.NewBase("kubeview", version, buildInfo, true),
		kubeService:    kubeSvc,
		eventBroker:    broker,
		config:         conf,
		operatorConfig: opConfig,
	}
}
