package main

import "github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"

func registration() any {
	return struct {
		SchemaVersion uint32             `json:"schema_version"`
		Metadata      pluginapi.Metadata `json:"metadata"`
		Capabilities  map[string]bool    `json:"capabilities"`
	}{6, pluginapi.Metadata{Name: "semantic-router", Version: "0.1.0", Author: "EasyCLIProxyAPI", GitHubRepository: "https://github.com/router-for-me/EasyCLIProxyAPI", ConfigFields: []pluginapi.ConfigField{
		{Name: "alias", Type: "string", Default: "semantic-auto", Description: "自动路由别名（勿用内核保留名 auto）/ Exact alias, not reserved name auto"},
		{Name: "classifier", Type: "object", Description: `分类模型 / Existing classifier: {"provider":"openai","model":"your-classifier"}`},
		{Name: "fallback", Type: "object", Description: `安全回退 / Existing fallback: {"provider":"openai","model":"your-default"}`},
		{Name: "candidates", Type: "array", Description: `候选模型及语义描述 / Existing candidates: [{"provider":"openai","model":"your-model","description":"编程任务"}]`},
		{Name: "timeout_ms", Type: "integer", Default: 3000, Description: "分类等待上限，50–30000 毫秒 / Classifier wait timeout (ms)"},
	}}, map[string]bool{"model_router": true}}
}
