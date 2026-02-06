package ratelimit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// UpstashClient provides access to Upstash Redis via REST API
type UpstashClient struct {
	url        string
	token      string
	httpClient *http.Client
}

// NewUpstashClient creates a new Upstash REST API client
func NewUpstashClient(url, token string, timeout time.Duration) *UpstashClient {
	return &UpstashClient{
		url:   url,
		token: token,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// PipelineResult represents the result of a single command in a pipeline
type PipelineResult struct {
	Result interface{} `json:"result"`
	Error  string      `json:"error,omitempty"`
}

// Pipeline executes multiple Redis commands atomically
func (c *UpstashClient) Pipeline(ctx context.Context, commands [][]interface{}) ([]PipelineResult, error) {
	body, err := json.Marshal(commands)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal commands: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/pipeline", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstash error (status %d): %s", resp.StatusCode, string(respBody))
	}

	var results []PipelineResult
	if err := json.Unmarshal(respBody, &results); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	return results, nil
}

// Exec executes a single Redis command
func (c *UpstashClient) Exec(ctx context.Context, command []interface{}) (interface{}, error) {
	body, err := json.Marshal(command)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal command: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstash error (status %d): %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Result interface{} `json:"result"`
		Error  string      `json:"error,omitempty"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if result.Error != "" {
		return nil, fmt.Errorf("redis error: %s", result.Error)
	}

	return result.Result, nil
}

// Ping tests the connection to Upstash
func (c *UpstashClient) Ping(ctx context.Context) error {
	result, err := c.Exec(ctx, []interface{}{"PING"})
	if err != nil {
		return err
	}
	if result != "PONG" {
		return fmt.Errorf("unexpected ping response: %v", result)
	}
	return nil
}
