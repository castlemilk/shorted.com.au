package broadcast

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const resendBatchEndpoint = "https://api.resend.com/emails/batch"
const maxBatch = 100

type Recipient struct {
	ID    string
	Email string
}

type Config struct {
	APIKey            string
	From              string
	ReplyTo           string
	UnsubscribeSecret string
	BaseURL           string
}

type resendEmail struct {
	From    string            `json:"from"`
	To      []string          `json:"to"`
	ReplyTo string            `json:"reply_to,omitempty"`
	Subject string            `json:"subject"`
	HTML    string            `json:"html"`
	Text    string            `json:"text"`
	Headers map[string]string `json:"headers,omitempty"`
}

// SignFunc is injected (register.SignUnsubscribeToken) so this package needn't import register.
type SignFunc func(id, secret string) string

// Send delivers the broadcast to all recipients in batches of <=100.
// Returns the number of recipients attempted. Non-nil error => mark failed.
func Send(ctx context.Context, cfg Config, subject, title, bodyHTML, bodyText string, recipients []Recipient, sign SignFunc) (int, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	sizes := chunk(len(recipients), maxBatch)
	idx := 0
	for _, n := range sizes {
		batch := make([]resendEmail, 0, n)
		for i := 0; i < n; i++ {
			r := recipients[idx]
			idx++
			tok := sign(r.ID, cfg.UnsubscribeSecret)
			unsubURL := fmt.Sprintf("%s/unsubscribe?t=%s", cfg.BaseURL, tok)
			oneClick := fmt.Sprintf("%s/api/unsubscribe?t=%s", cfg.BaseURL, tok)
			batch = append(batch, resendEmail{
				From:    cfg.From,
				To:      []string{r.Email},
				ReplyTo: cfg.ReplyTo,
				Subject: subject,
				HTML:    RenderHTML(title, bodyHTML, unsubURL),
				Text:    RenderText(title, bodyText, unsubURL),
				Headers: map[string]string{
					"List-Unsubscribe":      fmt.Sprintf("<%s>", oneClick),
					"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
				},
			})
		}
		if err := postBatch(ctx, client, cfg.APIKey, batch); err != nil {
			return idx, err
		}
	}
	return idx, nil
}

func postBatch(ctx context.Context, client *http.Client, apiKey string, batch []resendEmail) error {
	body, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, resendBatchEndpoint, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode == 429 && attempt == 0 {
			time.Sleep(time.Second)
			continue
		}
		if resp.StatusCode >= 300 {
			return fmt.Errorf("resend batch status %d", resp.StatusCode)
		}
		return nil
	}
	return fmt.Errorf("resend batch rate-limited")
}

func chunk(total, size int) []int {
	var out []int
	for total > 0 {
		n := size
		if total < size {
			n = total
		}
		out = append(out, n)
		total -= n
	}
	return out
}
