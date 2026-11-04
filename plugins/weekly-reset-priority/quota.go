package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

const quotaURL = "https://chatgpt.com/backend-api/wham/usage"

func fetchQuota(ctx context.Context, call hostCall, id string, now time.Time) quota {
	if call == nil || ctx.Err() != nil {
		return quota{}
	}
	var list struct {
		Files []pluginapi.HostAuthFileEntry `json:"files"`
	}
	if call(pluginabi.MethodHostAuthList, struct{}{}, &list) != nil {
		return quota{}
	}
	for _, auth := range list.Files {
		if auth.ID != id || auth.Provider != "codex" || auth.Disabled || auth.Unavailable || auth.RuntimeOnly || auth.AuthIndex == "" {
			continue
		}
		var credential pluginapi.HostAuthGetResponse
		if call(pluginabi.MethodHostAuthGet, pluginapi.HostAuthGetRequest{AuthIndex: auth.AuthIndex}, &credential) != nil {
			return quota{}
		}
		var secret struct {
			AccessToken string `json:"access_token"`
			AccountID   string `json:"account_id"`
		}
		if json.Unmarshal(credential.JSON, &secret) != nil || secret.AccessToken == "" {
			return quota{}
		}
		headers := http.Header{"Authorization": {"Bearer " + secret.AccessToken}, "Accept": {"application/json"}, "User-Agent": {"weekly-reset-priority/0.1.0"}}
		if secret.AccountID != "" {
			headers.Set("Chatgpt-Account-Id", secret.AccountID)
		}
		body, err := quotaHTTP(ctx, call, headers)
		if err != nil {
			return quota{}
		}
		return parseQuota(body, now)
	}
	return quota{}
}

func quotaHTTP(ctx context.Context, call hostCall, headers http.Header) ([]byte, error) {
	var operation struct {
		ID string `json:"operation_id"`
	}
	if err := call(pluginabi.MethodHostHTTPOperationOpen, struct{}{}, &operation); err != nil {
		return nil, err
	}
	if operation.ID == "" {
		return nil, errors.New("missing HTTP operation")
	}
	finished := make(chan struct{})
	joined := make(chan struct{})
	go func() {
		defer close(joined)
		select {
		case <-ctx.Done():
			_ = call(pluginabi.MethodHostHTTPCancel, map[string]string{"operation_id": operation.ID}, nil)
		case <-finished:
		}
	}()
	defer func() { close(finished); <-joined }()
	var response pluginapi.HTTPResponse
	err := call(pluginabi.MethodHostHTTPDo, map[string]any{"operation_id": operation.ID, "method": "GET", "url": quotaURL, "headers": headers}, &response)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil || response.StatusCode != 200 || len(response.Body) > 1<<20 {
		return nil, errors.New("quota unavailable")
	}
	return response.Body, nil
}
