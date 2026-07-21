// ==========================================================================================
// Server configuration via environment variables
// ==========================================================================================

package main

import (
	"os"
	"strconv"
	"strings"
)

// Config holds the configuration for the system
type Config struct {
	Port               int
	NameSpaceFilter    string
	SingleNamespace    string
	Debug              bool
	EnablePodLogs      bool
	CRDIncludeGroups   []string
	CRDExcludeGroups   []string
	OperatorConfigPath string
	GraphQLEndpoint    string
}

// Parse the environment variables and return a Config struct
// Also provides default values if the environment variables are not set
func getConfig() Config {
	port := 8000
	nameSpaceFilter := ""
	singleNamespace := ""
	debug := false
	enablePodLogs := true
	var crdIncludeGroups []string
	var crdExcludeGroups []string

	if portEnv := os.Getenv("PORT"); portEnv != "" {
		if p, err := strconv.Atoi(portEnv); err == nil {
			port = p
		}
	}

	if s := os.Getenv("SINGLE_NAMESPACE"); s != "" {
		singleNamespace = s
	}

	if s := os.Getenv("NAMESPACE_FILTER"); s != "" {
		nameSpaceFilter = s
	}

	if s := os.Getenv("DISABLE_POD_LOGS"); s != "" {
		if enable, err := strconv.ParseBool(s); err == nil {
			enablePodLogs = !enable
		}
	}

	if debugEnv := os.Getenv("DEBUG"); debugEnv != "" {
		debug, _ = strconv.ParseBool(debugEnv)
	}

	if s := os.Getenv("CRD_GROUPS"); s != "" {
		crdIncludeGroups = splitAndTrim(s)
	}

	if s := os.Getenv("CRD_EXCLUDE_GROUPS"); s != "" {
		crdExcludeGroups = splitAndTrim(s)
	}

	operatorConfigPath := os.Getenv("OPERATOR_CONFIG")
	graphqlEndpoint := os.Getenv("GRAPHQL_ENDPOINT")

	return Config{
		Port:               port,
		NameSpaceFilter:    nameSpaceFilter,
		SingleNamespace:    singleNamespace,
		Debug:              debug,
		EnablePodLogs:      enablePodLogs,
		CRDIncludeGroups:   crdIncludeGroups,
		CRDExcludeGroups:   crdExcludeGroups,
		OperatorConfigPath: operatorConfigPath,
		GraphQLEndpoint:    graphqlEndpoint,
	}
}

func splitAndTrim(s string) []string {
	parts := strings.Split(s, ",")
	result := make([]string, 0, len(parts))

	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}

	return result
}
