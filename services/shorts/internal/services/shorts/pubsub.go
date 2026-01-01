package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"cloud.google.com/go/pubsub"
)

// PubSubClient interface for publishing enrichment jobs
type PubSubClient interface {
	PublishEnrichmentJob(ctx context.Context, jobID, stockCode string, force bool) error
}

// pubSubClient implements PubSubClient using GCP Pub/Sub
type pubSubClient struct {
	topic *pubsub.Topic
}

// NewPubSubClient creates a new Pub/Sub client for enrichment jobs
func NewPubSubClient(ctx context.Context, projectID, topicName string) (PubSubClient, error) {
	if projectID == "" {
		return nil, fmt.Errorf("GCP_PROJECT_ID is required for Pub/Sub")
	}

	// Check if credentials are available
	credsPath := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")
	if credsPath != "" {
		if _, err := os.Stat(credsPath); os.IsNotExist(err) {
			return nil, fmt.Errorf("GOOGLE_APPLICATION_CREDENTIALS file not found: %s", credsPath)
		}
	}

	client, err := pubsub.NewClient(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to create Pub/Sub client: %w", err)
	}

	topic := client.Topic(topicName)
	
	// Try to check if topic exists, but don't fail if we don't have permissions
	exists, err := topic.Exists(ctx)
	if err != nil {
		// If we can't check existence (e.g., permission denied), assume topic exists and use it
		// This allows the service to work if the topic already exists but we don't have admin permissions
		// The actual publish will fail later if the topic doesn't exist, which is acceptable
		return &pubSubClient{topic: topic}, nil
	}

	if !exists {
		// Try to create the topic, but don't fail if we don't have permissions
		_, err = client.CreateTopic(ctx, topicName)
		if err != nil {
			// If we can't create the topic (e.g., permission denied), assume it exists and use it
			// This allows the service to work if the topic already exists but we don't have create permissions
			// The actual publish will fail later if the topic doesn't exist, which is acceptable
			return &pubSubClient{topic: topic}, nil
		}
	}

	return &pubSubClient{topic: topic}, nil
}

// enrichmentJobMessage represents the message published to Pub/Sub
type enrichmentJobMessage struct {
	JobID     string `json:"job_id"`
	StockCode string `json:"stock_code"`
	Force     bool   `json:"force"`
}

// PublishEnrichmentJob publishes an enrichment job to Pub/Sub
func (c *pubSubClient) PublishEnrichmentJob(ctx context.Context, jobID, stockCode string, force bool) error {
	msg := enrichmentJobMessage{
		JobID:     jobID,
		StockCode: stockCode,
		Force:     force,
	}

	msgBytes, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}

	result := c.topic.Publish(ctx, &pubsub.Message{
		Data: msgBytes,
	})

	_, err = result.Get(ctx)
	if err != nil {
		return fmt.Errorf("failed to publish message: %w", err)
	}

	return nil
}

// noOpPubSubClient is a no-op implementation for when Pub/Sub is not configured
type noOpPubSubClient struct{}

func (c *noOpPubSubClient) PublishEnrichmentJob(ctx context.Context, jobID, stockCode string, force bool) error {
	return fmt.Errorf("Pub/Sub is not configured (GCP_PROJECT_ID not set)")
}

// NewPubSubClientFromEnv creates a Pub/Sub client from environment variables
func NewPubSubClientFromEnv(ctx context.Context) (PubSubClient, error) {
	projectID := os.Getenv("GCP_PROJECT_ID")
	topicName := os.Getenv("ENRICHMENT_PUBSUB_TOPIC")
	if topicName == "" {
		topicName = "enrichment-jobs"
	}

	if projectID == "" {
		return &noOpPubSubClient{}, nil
	}

	return NewPubSubClient(ctx, projectID, topicName)
}

