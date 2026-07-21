package main

import (
	"encoding/json"
	"log"
	"os"
)

type OperatorConfig struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Operators   []OperatorEntry  `json:"operators"`
	ExtraLinks  []ExtraLinkRule  `json:"extraLinks"`
}

type OperatorEntry struct {
	CSV             string           `json:"csv"`
	Namespace       string           `json:"namespace"`
	Entrypoints     []Entrypoint     `json:"entrypoints"`
	WatchNamespaces []string         `json:"watchNamespaces"`
}

type Entrypoint struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type ExtraLinkRule struct {
	Comment string          `json:"comment"`
	From    ExtraLinkRef    `json:"from"`
	To      []ExtraLinkRef  `json:"to"`
}

type ExtraLinkRef struct {
	Kind       string `json:"kind"`
	Name       string `json:"name,omitempty"`
	NamePrefix string `json:"namePrefix,omitempty"`
}

func loadOperatorConfig(path string) *OperatorConfig {
	if path == "" {
		return nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("⚠️ Could not read operator config %s: %v", path, err)
		return nil
	}

	var cfg OperatorConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		log.Printf("⚠️ Could not parse operator config %s: %v", path, err)
		return nil
	}

	log.Printf("📋 Loaded operator config: %s (%d operators, %d extra link rules)",
		cfg.Name, len(cfg.Operators), len(cfg.ExtraLinks))

	return &cfg
}
