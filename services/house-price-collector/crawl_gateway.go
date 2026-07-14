package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// errGatewayNeedsRewarm signals the agent's warm Chrome lost its anti-bot
// clearance; callers map it to the existing exit-code-3 rewarm alert.
var errGatewayNeedsRewarm = errors.New("gateway: warm chrome needs rewarm")

// gatewayFetcher implements htmlFetcher by POSTing each URL to a brandbrain
// macOS-agent residential fetch gateway. It owns no browser.
type gatewayFetcher struct {
	baseURL string
	token   string
	waitMS  int
	client  *http.Client
}

func newGatewayFetcher(cfg crawlConfig) (*gatewayFetcher, error) {
	if cfg.gatewayURL == "" {
		return nil, fmt.Errorf("gateway fetcher requires CRAWL_GATEWAY_URL")
	}
	to := cfg.fetchTimeout
	if to <= 0 {
		to = 60 * time.Second
	}
	return &gatewayFetcher{
		baseURL: strings.TrimRight(cfg.gatewayURL, "/"),
		token:   cfg.gatewayToken,
		waitMS:  cfg.gatewayWaitMS,
		client:  &http.Client{Timeout: to + 20*time.Second},
	}, nil
}

type gatewayFetchReq struct {
	URL    string `json:"url"`
	WaitMS int    `json:"wait_ms,omitempty"`
}

type gatewayFetchResp struct {
	HTML       string `json:"html"`
	FinalURL   string `json:"final_url"`
	HTTPStatus int    `json:"http_status"`
	Blocked    bool   `json:"blocked"`
	Error      *struct {
		Kind    string `json:"kind"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (g *gatewayFetcher) fetch(ctx context.Context, url string) ([]byte, string, error) {
	body, _ := json.Marshal(gatewayFetchReq{URL: url, WaitMS: g.waitMS})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.baseURL+"/gateway/v1/fetch", bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if g.token != "" {
		req.Header.Set("Authorization", "Bearer "+g.token)
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("gateway fetch %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	var gr gatewayFetchResp
	if err := json.Unmarshal(raw, &gr); err != nil {
		return nil, "", fmt.Errorf("gateway decode (http %d): %w", resp.StatusCode, err)
	}
	if gr.Error != nil {
		if gr.Error.Kind == "needs_rewarm" {
			return nil, "", errGatewayNeedsRewarm
		}
		return []byte(gr.HTML), gr.FinalURL, fmt.Errorf("gateway error [%s]: %s", gr.Error.Kind, gr.Error.Message)
	}
	return []byte(gr.HTML), gr.FinalURL, nil
}

func (g *gatewayFetcher) Close() {}
