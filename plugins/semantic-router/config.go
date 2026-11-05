package main

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

type target struct {
	Provider    string `yaml:"provider" json:"provider"`
	Model       string `yaml:"model" json:"model"`
	Description string `yaml:"description,omitempty" json:"description,omitempty"`
}

type configuration struct {
	Enabled    bool     `yaml:"enabled"`
	Priority   int      `yaml:"priority"`
	Alias      string   `yaml:"alias"`
	Classifier target   `yaml:"classifier"`
	Fallback   target   `yaml:"fallback"`
	Candidates []target `yaml:"candidates"`
	TimeoutMS  int      `yaml:"timeout_ms"`
}

func parseConfiguration(data []byte) (configuration, error) {
	config := configuration{Alias: "semantic-auto", TimeoutMS: 3000}
	if err := yaml.Unmarshal(data, &config); err != nil {
		return config, err
	}
	if config.Alias == "" || strings.TrimSpace(config.Alias) != config.Alias || len(config.Alias) > 128 {
		return config, fmt.Errorf("alias must be a nonempty model identifier (max 128 characters)")
	}
	if strings.EqualFold(config.Alias, "auto") {
		return config, fmt.Errorf("alias auto is reserved by the kernel; use semantic-auto or another unique alias")
	}
	if config.TimeoutMS < 50 || config.TimeoutMS > 30000 {
		return config, fmt.Errorf("timeout_ms must be 50..30000")
	}
	if len(config.Candidates) > 32 {
		return config, fmt.Errorf("at most 32 candidates are allowed")
	}
	seen := map[string]bool{}
	for _, candidate := range config.Candidates {
		key := candidate.Provider + "/" + candidate.Model
		if seen[key] || strings.TrimSpace(candidate.Description) == "" || len(candidate.Description) > 2048 {
			return config, fmt.Errorf("candidates require unique provider/model pairs and descriptions (1..2048 characters)")
		}
		seen[key] = true
	}
	for _, item := range append(append([]target{}, config.Candidates...), config.Classifier, config.Fallback) {
		if !config.Enabled && item.Provider == "" && item.Model == "" {
			continue
		}
		if strings.TrimSpace(item.Provider) == "" || strings.TrimSpace(item.Model) == "" || item.Model == config.Alias || strings.TrimSpace(item.Model) != item.Model {
			return config, fmt.Errorf("targets require provider and model; target model must not equal alias")
		}
	}
	if config.Enabled && len(config.Candidates) == 0 {
		return config, fmt.Errorf("enabled routing requires candidates, classifier and fallback")
	}
	return config, nil
}
